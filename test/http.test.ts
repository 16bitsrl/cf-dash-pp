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
type CfUser = { accounts: string[]; admin?: string[]; zones: { id: string; name: string; account: string }[]; readOnly?: boolean };
const CF_USERS: Record<string, CfUser> = {
  "tok-owner": { accounts: [TENANT], admin: [TENANT], zones: [{ id: "z1", name: "tenant.it", account: TENANT }, { id: "z2", name: "group.it", account: TENANT }] },
  // A member with a role on the domains of one group only (group.it), nothing at account level.
  "tok-domains": { accounts: [TENANT], zones: [{ id: "z2", name: "group.it", account: TENANT }] },
  "tok-stranger": { accounts: [OTHER], admin: [OTHER], zones: [{ id: "z9", name: "other.it", account: OTHER }] },
  // Reads the DNS of tenant.it but can't change it.
  "tok-reader": { accounts: [TENANT], zones: [{ id: "z1", name: "tenant.it", account: TENANT }], readOnly: true },
  // The account's background token: reads everything in the account.
  "sync-secret": { accounts: [TENANT], zones: [] },
};

// What exists on Cloudflare: Workers of the account, routes and records of each zone.
const PARK_WORKER = "dash-plus-plus-park";
let scripts: string[] = [];
let routes: Record<string, { id: string; pattern: string; script: string }[]> = {};
type SimRec = { id: string; type: string; name: string; content: string; proxied: boolean; ttl?: number; priority?: number; comment?: string | null; tags?: string[]; data?: Record<string, unknown>; settings?: Record<string, boolean>; modified_on?: string; meta?: Record<string, unknown> };
let records: Record<string, SimRec[]> = {};
// DNSSEC and DNS settings of each zone, the zone files imported, every change sent to Cloudflare.
let dnssec: Record<string, Record<string, unknown>> = {};
let flattenAll: Record<string, boolean> = {};
let dnssecDenied = false;
let imports: { zone: string; file: string; proxied: string | null }[] = [];
let writes: string[] = [];
let clock = 0;
const version = () => `2026-11-05T10:00:${String(++clock).padStart(2, "0")}Z`;
const fail = (code: number, message: string, status = 400) => Response.json({ success: false, errors: [{ code, message }], result: null }, { status });

// Like Cloudflare: an identical record, or A/AAAA/CNAME sharing a name with a CNAME, is refused. tenant.it is on the Free plan: no tags.
function createRecord(zone: string, body: any) {
  const list = (records[zone] ??= []);
  const content = body.content ?? Object.values(body.data ?? {}).join(" ");
  if (list.some((r) => r.type === body.type && r.name === body.name && r.content === content)) return fail(81058, "An identical record already exists.");
  const onName = list.filter((r) => r.name === body.name);
  if ((body.type === "CNAME" && onName.some((r) => ["A", "AAAA", "CNAME"].includes(r.type))) || (["A", "AAAA"].includes(body.type) && onName.some((r) => r.type === "CNAME")))
    return fail(81053, "An A, AAAA, or CNAME record with that host already exists.");
  if (body.tags?.length) return fail(9300, `DNS record has ${body.tags.length} tags, exceeding the quota of 0.`);
  const r: SimRec = { id: `d${++clock}`, ...body, content, proxied: !!body.proxied, modified_on: version(), meta: {} };
  list.push(r);
  return ok(r);
}

function dnsApi(method: string, zone: string, what: string, body: any, req: Request): Promise<Response> | Response {
  const list = (records[zone] ??= []);
  if (what === "dnssec") {
    if (dnssecDenied) return denied();
    if (method === "GET") return ok(dnssec[zone] ?? { status: "disabled" });
    dnssec[zone] = body.status === "active" ? { status: "pending", ds: "tenant.it. 3600 IN DS 2371 13 2 ABCDEF", digest: "ABCDEF", digest_type: "2", algorithm: "13", key_tag: 2371, public_key: "mdsswUyr3DPW132mOi8V9xESWE8jTo0d", flags: 257 } : { status: "disabled" };
    return ok(dnssec[zone]);
  }
  if (what === "dns_settings") {
    if (method === "PATCH" && zone === "z2") return fail(1003, "CNAME flattening is not available to this account or zone. Contact support for more information.");
    if (method === "PATCH") flattenAll[zone] = !!body.flatten_all_cnames;
    return ok({ flatten_all_cnames: !!flattenAll[zone], nameservers: { type: "cloudflare.standard" } });
  }
  if (what === "dns_records/export") return new Response(list.map((r) => `${r.name}.\t${r.ttl ?? 1}\tIN\t${r.type}\t${r.content}`).join("\n"), { headers: { "content-type": "text/plain" } });
  if (what === "dns_records/import")
    return req.formData().then(async (form) => {
      const file = await (form.get("file") as File).text();
      imports.push({ zone, file, proxied: form.get("proxied") as string | null });
      const lines = file.split("\n").filter((l) => l.trim() && !l.startsWith(";"));
      // Like Cloudflare: one line it can't read and the whole file is refused.
      const bad = lines.findIndex((l) => l.split(/\s+/).length < 5);
      if (bad >= 0) return fail(9209, `Error while parsing zone file: dns: not a TTL at line: ${bad + 1}:1.`);
      let added = 0;
      const messages: { code: number; message: string }[] = [];
      for (const l of lines) {
        const [name, ttl, , type, ...rest] = l.split(/\s+/);
        const res = await createRecord(zone, { type, name: name.replace(/\.$/, ""), content: rest.join(" ").replace(/\.$/, ""), ttl: Number(ttl) }).json();
        if ((res as any).success) added++;
        else messages.push({ code: (res as any).errors[0].code, message: `${name.replace(/\.$/, "")}: ${(res as any).errors[0].message}` });
      }
      return Response.json({ success: true, errors: [], messages, result: { recs_added: added, total_records_parsed: lines.length } });
    });
  if (what === "dns_records/batch") {
    const ids: string[] = (body.deletes ?? []).map((d: { id: string }) => d.id);
    if (ids.some((id) => !list.some((r) => r.id === id))) return fail(81044, "Record does not exist.", 404);
    records[zone] = list.filter((r) => !ids.includes(r.id));
    return ok({ deletes: ids.map((id) => ({ id })) });
  }
  const id = what.slice("dns_records/".length);
  const r = list.find((x) => x.id === id);
  if (!r) return fail(81044, "Record does not exist.", 404);
  if (method === "DELETE") {
    records[zone] = list.filter((x) => x !== r);
    return ok({ id });
  }
  if (method === "PATCH") {
    if (body.tags?.length) return fail(9300, `DNS record has ${body.tags.length} tags, exceeding the quota of 0.`);
    Object.assign(r, body, { content: body.content ?? (body.data ? Object.values(body.data).join(" ") : r.content), comment: body.comment === "" ? null : (body.comment ?? r.comment), modified_on: version() });
    return ok(r);
  }
  return ok(r);
}

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
  const body: any = method === "GET" || req.headers.get("content-type")?.startsWith("multipart/") ? null : await req.clone().json().catch(() => null);
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
  const zw = p.match(/^\/zones\/([^/]+)\//);
  if (zw && user.zones.some((z) => z.id === zw[1]) && method !== "GET") {
    if (user.readOnly) return denied();
    writes.push(`${method} ${p}`);
  }
  w = p.match(/^\/zones\/([^/]+)\/(dnssec|dns_settings|dns_records\/[^/]+)$/);
  if (w) return user.zones.some((z) => z.id === w![1]) ? dnsApi(method, w[1], w[2], body, req) : denied();
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
    return createRecord(zone, body);
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
    return z ? ok({ id: z.id, name: z.name, status: "active", account: { id: z.account, name: "" }, name_servers: ["ada.ns.cloudflare.com", "bob.ns.cloudflare.com"], plan: { name: "Free Website" } }) : denied();
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
  await signIn("reader@example.com", "tok-reader");
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
  dnssec = {};
  flattenAll = {};
  dnssecDenied = false;
  imports = [];
  writes = [];
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

// --- DNS records ---

const seed = (...list: Partial<SimRec>[]) => {
  records.z1 = list.map((r, i) => ({ id: `s${i + 1}`, type: "A", name: "www.tenant.it", content: "198.51.100.4", proxied: false, ttl: 1, comment: null, tags: [], meta: {}, modified_on: `2026-11-01T00:00:0${i}Z`, ...r }));
  return records.z1;
};
const lastAudit = () => env.DB.prepare("SELECT action, detail, actor FROM audit WHERE zone_id = 'z1' ORDER BY id DESC LIMIT 1").first<{ action: string; detail: string; actor: string }>();
const auditCount = async () => (await env.DB.prepare("SELECT COUNT(*) AS n FROM audit WHERE zone_id = 'z1'").first<{ n: number }>())!.n;
const input = (r: object) => ({ type: "A", name: "www", content: "198.51.100.4", data: {}, proxied: false, ttl: 1, comment: "", tags: [], settings: {}, ...r });

describe("adding a DNS record", () => {
  it("creates it on Cloudflare, records who did it and shows it in the history as made from Dash++", async () => {
    await call("owner@example.com", "GET", "/api/zones/z1");
    const r = await call("owner@example.com", "POST", "/api/zones/z1/records", { record: input({ name: "api", content: "198.51.100.7", proxied: true, comment: "API" }) });
    expect(r.status).toBe(200);
    expect(records.z1).toMatchObject([{ type: "A", name: "api.tenant.it", content: "198.51.100.7", proxied: true, ttl: 1, comment: "API" }]);
    expect(r.json.done).toEqual([{ op: "record.add", name: "api.tenant.it", value: "A 198.51.100.7" }]);
    expect(r.json.zone.records.map((x: SimRec) => x.name)).toEqual(["api.tenant.it"]);
    expect(await lastAudit()).toMatchObject({ action: "record.add", actor: "owner@example.com" });
    const change = await env.DB.prepare("SELECT kind, record_name, source, actor FROM changes WHERE zone_id = 'z1' ORDER BY id DESC").first();
    expect(change).toEqual({ kind: "added", record_name: "api.tenant.it", source: "dash", actor: "owner@example.com" });
  });

  it("structured records are sent with their fields", async () => {
    const r = await call("owner@example.com", "POST", "/api/zones/z1/records", { record: input({ type: "SRV", name: "_sip._tcp", content: "", data: { priority: "10", weight: "5", port: "5060", target: "sip.example.net" } }) });
    expect(r.status).toBe(200);
    expect(records.z1[0]).toMatchObject({ type: "SRV", name: "_sip._tcp.tenant.it", data: { priority: 10, weight: 5, port: 5060, target: "sip.example.net" } });
  });

  it("an invalid value is refused before reaching Cloudflare", async () => {
    const r = await call("owner@example.com", "POST", "/api/zones/z1/records", { record: input({ content: "300.1.1.1" }) });
    expect(r.status).toBe(409);
    expect(r.json.error).toBe("record-ipv4-invalid");
    expect(writes).toEqual([]);
  });

  it("a name outside the domain is refused", async () => {
    const r = await call("owner@example.com", "POST", "/api/zones/z1/records", { record: input({ name: "a b" }) });
    expect(r.json).toEqual({ error: "record-name-invalid", params: { zone: "tenant.it" } });
  });

  it("explains why Cloudflare refuses it: same record, name taken, tags not in the plan", async () => {
    seed({ id: "c1", type: "CNAME", name: "shop.tenant.it", content: "shops.example.net" }, { id: "a1" });
    const same = await call("owner@example.com", "POST", "/api/zones/z1/records", { record: input({}) });
    expect([same.status, same.json.error]).toEqual([409, "record-duplicate"]);
    const taken = await call("owner@example.com", "POST", "/api/zones/z1/records", { record: input({ name: "shop" }) });
    expect([taken.status, taken.json.error]).toEqual([409, "record-host-taken"]);
    const tags = await call("owner@example.com", "POST", "/api/zones/z1/records", { record: input({ name: "new", tags: ["team:web"] }) });
    expect([tags.status, tags.json.error]).toEqual([409, "record-tags-unavailable"]);
    expect(records.z1).toHaveLength(2);
  });

  it("someone who can only read the domain gets a clear refusal", async () => {
    const r = await call("reader@example.com", "POST", "/api/zones/z1/records", { record: input({}) });
    expect([r.status, r.json.error]).toEqual([403, "forbidden"]);
    expect(records.z1 ?? []).toEqual([]);
  });

  it("someone outside the account can't add records", async () => {
    const r = await call("stranger@example.com", "POST", "/api/zones/z1/records", { record: input({}) });
    expect(r.status).toBe(403);
    expect(records.z1 ?? []).toEqual([]);
  });
});

describe("changing a DNS record", () => {
  it("saves it and keeps the old and new values in the history of actions", async () => {
    const [rec] = seed({ comment: "web" });
    const r = await call("owner@example.com", "PATCH", `/api/zones/z1/records/${rec.id}`, { record: input({ content: "198.51.100.9", ttl: 3600, comment: "web" }), modifiedOn: rec.modified_on });
    expect(r.status).toBe(200);
    expect(records.z1[0]).toMatchObject({ content: "198.51.100.9", ttl: 3600 });
    expect(r.json.done).toEqual([{ op: "record.update", name: "www.tenant.it", value: "A 198.51.100.4 → A 198.51.100.9", changes: "content: 198.51.100.4 → 198.51.100.9; ttl: 1 → 3600" }]);
    expect(JSON.parse((await lastAudit())!.detail)).toEqual(r.json.done);
  });

  it("refuses if the record changed since it was shown", async () => {
    const [rec] = seed({});
    const r = await call("owner@example.com", "PATCH", `/api/zones/z1/records/${rec.id}`, { record: input({ content: "198.51.100.9" }), modifiedOn: "2020-01-01T00:00:00Z" });
    expect(r.status).toBe(409);
    expect(r.json).toEqual({ error: "record-changed", params: { name: "www.tenant.it" } });
    expect(records.z1[0].content).toBe("198.51.100.4");
  });

  it("refuses a record that no longer exists", async () => {
    const r = await call("owner@example.com", "PATCH", "/api/zones/z1/records/gone", { record: input({}), modifiedOn: "x" });
    expect([r.status, r.json.error]).toEqual([409, "record-not-found"]);
  });

  it("never changes a record Cloudflare marks as read-only", async () => {
    const [rec] = seed({ meta: { read_only: true, origin_worker_id: "w1" } });
    const r = await call("owner@example.com", "PATCH", `/api/zones/z1/records/${rec.id}`, { record: input({ content: "198.51.100.9" }), modifiedOn: rec.modified_on });
    expect(r.json).toEqual({ error: "record-read-only", params: { name: "www.tenant.it" } });
    expect(writes).toEqual([]);
  });

  it("doesn't change the type", async () => {
    const [rec] = seed({});
    const r = await call("owner@example.com", "PATCH", `/api/zones/z1/records/${rec.id}`, { record: input({ type: "AAAA", content: "2001:db8::1" }), modifiedOn: rec.modified_on });
    expect(r.json.error).toBe("record-type-change");
  });

  it("with nothing to change, sends nothing to Cloudflare", async () => {
    const [rec] = seed({});
    const r = await call("owner@example.com", "PATCH", `/api/zones/z1/records/${rec.id}`, { record: input({}), modifiedOn: rec.modified_on });
    expect(r.status).toBe(200);
    expect(r.json.done).toEqual([]);
    expect(writes).toEqual([]);
  });
});

describe("deleting DNS records", () => {
  it("deletes one record", async () => {
    const [a, b] = seed({}, { id: "s2", type: "TXT", name: "tenant.it", content: "hello" });
    const r = await call("owner@example.com", "POST", "/api/zones/z1/records/delete", { records: [{ id: b.id, modifiedOn: b.modified_on }] });
    expect(r.status).toBe(200);
    expect(records.z1.map((x) => x.id)).toEqual([a.id]);
    expect(r.json.done).toEqual([{ op: "record.remove", name: "tenant.it", value: "TXT hello" }]);
  });

  it("deletes many at once, in one Cloudflare call and one entry in the history of actions", async () => {
    const list = seed({}, { id: "s2", name: "a.tenant.it" }, { id: "s3", name: "b.tenant.it" }, { id: "s4", name: "keep.tenant.it" });
    const before = await auditCount();
    const r = await call("owner@example.com", "POST", "/api/zones/z1/records/delete", { records: list.slice(0, 3).map((x) => ({ id: x.id, modifiedOn: x.modified_on })) });
    expect(r.status).toBe(200);
    expect(records.z1.map((x) => x.name)).toEqual(["keep.tenant.it"]);
    expect(writes.filter((w) => w.includes("dns_records"))).toEqual(["POST /zones/z1/dns_records/batch"]);
    expect(await auditCount()).toBe(before + 1);
    expect(JSON.parse((await lastAudit())!.detail).map((d: { name: string }) => d.name)).toEqual(["www.tenant.it", "a.tenant.it", "b.tenant.it"]);
  });

  it("deletes nothing if one of them changed or is read-only", async () => {
    const list = seed({}, { id: "s2", name: "a.tenant.it" }, { id: "s3", name: "w.tenant.it", meta: { read_only: true } });
    const changed = await call("owner@example.com", "POST", "/api/zones/z1/records/delete", { records: [{ id: list[0].id, modifiedOn: list[0].modified_on }, { id: list[1].id, modifiedOn: "old" }] });
    expect(changed.json).toEqual({ error: "record-changed", params: { name: "a.tenant.it" } });
    const ro = await call("owner@example.com", "POST", "/api/zones/z1/records/delete", { records: [{ id: list[0].id, modifiedOn: list[0].modified_on }, { id: list[2].id, modifiedOn: list[2].modified_on }] });
    expect(ro.json).toEqual({ error: "record-read-only", params: { name: "w.tenant.it" } });
    expect(records.z1).toHaveLength(3);
    expect(writes).toEqual([]);
  });

  it("asks for at least one record", async () => {
    const r = await call("owner@example.com", "POST", "/api/zones/z1/records/delete", { records: [] });
    expect(r.json.error).toBe("records-none");
  });
});

describe("zone files", () => {
  const FILE = "new.tenant.it.\t300\tIN\tA\t198.51.100.20\nwww.tenant.it.\t1\tIN\tA\t198.51.100.4\n";

  it("imports a zone file with the proxy option and lists what was added and what was skipped", async () => {
    seed({});
    const r = await call("owner@example.com", "POST", "/api/zones/z1/records/import", { file: FILE, proxied: false });
    expect(r.status).toBe(200);
    expect(imports).toEqual([{ zone: "z1", file: FILE, proxied: "false" }]);
    expect(records.z1.map((x) => x.name)).toEqual(["www.tenant.it", "new.tenant.it"]);
    expect(r.json.done).toEqual([
      { op: "record.import", value: "1/2" },
      { op: "record.add", name: "new.tenant.it", value: "A 198.51.100.20" },
      { op: "record.skip", name: "www.tenant.it", value: "record-duplicate" },
    ]);
    expect((await lastAudit())!.action).toBe("record.import");
  });

  it("explains that Cloudflare refuses the whole file when a line can't be read", async () => {
    const r = await call("owner@example.com", "POST", "/api/zones/z1/records/import", { file: `${FILE}nonsense here\n`, proxied: false });
    expect(r.status).toBe(409);
    expect(r.json).toEqual({ error: "import-invalid", params: { message: "Error while parsing zone file: dns: not a TTL at line: 3:1." } });
    expect(records.z1 ?? []).toEqual([]);
  });

  it("refuses an empty or too large file before reaching Cloudflare", async () => {
    const empty = await call("owner@example.com", "POST", "/api/zones/z1/records/import", { file: ";; nothing\n", proxied: true });
    expect(empty.json.error).toBe("import-empty");
    const big = await call("owner@example.com", "POST", "/api/zones/z1/records/import", { file: `a.tenant.it. 1 IN TXT "${"x".repeat(300 * 1024)}"`, proxied: true });
    expect(big.json.error).toBe("import-too-large");
    expect(imports).toEqual([]);
  });

  it("exports the records as a file named after the domain", async () => {
    seed({});
    const res = await worker.fetch(new Request(`${BASE}/api/zones/z1/records/export`, { headers: { cookie: cookies["owner@example.com"] } }), env, ctx());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="tenant.it.txt"');
    expect(await res.text()).toBe("www.tenant.it.\t1\tIN\tA\t198.51.100.4");
  });
});

describe("DNS settings of a domain", () => {
  it("show the nameservers, DNSSEC and CNAME flattening", async () => {
    const r = await call("owner@example.com", "GET", "/api/zones/z1/dns-settings");
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ nameServers: ["ada.ns.cloudflare.com", "bob.ns.cloudflare.com"], plan: "Free Website", dnssec: { status: "disabled" }, dnssecError: null, flattenAllCnames: false, settingsError: null });
  });

  it("turn DNSSEC on, with the DS record to give the registrar, and off again", async () => {
    const on = await call("owner@example.com", "PATCH", "/api/zones/z1/dnssec", { enable: true });
    expect(on.status).toBe(200);
    expect(on.json.done).toEqual([{ op: "dnssec.enable" }]);
    const s = await call("owner@example.com", "GET", "/api/zones/z1/dns-settings");
    expect(s.json.dnssec).toMatchObject({ status: "pending", ds: "tenant.it. 3600 IN DS 2371 13 2 ABCDEF", key_tag: 2371 });
    expect((await lastAudit())!.action).toBe("dnssec.enable");
    const off = await call("owner@example.com", "PATCH", "/api/zones/z1/dnssec", { enable: false });
    expect(off.json.done).toEqual([{ op: "dnssec.disable" }]);
    expect(dnssec.z1.status).toBe("disabled");
  });

  it("say clearly when DNSSEC can't be read with the user's permissions", async () => {
    dnssecDenied = true;
    const r = await call("owner@example.com", "GET", "/api/zones/z1/dns-settings");
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ dnssec: null, dnssecError: "forbidden", flattenAllCnames: false });
  });

  it("someone who can only read can't turn DNSSEC on", async () => {
    const r = await call("reader@example.com", "PATCH", "/api/zones/z1/dnssec", { enable: true });
    expect([r.status, r.json.error]).toEqual([403, "forbidden"]);
    expect(dnssec.z1).toBeUndefined();
  });

  it("turn CNAME flattening for every CNAME on and off", async () => {
    const r = await call("owner@example.com", "PATCH", "/api/zones/z1/dns-settings", { flattenAllCnames: true });
    expect(r.status).toBe(200);
    expect(r.json.done).toEqual([{ op: "dns.flatten-all", value: "on" }]);
    expect(flattenAll.z1).toBe(true);
    expect((await lastAudit())!.action).toBe("dns.flatten-all");
  });

  it("say when flattening every CNAME isn't in the plan", async () => {
    const r = await call("owner@example.com", "PATCH", "/api/zones/z2/dns-settings", { flattenAllCnames: true });
    expect([r.status, r.json.error]).toEqual([409, "flatten-all-unavailable"]);
  });
});
