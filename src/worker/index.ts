import { Hono } from "hono";
import { addRedirect, applyMailFix, Conflict, deleteRedirect, disableParking, enableParking, setDmarc, setMx, setSpf, updateRedirect, type Done, type FixOptions } from "./actions";
import type { MxPreset } from "./lib/senders";
import { finishLogin, isDev, logout, MCP_RETURN, OAUTH_SCOPES, publicUrl, redirectUri, session, startLogin, type Ctx, type Env, type Vars } from "./auth";
import { admins, getConfig, isAdmin, setConfig } from "./config";
import { CfApi, CfError, type Account, type Zone } from "./lib/cf";
import { ensureSchema, now } from "./lib/db";
import { dohResolver } from "./lib/doh";
import type { FixId } from "./lib/mail";
import { PARK_WORKER, type RedirectInput } from "./lib/zone-state";
import { handleRpc, ToolError, type McpCtx } from "./mcp";
import { bearer, bearerSession, completeGrant, mcpAuth, resourceMetadataUrl } from "./mcp-auth";
import { cleanParkSettings, settingsFromVersion, type ParkSettings } from "./park/publish";
import { ensureParkingPublished, loadParkSettings, saveAndPublish } from "./park/settings";
import { parkStatus, pool, syncAll, syncZone } from "./services";
import { disableTenant, enableTenant, isTenant, loadTenants, setSyncToken, tenantTokens, tokenLink, visibleAccounts } from "./tenants";

const app = new Hono<{ Bindings: Env; Variables: Vars }>();

app.use("*", async (c, next) => {
  await ensureSchema(c.env.DB);
  await next();
});

/** Who is signed in, and their token (in local development, the development token). */
async function whoami(c: Ctx) {
  // An MCP client: only its token counts, never the cookie.
  if (bearer(c)) return bearerSession(c);
  if (isDev(c)) return { email: (c.env.DEV_EMAIL ?? "dev@localhost").toLowerCase(), token: c.env.DEV_TOKEN! };
  return session(c);
}

// --- Sign in ---

app.get("/auth/login", (c) => startLogin(c));

app.get("/auth/callback", async (c) => {
  const fail = (code: string, params?: Record<string, string>) => c.redirect(`/?login_error=${encodeURIComponent(code)}${params ? `&login_params=${encodeURIComponent(JSON.stringify(params))}` : ""}`);
  try {
    const res = await finishLogin(c);
    if (!res.ok) return fail(res.code, res.params);
    if (res.returnTo.startsWith(MCP_RETURN)) {
      const to = await completeGrant(c, res.returnTo.slice(MCP_RETURN.length), res.email, res.tokens);
      return c.redirect(to ?? "/connect?error=expired");
    }
    return c.redirect(res.returnTo);
  } catch (e) {
    return fail("login-failed", { message: e instanceof Error ? e.message : "" });
  }
});

app.post("/auth/logout", async (c) => {
  await logout(c);
  return c.json({ redirect: "/" });
});

// --- Setup (superadmins only) ---
// Before the OAuth client exists nobody can sign in, so a new install is completed from local
// development or with the values given at deploy time.

const setup = new Hono<{ Bindings: Env; Variables: Vars }>();

const adminOf = async (c: Ctx, email: string) => isDev(c) || (await isAdmin(c.env, email));
const configured = (cfg: Awaited<ReturnType<typeof getConfig>>) => !!(cfg.oauthClientId && cfg.oauthClientSecret);

/** Before anyone can sign in, the code given at install time opens the setup page. */
async function setupCode(c: Ctx) {
  const code = c.req.header("x-setup-code");
  if (!c.env.SETUP_CODE || !code || configured(await getConfig(c.env))) return false;
  const [a, b] = await Promise.all([code, c.env.SETUP_CODE].map((v) => crypto.subtle.digest("SHA-256", new TextEncoder().encode(v))));
  const x = new Uint8Array(a), y = new Uint8Array(b);
  return x.reduce((d, v, i) => d | (v ^ y[i]), 0) === 0;
}

/** Whether Dash++ is ready to sign in, and whether this person can set it up. No secrets. */
setup.get("/state", async (c) => {
  const cfg = await getConfig(c.env);
  const who = await whoami(c);
  return c.json({ configured: configured(cfg), admin: !!who && (await adminOf(c, who.email)), code: !configured(cfg) && !!c.env.SETUP_CODE });
});

setup.use("*", async (c, next) => {
  if (c.req.method !== "GET" && c.req.header("x-dash-plus-plus") !== "1") return c.json({ error: "bad-request" }, 400);
  const who = await whoami(c);
  if (who && (await adminOf(c, who.email))) c.set("email", who.email);
  else if (await setupCode(c)) c.set("email", "setup-code");
  else return who ? c.json({ error: "not-admin" }, 403) : c.json({ error: "login" }, 401);
  await next();
});

setup.get("/", async (c) => {
  const cfg = await getConfig(c.env);
  const lastSync = await c.env.DB.prepare("SELECT started_at, finished_at, zones, changes, error FROM sync_runs ORDER BY id DESC LIMIT 1").first();
  return c.json({
    publicUrl: publicUrl(c),
    accountId: c.env.ACCOUNT_ID ?? null,
    redirectUri: redirectUri(c),
    scopes: OAUTH_SCOPES.filter((s) => s !== "offline_access"),
    admins: await admins(c.env),
    oauth: { configured: !!(cfg.oauthClientId && cfg.oauthClientSecret), clientId: cfg.oauthClientId || null, source: cfg.source.oauthClientSecret },
    service: { configured: !!cfg.serviceToken, source: cfg.source.serviceToken, lastSync },
  });
});

setup.put("/oauth", async (c) => {
  const body = await c.req.json<{ clientId?: string; clientSecret?: string }>();
  const clientId = String(body.clientId ?? "").trim();
  const clientSecret = String(body.clientSecret ?? "").trim();
  if (!clientId || !clientSecret) return c.json({ error: "setup-oauth-missing" }, 409);
  await setConfig(c.env, { oauthClientId: clientId, oauthClientSecret: clientSecret }, c.get("email"));
  return c.json({ ok: true });
});

/** Creates the OAuth client with a temporary token that has "OAuth Client Write", so nobody fills the form by hand. */
setup.post("/oauth/create", async (c) => {
  const token = String((await c.req.json<{ token?: string }>()).token ?? "").trim();
  if (!token) return c.json({ error: "setup-token-missing" }, 409);
  // The account the Worker runs in; failing that, the only one the token can see.
  const accounts = c.env.ACCOUNT_ID ? [] : await new CfApi(token).all<Account>("/accounts", 50).catch(() => []);
  const accountId = c.env.ACCOUNT_ID ?? (accounts.length === 1 ? accounts[0].id : null);
  if (!accountId) return c.json({ error: "setup-oauth-token-invalid", params: { message: "" } }, 409);
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/oauth_clients`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Dash++",
      client_uri: publicUrl(c),
      redirect_uris: [redirectUri(c)],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "client_secret_basic",
      scopes: OAUTH_SCOPES.filter((s) => s !== "offline_access"),
    }),
  });
  const json = (await res.json().catch(() => null)) as { success?: boolean; result?: Record<string, unknown>; errors?: { message: string }[] } | null;
  const id = json?.result?.client_id ?? json?.result?.id;
  const secret = json?.result?.client_secret ?? json?.result?.secret;
  if (!res.ok || !json?.success || typeof id !== "string" || typeof secret !== "string") {
    return c.json({ error: res.status === 401 || res.status === 403 ? "setup-oauth-token-invalid" : "cloudflare", params: { message: json?.errors?.map((e) => e.message).join("; ") ?? `HTTP ${res.status}` } }, 409);
  }
  await setConfig(c.env, { oauthClientId: id, oauthClientSecret: secret }, c.get("email"));
  return c.json({ ok: true, clientId: id });
});

setup.put("/service", async (c) => {
  const token = String((await c.req.json<{ token?: string }>()).token ?? "").trim();
  if (!token) return c.json({ error: "setup-token-missing" }, 409);
  const api = new CfApi(token);
  try {
    // Must be able to read zones; writing is never needed.
    await api.req("GET", "/user/tokens/verify");
    const zones = await api.all<Zone>("/zones", 50);
    await setConfig(c.env, { serviceToken: token }, c.get("email"));
    return c.json({ ok: true, zones: zones.length });
  } catch {
    return c.json({ error: "setup-token-invalid" }, 409);
  }
});

app.route("/api/setup", setup);

// --- API ---

const api = new Hono<{ Bindings: Env; Variables: Vars }>();

api.use("*", async (c, next) => {
  if (c.req.method !== "GET" && !bearer(c)) {
    // Changes only come from the app: same origin and a dedicated header. A bearer token is not
    // sent by the browser on its own, so it needs neither.
    const origin = c.req.header("origin");
    if (c.req.header("x-dash-plus-plus") !== "1" || (origin && origin !== new URL(c.req.url).origin)) return c.json({ error: "bad-request" }, 400);
  }
  const who = await whoami(c);
  if (!who) return c.json({ error: "login" }, 401);
  c.set("email", who.email);
  c.set("token", who.token);
  c.set("admin", await adminOf(c, who.email));
  await next();
});

const superadmin = (c: Ctx) => c.get("admin");

// Only enabled accounts can be used; superadmins can use all of theirs, to enable them.
async function requireTenant(c: Ctx, accountId: string) {
  if (!superadmin(c) && !(await isTenant(c.env.DB, accountId))) throw new Conflict("not-enabled");
}

api.use("/accounts/:acc/*", async (c, next) => {
  await requireTenant(c, c.req.param("acc"));
  await next();
});

api.use("/zones/:zone/*", async (c, next) => {
  const zoneId = c.req.param("zone");
  const cached = await c.env.DB.prepare("SELECT account_id FROM zones WHERE id = ?").bind(zoneId).first<{ account_id: string }>();
  await requireTenant(c, cached?.account_id ?? (await cf(c).req<Zone>("GET", `/zones/${zoneId}`)).account.id);
  await next();
});

api.onError((e, c) => {
  if (e instanceof Conflict) return c.json({ error: e.code, params: e.params }, 409);
  if (e instanceof CfError) {
    if (e.status === 401) return c.json({ error: "login" }, 401);
    if (e.forbidden) return c.json({ error: "forbidden" }, 403);
    return c.json({ error: "cloudflare", params: { message: e.message } }, 502);
  }
  console.error(e);
  return c.json({ error: "unexpected" }, 500);
});

const cf = (c: Ctx) => new CfApi(c.get("token"));

/** For what Dash++ keeps on its own (not behind the user's token): only who can see the account on Cloudflare. */
async function requireMember(c: Ctx, accountId: string) {
  await cf(c)
    .req("GET", `/accounts/${accountId}`)
    .catch((e) => {
      throw e instanceof CfError && e.notFound ? new CfError(403, e.errors) : e;
    });
}

/** Whether the user manages the account (account settings, not only some of its domains). */
async function managesAccount(c: Ctx, accountId: string) {
  const list = await cf(c).all<{ account: { id: string }; status: string; permissions?: { organization?: { edit?: boolean } } }>("/memberships", 50);
  return list.some((m) => m.account.id === accountId && m.status === "accepted" && m.permissions?.organization?.edit === true);
}

/** For what affects the whole account in Dash++: its background token, its parking pages. */
async function requireManager(c: Ctx, accountId: string) {
  if (!(await managesAccount(c, accountId))) throw new CfError(403, []);
}

api.get("/me", async (c) => {
  const [accounts, tenants] = await Promise.all([cf(c).all<Account>("/accounts", 50), loadTenants(c.env.DB)]);
  const lastSync = await c.env.DB.prepare("SELECT started_at, finished_at, zones, changes, error FROM sync_runs ORDER BY id DESC LIMIT 1").first();
  return c.json({
    email: c.get("email"),
    accounts: visibleAccounts(accounts, tenants, superadmin(c)).sort((a, b) => a.name.localeCompare(b.name)),
    // A token for every account, used where an account has none of its own.
    background: { enabled: !!(await getConfig(c.env)).serviceToken, lastSync },
    admin: superadmin(c),
  });
});

// --- Tenants ---

api.post("/accounts/:acc/tenant", async (c) => {
  if (!superadmin(c)) throw new Conflict("not-admin");
  const account = await cf(c).req<Account>("GET", `/accounts/${c.req.param("acc")}`);
  await enableTenant(c.env.DB, account, c.get("email"));
  await audit(c, account.id, null, null, "tenant.enable", []);
  return c.json({ ok: true });
});

api.delete("/accounts/:acc/tenant", async (c) => {
  if (!superadmin(c)) throw new Conflict("not-admin");
  await disableTenant(c.env.DB, c.req.param("acc"));
  await audit(c, c.req.param("acc"), null, null, "tenant.disable", []);
  return c.json({ ok: true });
});

/** The account's own token for the background sync. */
api.get("/accounts/:acc/background", async (c) => {
  const acc = c.req.param("acc");
  await requireMember(c, acc);
  const canManage = await managesAccount(c, acc);
  const row = await c.env.DB.prepare("SELECT sync_token IS NOT NULL AS configured, token_set_at, token_set_by FROM tenants WHERE account_id = ?").bind(acc).first<{ configured: number; token_set_at: number | null; token_set_by: string | null }>();
  return c.json({ enabled: !!row, configured: !!row?.configured, setAt: row?.token_set_at ?? null, setBy: row?.token_set_by ?? null, link: tokenLink(acc), canManage });
});

api.put("/accounts/:acc/background", async (c) => {
  const acc = c.req.param("acc");
  await requireManager(c, acc);
  if (!(await isTenant(c.env.DB, acc))) throw new Conflict("not-enabled");
  const token = String((await c.req.json<{ token?: string }>()).token ?? "").trim();
  if (!token) throw new Conflict("setup-token-missing");
  const api = new CfApi(token);
  let zones: Zone[];
  try {
    // An account token, or a user token that can read this account.
    await api.req("GET", `/accounts/${acc}/tokens/verify`).catch(() => api.req("GET", "/user/tokens/verify"));
    zones = await api.all<Zone>(`/zones?account.id=${encodeURIComponent(acc)}`, 50);
  } catch {
    throw new Conflict("setup-token-invalid");
  }
  await setSyncToken(c.env, acc, token, c.get("email"));
  c.executionCtx.waitUntil(syncAll(c.env.DB, [{ id: acc, token }]));
  return c.json({ ok: true, zones: zones.length });
});

api.delete("/accounts/:acc/background", async (c) => {
  await requireManager(c, c.req.param("acc"));
  await setSyncToken(c.env, c.req.param("acc"), null, c.get("email"));
  return c.json({ ok: true });
});

type CacheRow = {
  id: string;
  synced_at: number | null;
  usage: string | null;
  parking: string | null;
  redirect_target: string | null;
  redirects: number | null;
  mail_mode: string | null;
  mail_provider: string | null;
  mail_errors: number | null;
  mail_warnings: number | null;
  mail_checks: string | null;
  last_change_at: number | null;
  record_count: number | null;
};

const visibleZones = (c: Ctx, accountId: string) => cf(c).all<Zone>(`/zones?account.id=${encodeURIComponent(accountId)}`, 50);

api.get("/accounts/:acc/zones", async (c) => {
  const acc = c.req.param("acc");
  const [zones, park] = await Promise.all([visibleZones(c, acc), parkStatus(cf(c), acc)]);
  const cache = await c.env.DB.prepare("SELECT * FROM zones WHERE account_id = ?").bind(acc).all<CacheRow>();
  const byId = new Map(cache.results.map((r) => [r.id, r]));
  return c.json({
    park,
    canPark: !!park || (await parkReady(c, acc)),
    zones: zones
      .map((z) => {
        const r = byId.get(z.id);
        return {
          id: z.id,
          name: z.name,
          status: z.status,
          paused: !!z.paused,
          plan: z.plan?.name ?? null,
          cached: r
            ? {
                syncedAt: r.synced_at,
                usage: r.usage,
                parking: r.parking,
                redirectTarget: r.redirect_target,
                redirects: r.redirects,
                mail: { mode: r.mail_mode, provider: r.mail_provider, errors: r.mail_errors, warnings: r.mail_warnings, checks: JSON.parse(r.mail_checks ?? "[]") },
                lastChangeAt: r.last_change_at,
                records: r.record_count,
              }
            : null,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name)),
  });
});

api.post("/accounts/:acc/sync", async (c) => {
  const acc = c.req.param("acc");
  const only = (await c.req.json<{ missing?: boolean }>().catch(() => ({}))) as { missing?: boolean };
  let zones = await visibleZones(c, acc);
  if (only.missing) {
    const cached = await c.env.DB.prepare("SELECT id FROM zones WHERE account_id = ? AND synced_at IS NOT NULL").bind(acc).all<{ id: string }>();
    const have = new Set(cached.results.map((r) => r.id));
    zones = zones.filter((z) => !have.has(z.id));
  }
  const resolver = dohResolver();
  const res = await pool(zones, 6, (z) => syncZone(c.env.DB, cf(c), z.id, { source: "external" }, resolver));
  return c.json({ zones: zones.length, failed: res.filter((r) => r.status === "rejected").length });
});

/** Whether the account's parking page is published, read with its background token (for users who can't see Workers). */
async function parkReady(c: Ctx, accountId: string) {
  const token = (await tenantTokens(c.env)).find((t) => t.id === accountId)?.token ?? (await getConfig(c.env)).serviceToken;
  return !!token && !!(await parkStatus(new CfApi(token), accountId))?.published;
}

async function zonePayload(c: Ctx, zoneId: string) {
  const { data, mail } = await syncZone(c.env.DB, cf(c), zoneId, { source: "external" });
  const [changes, park] = await Promise.all([
    c.env.DB.prepare("SELECT * FROM changes WHERE zone_id = ? ORDER BY detected_at DESC, id DESC LIMIT 100").bind(zoneId).all(),
    parkStatus(cf(c), data.zone.account.id),
  ]);
  return {
    zone: { id: data.zone.id, name: data.zone.name, status: data.zone.status, account: data.zone.account, nameServers: data.zone.name_servers ?? [], plan: data.zone.plan?.name ?? null },
    records: data.records,
    routes: data.routes,
    routesError: data.routesError ?? data.customDomainsError ?? null,
    servedBy: data.servedBy,
    customDomains: data.customDomains,
    rulesetError: data.rulesetError ?? null,
    parking: data.parking,
    redirects: data.redirects,
    usage: data.usage,
    mail,
    park,
    canPark: !!park || (await parkReady(c, data.zone.account.id)),
    changes: changes.results,
  };
}

api.get("/zones/:zone", async (c) => c.json(await zonePayload(c, c.req.param("zone"))));

const audit = (c: Ctx, accountId: string, zoneId: string | null, zoneName: string | null, action: string, detail: unknown) =>
  c.env.DB.prepare("INSERT INTO audit (at, actor, account_id, zone_id, zone_name, action, detail) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(now(), c.get("email"), accountId, zoneId, zoneName, action, JSON.stringify(detail))
    .run();

/** Runs a change: re-reads the zone, applies it, records who did it and returns the new state. */
async function mutate(c: Ctx, action: string, fn: (ctx: Awaited<ReturnType<typeof syncZone>>) => Promise<Done[]>) {
  const zoneId = c.req.param("zone")!;
  const before = await syncZone(c.env.DB, cf(c), zoneId, { source: "external" });
  const done = await fn(before);
  await audit(c, before.data.zone.account.id, zoneId, before.data.zone.name, action, done);
  await syncZone(c.env.DB, cf(c), zoneId, { source: "dash", actor: c.get("email") });
  return c.json({ done, zone: await zonePayload(c, zoneId) });
}

api.post("/zones/:zone/parking", async (c) => {
  const body = await c.req.json<{ enable: boolean; protectMail?: boolean; removeRecords?: boolean }>();
  return mutate(c, body.enable ? "parking.enable" : "parking.disable", async ({ data, mail }) => {
    if (!body.enable) return disableParking(cf(c), data, !!body.removeRecords);
    const done: Done[] = [];
    const acc = data.zone.account.id;
    const status = await parkStatus(cf(c), acc);
    // Who manages only some domains can't see the account's Workers: they can still park a domain
    // on the parking page that is already there, but not publish it the first time.
    if (!status) {
      if (!(await parkReady(c, acc))) throw new Conflict("park-not-ready");
    } else if (await ensureParkingPublished(c.env.DB, cf(c), acc, status.published, c.get("email"))) done.push({ op: "park.publish" });
    return [...done, ...(await enableParking(cf(c), data, !!body.protectMail, mail))];
  });
});

const redirectInput = (body: Partial<RedirectInput>): RedirectInput => ({
  host: body.host ? String(body.host) : undefined,
  path: body.path ? String(body.path) : null,
  pathPrefix: !!body.pathPrefix,
  target: String(body.target ?? "").trim(),
  status: [301, 302, 307, 308].includes(Number(body.status)) ? (Number(body.status) as RedirectInput["status"]) : 301,
  preservePath: !!body.preservePath,
  preserveQuery: !!body.preserveQuery,
  includeWww: body.includeWww !== false,
});

api.post("/zones/:zone/redirects", async (c) => {
  const input = redirectInput(await c.req.json());
  return mutate(c, "redirect.add", ({ data }) => addRedirect(cf(c), data, input));
});

api.put("/zones/:zone/redirects/:rule", async (c) => {
  const input = redirectInput(await c.req.json());
  return mutate(c, "redirect.update", ({ data }) => updateRedirect(cf(c), data, c.req.param("rule"), input));
});

api.delete("/zones/:zone/redirects/:rule", async (c) => mutate(c, "redirect.delete", ({ data }) => deleteRedirect(cf(c), data, c.req.param("rule"), c.req.query("records") === "1")));

api.post("/zones/:zone/mail-fix", async (c) => {
  const body = await c.req.json<{ fix: FixId; name?: string } & FixOptions>();
  return mutate(c, `mail.${body.fix}`, ({ data, mail }) => applyMailFix(cf(c), data, mail, body.fix, body, body.name));
});

api.post("/zones/:zone/mail/mx", async (c) => {
  const body = await c.req.json<{ preset: MxPreset; updateSpf?: boolean; name?: string }>();
  if (!["google", "microsoft", "qboxmail", "forwardemail", "none"].includes(body.preset)) throw new Conflict("bad-request");
  return mutate(c, "mail.mx", ({ data }) => setMx(cf(c), data, body.preset, body.updateSpf !== false, body.name));
});

api.put("/zones/:zone/mail/spf", async (c) => {
  const { value, name } = await c.req.json<{ value: string; name?: string }>();
  return mutate(c, "mail.spf", ({ data }) => setSpf(cf(c), data, String(value ?? ""), name));
});

api.put("/zones/:zone/mail/dmarc", async (c) => {
  const body = await c.req.json<{ policy: "none" | "quarantine" | "reject"; rua?: string; name?: string }>();
  return mutate(c, "mail.dmarc", ({ data }) => setDmarc(cf(c), data, { policy: body.policy, rua: body.rua?.trim() || undefined }, body.name));
});

api.get("/accounts/:acc/activity", async (c) => {
  const acc = c.req.param("acc");
  await requireMember(c, acc);
  const ids = new Set((await visibleZones(c, acc)).map((z) => z.id));
  const rows = await c.env.DB.prepare("SELECT * FROM changes WHERE account_id = ? ORDER BY detected_at DESC, id DESC LIMIT 500").bind(acc).all<{ zone_id: string }>();
  const log = await c.env.DB.prepare("SELECT * FROM audit WHERE account_id = ? ORDER BY at DESC LIMIT 200").bind(acc).all<{ zone_id: string | null }>();
  return c.json({ changes: rows.results.filter((r) => ids.has(r.zone_id)), audit: log.results.filter((r) => !r.zone_id || ids.has(r.zone_id)) });
});

// --- Parking page ---

/** The user must be able to read the account's Workers to see or change its parking page. */
async function requirePark(c: Ctx) {
  const status = await parkStatus(cf(c), c.req.param("acc")!);
  if (!status) throw new Conflict("forbidden");
  return status;
}

api.get("/accounts/:acc/park", async (c) => {
  const acc = c.req.param("acc");
  const status = await requirePark(c);
  const [{ settings, publishedAt, updatedAt, updatedBy }, canManage] = await Promise.all([loadParkSettings(c.env.DB, cf(c), acc), managesAccount(c, acc)]);
  return c.json({ status, settings, publishedAt, updatedAt, updatedBy, canManage });
});

// The parking pages are the same for every parked domain of the account: only its administrators change them.
api.put("/accounts/:acc/park", async (c) => {
  const acc = c.req.param("acc");
  await requireManager(c, acc);
  await requirePark(c);
  const clean = cleanParkSettings(await c.req.json<ParkSettings>());
  await saveAndPublish(cf(c), acc, clean, c.get("email"));
  await audit(c, acc, null, null, "park.settings", [{ op: "park.publish" }]);
  return c.json({ ok: true });
});

type ScriptVersion = { id: string; number: number; metadata: { created_on: string; author_email?: string } };

/** Earlier publications of the parking pages, newest first. */
api.get("/accounts/:acc/park/versions", async (c) => {
  const acc = c.req.param("acc");
  await requirePark(c);
  const res = await cf(c).req<{ items: ScriptVersion[] }>("GET", `/accounts/${acc}/workers/scripts/${PARK_WORKER}/versions?per_page=20`);
  return c.json({ versions: res.items.map((v) => ({ id: v.id, number: v.number, at: Date.parse(v.metadata.created_on), by: v.metadata.author_email ?? null })) });
});

/** The parking pages of one earlier publication, to load them in the editor. */
api.get("/accounts/:acc/park/versions/:id", async (c) => {
  const { acc, id } = c.req.param();
  await requirePark(c);
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Conflict("park-version-empty");
  const v = await cf(c).req<{ modules?: { name: string; content_base64: string }[] }>("GET", `/accounts/${acc}/workers/workers/${PARK_WORKER}/versions/${id}?include=modules`);
  const settings = settingsFromVersion(v);
  if (!settings) throw new Conflict("park-version-empty");
  return c.json({ settings });
});

// --- Domain groups (resource groups made of zones) ---

type Scope = { key: string; objects: { key: string }[] };
type ResourceGroup = { id: string; name: string; meta?: { editable?: string }; scope: Scope | Scope[] };
const ZONE_KEY = "com.cloudflare.api.account.zone.";

function groupZones(g: ResourceGroup) {
  const keys = (Array.isArray(g.scope) ? g.scope : [g.scope]).flatMap((s) => s.objects.map((o) => o.key));
  return { zones: keys.filter((k) => k.startsWith(ZONE_KEY)).map((k) => k.slice(ZONE_KEY.length)), other: keys.filter((k) => !k.startsWith(ZONE_KEY)).length };
}

type Member = { email: string; status: string; policies?: { access: string; resource_groups?: { id: string }[] }[] };

api.get("/accounts/:acc/groups", async (c) => {
  const acc = c.req.param("acc");
  const [groups, members] = await Promise.all([
    cf(c).req<ResourceGroup[]>("GET", `/accounts/${acc}/iam/resource_groups`),
    // Who has access through each group: a nice extra, the groups show without it.
    cf(c).all<Member>(`/accounts/${acc}/members`, 50).catch(() => null),
  ]);
  const access = (id: string) =>
    members
      ?.filter((m) => m.policies?.some((p) => p.access === "allow" && p.resource_groups?.some((r) => r.id === id)))
      .map((m) => ({ email: m.email, pending: m.status !== "accepted" }))
      .sort((a, b) => a.email.localeCompare(b.email));
  return c.json({
    groups: groups
      .map((g) => ({ id: g.id, name: g.name, ...groupZones(g), editable: g.meta?.editable !== "false", access: access(g.id) }))
      .filter((g) => g.editable && g.zones.length && !g.other)
      .sort((a, b) => a.name.localeCompare(b.name)),
  });
});

// Roles that can be given on a group of domains: Cloudflare permission groups, by label.
const INVITE_ROLES: Record<string, string> = { admin: "domain_admin", dns: "domain_dns_admin", read: "domain_admin_readonly" };

api.post("/accounts/:acc/groups/:id/invite", async (c) => {
  const acc = c.req.param("acc");
  const body = await c.req.json<{ email?: string; role?: string }>();
  const email = String(body.email ?? "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw new Conflict("email-invalid");
  const label = INVITE_ROLES[String(body.role)];
  if (!label) throw new Conflict("role-invalid");
  const group = await cf(c).req<ResourceGroup>("GET", `/accounts/${acc}/iam/resource_groups/${encodeURIComponent(c.req.param("id"))}`);
  const { zones, other } = groupZones(group);
  if (!zones.length || other) throw new Conflict("group-not-domains");
  const [permission] = await cf(c).req<{ id: string }[]>("GET", `/accounts/${acc}/iam/permission_groups?label=${label}`);
  if (!permission) throw new Conflict("role-invalid");
  const members = await cf(c).all<Member>(`/accounts/${acc}/members`, 50);
  if (members.some((m) => m.email.toLowerCase() === email)) throw new Conflict("member-exists");
  await cf(c).req("POST", `/accounts/${acc}/members`, {
    email,
    policies: [{ access: "allow", permission_groups: [{ id: permission.id }], resource_groups: [{ id: group.id }] }],
  });
  await audit(c, acc, null, null, "member.invite", [{ op: "member.invite", email, name: group.name }]);
  return c.json({ ok: true });
});

function groupBody(acc: string, body: { name?: string; zones?: string[] }) {
  const name = String(body.name ?? "").trim().slice(0, 100);
  if (!name) throw new Conflict("group-name");
  if (!body.zones?.length) throw new Conflict("group-empty");
  return { name, scope: { key: `com.cloudflare.api.account.${acc}`, objects: body.zones.map((z) => ({ key: `${ZONE_KEY}${z}` })) } };
}

api.post("/accounts/:acc/groups", async (c) => {
  const acc = c.req.param("acc");
  const body = groupBody(acc, await c.req.json());
  const g = await cf(c).req<ResourceGroup>("POST", `/accounts/${acc}/iam/resource_groups`, body);
  await audit(c, acc, null, null, "group.add", [{ op: "group.add", name: body.name }]);
  return c.json({ id: g.id });
});

api.put("/accounts/:acc/groups/:id", async (c) => {
  const acc = c.req.param("acc");
  const body = groupBody(acc, await c.req.json());
  await cf(c).req("PUT", `/accounts/${acc}/iam/resource_groups/${c.req.param("id")}`, body);
  await audit(c, acc, null, null, "group.update", [{ op: "group.update", name: body.name }]);
  return c.json({ ok: true });
});

api.delete("/accounts/:acc/groups/:id", async (c) => {
  const acc = c.req.param("acc");
  await cf(c).req("DELETE", `/accounts/${acc}/iam/resource_groups/${c.req.param("id")}`);
  await audit(c, acc, null, null, "group.delete", [{ op: "group.delete", name: c.req.query("name") ?? "" }]);
  return c.json({ ok: true });
});

app.route("/api", api);

// --- MCP ---

app.route("/", mcpAuth);

const mcpCors = { "access-control-allow-origin": "*", "access-control-expose-headers": "www-authenticate, mcp-session-id" };

app.options("/mcp", (c) =>
  c.body(null, 204, { ...mcpCors, "access-control-allow-methods": "POST, GET, DELETE", "access-control-allow-headers": "authorization, content-type, mcp-protocol-version, mcp-session-id", "access-control-max-age": "86400" }),
);

// No server-sent stream and no sessions: every request stands alone. A browser gets the page that
// explains how to connect an assistant.
app.get("/mcp", async (c) => {
  if (c.req.header("accept")?.includes("text/html")) return c.env.ASSETS.fetch(new Request(new URL("/", c.req.url)));
  return c.body(null, 405, { ...mcpCors, allow: "POST" });
});
app.delete("/mcp", (c) => c.body(null, 405, { ...mcpCors, allow: "POST" }));

app.post("/mcp", async (c) => {
  const who = await bearerSession(c);
  if (!who) return c.json({ error: "invalid_token" }, 401, { ...mcpCors, "www-authenticate": `Bearer resource_metadata="${resourceMetadataUrl(c)}"` });
  const ctx: McpCtx = {
    async call(method, path, body) {
      const res = await app.fetch(
        new Request(new URL(`/api${path}`, c.req.url), {
          method,
          headers: { authorization: c.req.header("authorization")!, ...(body !== undefined && { "content-type": "application/json" }) },
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
        c.env,
        c.executionCtx,
      );
      const json = (await res.json().catch(() => ({}))) as { error?: string; params?: Record<string, unknown> };
      if (!res.ok) throw new ToolError(json.error ?? "unexpected", json.params);
      return json as never;
    },
    async zone(domain) {
      const zones = await new CfApi(who.token).req<Zone[]>("GET", `/zones?name=${encodeURIComponent(domain)}`).catch(() => []);
      if (!zones[0]) throw new ToolError("zone-not-found", { domain });
      return zones[0].id;
    },
  };
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") return c.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400, mcpCors);
  const one = async (m: unknown) => {
    try {
      return await handleRpc(m as Parameters<typeof handleRpc>[0], ctx);
    } catch (e) {
      console.error(e);
      return { jsonrpc: "2.0", id: (m as { id?: unknown }).id ?? null, error: { code: -32603, message: "Internal error" } };
    }
  };
  const out = Array.isArray(body) ? (await Promise.all(body.map(one))).filter(Boolean) : await one(body);
  if (!out || (Array.isArray(out) && !out.length)) return c.body(null, 202, mcpCors);
  return c.json(out, 200, mcpCors);
});

app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default {
  fetch: app.fetch,
  async scheduled(_event, env, ctx) {
    await ensureSchema(env.DB);
    // Each account with its own token, the others with the shared one if there is one.
    const { serviceToken } = await getConfig(env);
    const accounts = (await tenantTokens(env)).flatMap((t) => (t.token ?? serviceToken ? [{ id: t.id, token: (t.token ?? serviceToken)! }] : []));
    if (accounts.length) ctx.waitUntil(syncAll(env.DB, accounts));
  },
} satisfies ExportedHandler<Env>;
