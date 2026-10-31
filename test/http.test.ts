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

// Who each token is on Cloudflare: their accounts and the zones in each.
const CF_USERS: Record<string, { accounts: string[]; zones: { id: string; name: string; account: string }[] }> = {
  "tok-owner": { accounts: [TENANT], zones: [{ id: "z1", name: "tenant.it", account: TENANT }] },
  "tok-stranger": { accounts: [OTHER], zones: [{ id: "z9", name: "other.it", account: OTHER }] },
};

const ok = (result: unknown, info?: object) => Response.json({ success: true, errors: [], result, ...(info && { result_info: info }) });
const denied = () => Response.json({ success: false, errors: [{ code: 9109, message: "Unauthorized to access requested resource" }], result: null }, { status: 403 });

function cloudflare(url: URL, token: string): Response {
  const user = CF_USERS[token];
  if (!user) return Response.json({ success: false, errors: [{ code: 1000, message: "Invalid API Token" }] }, { status: 401 });
  const p = url.pathname.replace("/client/v4", "");
  if (p === "/user/tokens/verify") return ok({ status: "active" });
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
    if (url.hostname === "api.cloudflare.com") return cloudflare(url, req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "");
    if (url.hostname === "cloudflare-dns.com") return Response.json({ Answer: [] });
    return realFetch(input, init);
  });
  await signIn("owner@example.com", "tok-owner");
  await signIn("stranger@example.com", "tok-stranger");
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await mf.dispose();
});

beforeEach(async () => {
  await enableTenant(env.DB, { id: TENANT, name: "Tenant" }, "admin@example.com");
  await setSyncToken(env, TENANT, "sync-secret", "owner@example.com");
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
