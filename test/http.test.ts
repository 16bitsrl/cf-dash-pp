// The real Worker over HTTP, with a real D1 (Miniflare). Only the Cloudflare API is simulated:
// each token sees the accounts and zones listed in CF_USERS.

import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { insertSession, type Env } from "../src/worker/auth";
import worker from "../src/worker/index";
import { sha256 } from "../src/worker/lib/crypto";
import { ensureSchema } from "../src/worker/lib/db";
import { enableTenant, setSyncToken } from "../src/worker/tenants";

const BASE = "https://dash.example.com";
const TENANT = "a".repeat(32);
const OTHER = "b".repeat(32);

// Who each token is on Cloudflare: their accounts and the zones in each. `admin`: accounts they
// manage (account settings edit); without it they only have roles on some domains of the account.
type CfUser = { accounts: string[]; admin?: string[]; zones: { id: string; name: string; account: string }[] };
const CF_USERS: Record<string, CfUser> = {
  "tok-owner": { accounts: [TENANT], admin: [TENANT], zones: [{ id: "z1", name: "tenant.it", account: TENANT }, { id: "z2", name: "group.it", account: TENANT }] },
  // A member with a role on the domains of one group only (group.it), nothing at account level.
  "tok-domains": { accounts: [TENANT], zones: [{ id: "z2", name: "group.it", account: TENANT }] },
  "tok-stranger": { accounts: [OTHER], admin: [OTHER], zones: [{ id: "z9", name: "other.it", account: OTHER }] },
  // The account's background token: reads everything in the account.
  "sync-secret": { accounts: [TENANT], zones: [] },
};

// What exists on Cloudflare: Workers of the account, routes and records of each zone.
const PARK_WORKER = "dash-plus-plus-park";
let scripts: string[] = [];
let routes: Record<string, { id: string; pattern: string; script: string }[]> = {};
let records: Record<string, { id: string; type: string; name: string; content: string; proxied: boolean }[]> = {};

const ok = (result: unknown, info?: object) => Response.json({ success: true, errors: [], result, ...(info && { result_info: info }) });
const denied = () => Response.json({ success: false, errors: [{ code: 9109, message: "Unauthorized to access requested resource" }], result: null }, { status: 403 });
const notFound = () => Response.json({ success: false, errors: [{ code: 10000, message: "not found" }], result: null }, { status: 404 });

// The tenant account's IAM: domain groups, members, and the invitations sent in a test.
const ZONE_KEY = "com.cloudflare.api.account.zone.";
const RESOURCE_GROUPS = [
  { id: "rg-clients", name: "Clients", scope: { key: `com.cloudflare.api.account.${TENANT}`, objects: [{ key: `${ZONE_KEY}z1` }] } },
  { id: "rg-account", name: "Whole account", scope: { key: `com.cloudflare.api.account.${TENANT}`, objects: [{ key: `com.cloudflare.api.account.${TENANT}` }] } },
];
const PERMISSION_GROUPS = [
  { id: "pg-admin", name: "Domain Administrator", meta: { label: "domain_admin" } },
  { id: "pg-dns", name: "Domain DNS", meta: { label: "domain_dns_admin" } },
  { id: "pg-read", name: "Domain Administrator Read Only", meta: { label: "domain_admin_readonly" } },
];
const MEMBERS = [
  { id: "m1", email: "owner@example.com", status: "accepted", policies: [{ access: "allow", permission_groups: [{ id: "pg-super" }], resource_groups: [{ id: "rg-account" }] }] },
  { id: "m2", email: "dns@example.com", status: "pending", policies: [{ access: "allow", permission_groups: [{ id: "pg-dns" }], resource_groups: [{ id: "rg-clients" }] }] },
];
let invites: any[] = [];

async function cloudflare(req: Request, url: URL, token: string): Promise<Response> {
  const method = req.method;
  const body: any = method === "GET" ? null : await req.clone().json().catch(() => null);
  const user = CF_USERS[token];
  if (!user) return Response.json({ success: false, errors: [{ code: 1000, message: "Invalid API Token" }] }, { status: 401 });
  const p = url.pathname.replace("/client/v4", "");
  const accountWide = (acc: string) => token === "sync-secret" || !!user.admin?.includes(acc);
  if (p === "/user/tokens/verify") return ok({ status: "active" });
  if (p === "/memberships") {
    const list = user.accounts.map((id) => ({ id: `m-${id}`, status: "accepted", account: { id, name: "" }, permissions: { organization: { read: true, edit: !!user.admin?.includes(id) } } }));
    return ok(list, { page: 1, per_page: 50, count: list.length });
  }
  let w = p.match(/^\/accounts\/([^/]+)\/workers\/(scripts|domains)$/);
  if (w) return !accountWide(w[1]) ? denied() : ok(w[2] === "scripts" ? scripts.map((id) => ({ id })) : []);
  // The parking Worker's content: none of our settings in it yet.
  w = p.match(/^\/accounts\/([^/]+)\/workers\/scripts\/[^/]+\/content\/v2$/);
  if (w) return !accountWide(w[1]) ? denied() : notFound();
  w = p.match(/^\/zones\/([^/]+)\/(workers\/routes|dns_records|rulesets\/phases\/[^/]+\/entrypoint)$/);
  if (w) {
    const [, zone, what] = w;
    if (!user.zones.some((z) => z.id === zone)) return denied();
    if (what.startsWith("rulesets")) return notFound();
    if (what === "workers/routes") {
      if (method === "GET") return ok(routes[zone] ?? []);
      // Like Cloudflare: a route can only point to a Worker that exists in the account.
      if (!scripts.includes(body.script)) return Response.json({ success: false, errors: [{ code: 10019, message: "script not found" }] }, { status: 400 });
      const r = { id: `r${Math.random()}`, pattern: body.pattern, script: body.script };
      (routes[zone] ??= []).push(r);
      return ok(r);
    }
    if (method === "GET") return ok(records[zone] ?? [], { page: 1, per_page: 500, count: (records[zone] ?? []).length });
    const r = { id: `d${Math.random()}`, ...body };
    (records[zone] ??= []).push(r);
    return ok(r);
  }
  if (p.match(/^\/accounts\/[^/]+\/tokens\/verify$/)) return denied();
  if (p === "/accounts") return ok(user.accounts.map((id) => ({ id, name: `acc ${id.slice(0, 3)}` })), { page: 1, per_page: 50, count: user.accounts.length });
  let m = p.match(/^\/accounts\/([^/]+)$/);
  if (m) return user.accounts.includes(m[1]) ? ok({ id: m[1], name: `acc ${m[1].slice(0, 3)}` }) : denied();
  if (p === "/zones") {
    const acc = url.searchParams.get("account.id");
    // Like Cloudflare: zones of an account you can't see are simply not listed.
    const zones = user.zones.filter((z) => !acc || z.account === acc).map((z) => ({ id: z.id, name: z.name, status: "active", account: { id: z.account, name: "" } }));
    return ok(zones, { page: 1, per_page: 50, count: zones.length });
  }
  m = p.match(/^\/zones\/([^/]+)$/);
  if (m) {
    const z = user.zones.find((x) => x.id === m![1]);
    return z ? ok({ id: z.id, name: z.name, status: "active", account: { id: z.account, name: "" } }) : denied();
  }
  m = p.match(/^\/accounts\/([^/]+)\/(iam|members)/);
  if (m && !user.accounts.includes(m[1])) return denied();
  if (p === `/accounts/${TENANT}/iam/resource_groups`) return ok(RESOURCE_GROUPS);
  m = p.match(/^\/accounts\/[^/]+\/iam\/resource_groups\/([^/]+)$/);
  if (m) {
    const g = RESOURCE_GROUPS.find((x) => x.id === m![1]);
    return g ? ok(g) : Response.json({ success: false, errors: [{ code: 1003, message: "not found" }] }, { status: 404 });
  }
  if (p === `/accounts/${TENANT}/iam/permission_groups`) {
    const label = url.searchParams.get("label");
    return ok(PERMISSION_GROUPS.filter((g) => !label || g.meta.label === label), { page: 1, per_page: 50, count: 3 });
  }
  if (p === `/accounts/${TENANT}/members` && req.method === "GET") return ok(MEMBERS, { page: 1, per_page: 50, count: MEMBERS.length });
  if (p === `/accounts/${TENANT}/members` && req.method === "POST") {
    const body = (await req.json()) as any;
    invites.push(body);
    return ok({ id: "m-new", email: body.email, status: "pending", policies: body.policies });
  }
  return Response.json({ success: false, errors: [{ code: 0, message: `not simulated: ${p}` }] }, { status: 500 });
}

let mf: Miniflare;
let env: Env;
const cookies: Record<string, string> = {};

async function signIn(email: string, token: string) {
  const id = `session-${email}`;
  await insertSession(env, await sha256(id), email, { access_token: token, expires_in: 3600 });
  cookies[email] = `dpp_session=${id}`;
}

const ctx = () => ({ waitUntil: (p: Promise<unknown>) => void p.catch(() => {}), passThroughOnException() {}, props: {} }) as unknown as ExecutionContext;

async function call(email: string, method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { cookie: cookies[email], "x-dash-plus-plus": "1", origin: BASE };
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await worker.fetch(new Request(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env, ctx());
  return { status: res.status, json: (await res.json().catch(() => null)) as any };
}

beforeAll(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: "export default {}", d1Databases: ["DB"] }));
  const DB = (await mf.getD1Database("DB")) as unknown as D1Database;
  env = { DB, ASSETS: { fetch: async () => new Response("asset") } as unknown as Fetcher, SESSION_KEY: "test-key", OAUTH_CLIENT_ID: "", OAUTH_CLIENT_SECRET: "", ADMIN_EMAILS: "admin@example.com" };
  await ensureSchema(DB);
  const realFetch = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    if (url.hostname === "api.cloudflare.com") return cloudflare(req, url, req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "");
    if (url.hostname === "cloudflare-dns.com") return Response.json({ Answer: [] });
    return realFetch(input, init);
  });
  await signIn("owner@example.com", "tok-owner");
  await signIn("stranger@example.com", "tok-stranger");
  await signIn("domains@example.com", "tok-domains");
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await mf.dispose();
});

beforeEach(async () => {
  await enableTenant(env.DB, { id: TENANT, name: "Tenant" }, "admin@example.com");
  await setSyncToken(env, TENANT, "sync-secret", "owner@example.com");
  scripts = [PARK_WORKER];
  routes = {};
  records = {};
  invites = [];
});

const syncTokenSet = async () => !!(await env.DB.prepare("SELECT sync_token FROM tenants WHERE account_id = ?").bind(TENANT).first<{ sync_token: string | null }>())?.sync_token;

describe("background token of an enabled account", () => {
  it("a member reads who set it", async () => {
    const r = await call("owner@example.com", "GET", `/api/accounts/${TENANT}/background`);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ enabled: true, configured: true, setBy: "owner@example.com" });
  });

  it("someone outside the account cannot read it", async () => {
    const r = await call("stranger@example.com", "GET", `/api/accounts/${TENANT}/background`);
    expect(r.status).toBe(403);
    expect(JSON.stringify(r.json)).not.toContain("owner@example.com");
  });

  it("someone outside the account cannot remove it", async () => {
    const r = await call("stranger@example.com", "DELETE", `/api/accounts/${TENANT}/background`);
    expect(r.status).toBe(403);
    expect(await syncTokenSet()).toBe(true);
  });

  it("someone outside the account cannot replace it with a token of their own", async () => {
    const r = await call("stranger@example.com", "PUT", `/api/accounts/${TENANT}/background`, { token: "tok-stranger" });
    expect(r.status).toBe(403);
    const row = await env.DB.prepare("SELECT token_set_by FROM tenants WHERE account_id = ?").bind(TENANT).first<{ token_set_by: string }>();
    expect(row?.token_set_by).toBe("owner@example.com");
  });

  it("a member can remove it", async () => {
    const r = await call("owner@example.com", "DELETE", `/api/accounts/${TENANT}/background`);
    expect(r.status).toBe(200);
    expect(await syncTokenSet()).toBe(false);
  });
});

describe("a member with roles on some domains only", () => {
  it("sees the background token but cannot manage it", async () => {
    const member = await call("domains@example.com", "GET", `/api/accounts/${TENANT}/background`);
    expect(member.status).toBe(200);
    expect(member.json.canManage).toBe(false);
    const owner = await call("owner@example.com", "GET", `/api/accounts/${TENANT}/background`);
    expect(owner.json.canManage).toBe(true);
  });

  it("cannot remove the background token", async () => {
    const r = await call("domains@example.com", "DELETE", `/api/accounts/${TENANT}/background`);
    expect(r.status).toBe(403);
    expect(await syncTokenSet()).toBe(true);
  });

  it("cannot replace the background token", async () => {
    const r = await call("domains@example.com", "PUT", `/api/accounts/${TENANT}/background`, { token: "tok-domains" });
    expect(r.status).toBe(403);
    const row = await env.DB.prepare("SELECT token_set_by FROM tenants WHERE account_id = ?").bind(TENANT).first<{ token_set_by: string }>();
    expect(row?.token_set_by).toBe("owner@example.com");
  });

  it("cannot change the parking pages of the account", async () => {
    const r = await call("domains@example.com", "PUT", `/api/accounts/${TENANT}/park`, { pages: [], defaultPage: "", assign: {} });
    expect(r.status).toBe(403);
  });

  it("can park one of their domains", async () => {
    const z = await call("domains@example.com", "GET", "/api/zones/z2");
    expect(z.status).toBe(200);
    expect(z.json.canPark).toBe(true);
    const r = await call("domains@example.com", "POST", "/api/zones/z2/parking", { enable: true });
    expect(r.status).toBe(200);
    expect(routes.z2.map((x) => [x.pattern, x.script])).toEqual([
      ["group.it/*", PARK_WORKER],
      ["www.group.it/*", PARK_WORKER],
    ]);
    expect(r.json.zone.parking.state).toBe("parked");
  });

  it("is told to ask an administrator when the account has no parking page yet", async () => {
    scripts = [];
    const z = await call("domains@example.com", "GET", "/api/zones/z2");
    expect(z.json.canPark).toBe(false);
    const r = await call("domains@example.com", "POST", "/api/zones/z2/parking", { enable: true });
    expect(r.status).toBe(409);
    expect(r.json.error).toBe("park-not-ready");
    expect(records.z2 ?? []).toEqual([]);
  });
});

describe("parking pages of an account", () => {
  it("only an administrator of the account can change them", async () => {
    // The owner manages the account: the parking page is published again.
    const page = await call("owner@example.com", "GET", `/api/accounts/${TENANT}/park`);
    expect(page.status).toBe(200);
    expect(page.json.canManage).toBe(true);
  });
});

describe("activity of an enabled account", () => {
  it("someone outside the account does not see its actions", async () => {
    await env.DB.prepare("INSERT INTO audit (at, actor, account_id, zone_id, zone_name, action, detail) VALUES (?, ?, ?, NULL, NULL, ?, ?)")
      .bind(Date.now(), "owner@example.com", TENANT, "group.add", JSON.stringify([{ op: "group.add", name: "Clienti VIP" }]))
      .run();
    const member = await call("owner@example.com", "GET", `/api/accounts/${TENANT}/activity`);
    expect(member.status).toBe(200);
    expect(member.json.audit.length).toBeGreaterThan(0);
    const r = await call("stranger@example.com", "GET", `/api/accounts/${TENANT}/activity`);
    expect(r.status).toBe(403);
    expect(JSON.stringify(r.json)).not.toContain("Clienti VIP");
  });
});

describe("domains of accounts that are not enabled", () => {
  it("a user who is not a superadmin cannot open one", async () => {
    // z9 belongs to an account nobody enabled; its owner signs in but is not a superadmin.
    const r = await call("stranger@example.com", "GET", "/api/zones/z9");
    expect(r.status).toBe(409);
    expect(r.json.error).toBe("not-enabled");
  });
});

describe("domain groups", () => {
  it("show who already has access through each group", async () => {
    const r = await call("owner@example.com", "GET", `/api/accounts/${TENANT}/groups`);
    expect(r.status).toBe(200);
    expect(r.json.groups).toEqual([{ id: "rg-clients", name: "Clients", zones: ["z1"], other: 0, editable: true, access: [{ email: "dns@example.com", pending: true }] }]);
  });

  it("invite someone with access only to the group's domains", async () => {
    const r = await call("owner@example.com", "POST", `/api/accounts/${TENANT}/groups/rg-clients/invite`, { email: " New.Person@Example.com ", role: "dns" });
    expect(r.status).toBe(200);
    expect(invites).toEqual([{ email: "new.person@example.com", policies: [{ access: "allow", permission_groups: [{ id: "pg-dns" }], resource_groups: [{ id: "rg-clients" }] }] }]);
    const log = await env.DB.prepare("SELECT action, detail FROM audit WHERE account_id = ? AND action = 'member.invite' ORDER BY at DESC").bind(TENANT).first<{ action: string; detail: string }>();
    expect(JSON.parse(log!.detail)).toEqual([{ op: "member.invite", email: "new.person@example.com", name: "Clients" }]);
  });

  it("each role maps to its domain permission", async () => {
    for (const role of ["admin", "read"]) await call("owner@example.com", "POST", `/api/accounts/${TENANT}/groups/rg-clients/invite`, { email: `${role}@example.com`, role });
    expect(invites.map((i) => i.policies[0].permission_groups[0].id)).toEqual(["pg-admin", "pg-read"]);
  });

  it("refuse an invalid email or an unknown role without inviting", async () => {
    const bad = await call("owner@example.com", "POST", `/api/accounts/${TENANT}/groups/rg-clients/invite`, { email: "not-an-email", role: "dns" });
    expect(bad.json.error).toBe("email-invalid");
    const role = await call("owner@example.com", "POST", `/api/accounts/${TENANT}/groups/rg-clients/invite`, { email: "x@example.com", role: "super_admin" });
    expect(role.json.error).toBe("role-invalid");
    expect(invites).toEqual([]);
  });

  it("refuse someone who is already a member of the account", async () => {
    const r = await call("owner@example.com", "POST", `/api/accounts/${TENANT}/groups/rg-clients/invite`, { email: "DNS@example.com", role: "admin" });
    expect(r.status).toBe(409);
    expect(r.json.error).toBe("member-exists");
    expect(invites).toEqual([]);
  });

  it("only invite through a group of domains", async () => {
    const r = await call("owner@example.com", "POST", `/api/accounts/${TENANT}/groups/rg-account/invite`, { email: "x@example.com", role: "admin" });
    expect(r.status).toBe(409);
    expect(r.json.error).toBe("group-not-domains");
    expect(invites).toEqual([]);
  });

  it("someone outside the account cannot invite", async () => {
    const r = await call("stranger@example.com", "POST", `/api/accounts/${TENANT}/groups/rg-clients/invite`, { email: "x@example.com", role: "admin" });
    expect(r.status).toBe(403);
    expect(r.json.error).toBe("forbidden");
    expect(invites).toEqual([]);
  });
});
