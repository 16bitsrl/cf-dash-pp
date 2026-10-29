// OAuth for MCP clients (MCP authorization spec): Dash++ is the authorization server. A client
// registers itself, the person confirms on /connect which program is connecting, then signs in with
// Cloudflare. Each connection gets its own Cloudflare session, separate from the panel's, and the
// client's token is the id of that session (stored hashed, like the panel's cookie).

import { Hono } from "hono";
import { cors } from "hono/cors";
import { cfAuthorizeUrl, insertSession, isDev, MCP_RETURN, publicUrl, sessionById, type Ctx, type Env, type Tokens, type Vars } from "./auth";
import { b64url, open, randomToken, seal, sha256 } from "./lib/crypto";
import { now } from "./lib/db";

const REQUEST_TTL = 15 * 60_000;

/** Where a client may send the person back: https, or http on this computer. */
export function loopbackOrHttps(uri: string) {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.hash) return false;
  if (u.protocol === "https:") return true;
  return u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
}

export async function pkceOk(verifier: string, challenge: string) {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false;
  return b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))) === challenge;
}

/** The token is the id of a session; its hash differs from a cookie's, so neither works as the other. */
export const bearerId = (raw: string) => sha256(`mcp:${raw}`);

export const bearer = (c: Ctx) => c.req.header("authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1] ?? null;

export async function bearerSession(c: Ctx) {
  const raw = bearer(c);
  return raw ? sessionById(c, await bearerId(raw)) : null;
}

export const resourceMetadataUrl = (c: Ctx) => `${publicUrl(c)}/.well-known/oauth-protected-resource/mcp`;

type Client = { id: string; name: string; redirect_uris: string };
type Request = { id: string; client_id: string; redirect_uri: string; state: string | null; challenge: string; created_at: number; code_hash: string | null; token: string | null };

const withParams = (uri: string, params: Record<string, string | null | undefined>) => {
  const u = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v != null) u.searchParams.set(k, v);
  return u.toString();
};

async function pending(env: Env, id: string) {
  const row = await env.DB.prepare("SELECT r.*, c.name FROM mcp_requests r JOIN mcp_clients c ON c.id = r.client_id WHERE r.id = ?").bind(id).first<Request & { name: string }>();
  return row && row.created_at > now() - REQUEST_TTL && !row.code_hash ? row : null;
}

/** After the Cloudflare sign-in: a session for the client, and the code it exchanges for its token. */
export async function completeGrant(c: Ctx, requestId: string, email: string, tokens: Tokens) {
  const req = await pending(c.env, requestId);
  if (!req) return null;
  const raw = randomToken(32);
  await insertSession(c.env, await bearerId(raw), email, tokens);
  const code = randomToken(32);
  await c.env.DB.prepare("UPDATE mcp_requests SET code_hash = ?, token = ? WHERE id = ?").bind(await sha256(code), await seal(c.env.SESSION_KEY, raw), req.id).run();
  return withParams(req.redirect_uri, { code, state: req.state, iss: publicUrl(c) });
}

export const mcpAuth = new Hono<{ Bindings: Env; Variables: Vars }>();

const open_ = cors({ origin: "*", allowHeaders: ["authorization", "content-type", "mcp-protocol-version"], exposeHeaders: ["www-authenticate"] });
mcpAuth.use("/.well-known/*", open_);
mcpAuth.use("/oauth/register", open_);
mcpAuth.use("/oauth/token", open_);

const resource = (c: Ctx) =>
  c.json({ resource: `${publicUrl(c)}/mcp`, authorization_servers: [publicUrl(c)], bearer_methods_supported: ["header"], resource_name: "Dash++" });
mcpAuth.get("/.well-known/oauth-protected-resource", resource);
mcpAuth.get("/.well-known/oauth-protected-resource/mcp", resource);

mcpAuth.get("/.well-known/oauth-authorization-server", (c) => {
  const base = publicUrl(c);
  return c.json({
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    authorization_response_iss_parameter_supported: true,
  });
});

mcpAuth.post("/oauth/register", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { redirect_uris?: unknown; client_name?: unknown };
  const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris.map(String) : [];
  if (!uris.length || uris.length > 10 || !uris.every(loopbackOrHttps)) return c.json({ error: "invalid_redirect_uri" }, 400);
  const name = String(body.client_name ?? "").trim().slice(0, 80) || new URL(uris[0]).hostname;
  const id = randomToken(16);
  const at = now();
  await c.env.DB.prepare("INSERT INTO mcp_clients (id, name, redirect_uris, created_at) VALUES (?, ?, ?, ?)").bind(id, name, JSON.stringify(uris), at).run();
  return c.json(
    {
      client_id: id,
      client_id_issued_at: Math.floor(at / 1000),
      client_name: name,
      redirect_uris: uris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code"],
      response_types: ["code"],
    },
    201,
  );
});

mcpAuth.get("/oauth/authorize", async (c) => {
  const q = c.req.query();
  const client = q.client_id ? await c.env.DB.prepare("SELECT * FROM mcp_clients WHERE id = ?").bind(q.client_id).first<Client>() : null;
  // Without a known client and one of its addresses there is nobody safe to answer to.
  if (!client || !q.redirect_uri || !(JSON.parse(client.redirect_uris) as string[]).includes(q.redirect_uri)) return c.redirect("/connect?error=client");
  const fail = (error: string) => c.redirect(withParams(q.redirect_uri, { error, state: q.state }));
  if (q.response_type !== "code") return fail("unsupported_response_type");
  if (!q.code_challenge || q.code_challenge_method !== "S256") return fail("invalid_request");
  const id = randomToken(24);
  await c.env.DB.prepare("DELETE FROM mcp_requests WHERE created_at < ?").bind(now() - REQUEST_TTL).run();
  await c.env.DB.prepare("INSERT INTO mcp_requests (id, client_id, redirect_uri, state, challenge, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(id, client.id, q.redirect_uri, q.state ?? null, q.code_challenge, now())
    .run();
  return c.redirect(`/connect?request=${id}`);
});

/** What the confirmation page shows. */
mcpAuth.get("/oauth/request/:id", async (c) => {
  const req = await pending(c.env, c.req.param("id"));
  if (!req) return c.json({ error: "connect-expired" }, 404);
  const u = new URL(req.redirect_uri);
  return c.json({ client: req.name, host: u.hostname, local: u.protocol === "http:" });
});

// Only the confirmation page can answer: same origin and the panel's header, which a form on
// another site cannot send.
mcpAuth.use("/oauth/request/:id/*", async (c, next) => {
  const origin = c.req.header("origin");
  if (c.req.header("x-dash-plus-plus") !== "1" || (origin && origin !== new URL(c.req.url).origin)) return c.json({ error: "bad-request" }, 400);
  await next();
});

mcpAuth.post("/oauth/request/:id/approve", async (c) => {
  const id = c.req.param("id");
  if (!(await pending(c.env, id))) return c.json({ error: "connect-expired" }, 404);
  // In local development there is no Cloudflare sign-in: the development token is used.
  if (isDev(c)) return c.json({ redirect: await completeGrant(c, id, (c.env.DEV_EMAIL ?? "dev@localhost").toLowerCase(), { access_token: c.env.DEV_TOKEN! }) });
  return c.json({ redirect: await cfAuthorizeUrl(c, `${MCP_RETURN}${id}`) });
});

mcpAuth.post("/oauth/request/:id/deny", async (c) => {
  const row = await c.env.DB.prepare("DELETE FROM mcp_requests WHERE id = ? RETURNING redirect_uri, state").bind(c.req.param("id")).first<{ redirect_uri: string; state: string | null }>();
  return c.json({ redirect: row ? withParams(row.redirect_uri, { error: "access_denied", state: row.state }) : null });
});

mcpAuth.post("/oauth/token", async (c) => {
  const type = c.req.header("content-type") ?? "";
  const body: Record<string, string> = type.includes("json") ? await c.req.json().catch(() => ({})) : Object.fromEntries([...(await c.req.formData().catch(() => new FormData())).entries()].map(([k, v]) => [k, String(v)]));
  const fail = (error: string, status = 400) => c.json({ error }, status as 400);
  if (body.grant_type !== "authorization_code") return fail("unsupported_grant_type");
  if (!body.code || !body.code_verifier) return fail("invalid_request");
  const req = await c.env.DB.prepare("DELETE FROM mcp_requests WHERE code_hash = ? RETURNING *").bind(await sha256(body.code)).first<Request>();
  if (!req?.token || req.created_at < now() - REQUEST_TTL) return fail("invalid_grant");
  if (body.client_id !== req.client_id || body.redirect_uri !== req.redirect_uri || !(await pkceOk(body.code_verifier, req.challenge))) return fail("invalid_grant");
  c.header("cache-control", "no-store");
  return c.json({ access_token: await open(c.env.SESSION_KEY, req.token), token_type: "Bearer" });
});
