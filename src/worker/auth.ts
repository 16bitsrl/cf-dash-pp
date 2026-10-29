// Everyone signs in with Cloudflare (OAuth) and works with their own token, so they see and change
// only what they would see in the dashboard. Which accounts can be used is decided in tenants.ts.

import type { Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { b64url, open, randomToken, seal, sha256 } from "./lib/crypto";
import { claimAdmin, getConfig } from "./config";
import { now } from "./lib/db";

export type Env = {
  DB: D1Database;
  ASSETS: Fetcher;
  // The address people open; without it, the one of the request (workers.dev, for example).
  PUBLIC_URL?: string;
  OAUTH_CLIENT_ID: string;
  OAUTH_CLIENT_SECRET: string;
  SESSION_KEY: string;
  SERVICE_TOKEN?: string;
  // Comma separated: who can open the setup page.
  ADMIN_EMAILS?: string;
  // Account the Worker is deployed in, for links on the setup page.
  ACCOUNT_ID?: string;
  // Given at install time: opens the setup page until signing in works.
  SETUP_CODE?: string;
  // Local development only (localhost): skips the sign-in and uses this token.
  DEV_TOKEN?: string;
  DEV_EMAIL?: string;
};

export type Vars = { email: string; token: string; admin: boolean };
export type Ctx = Context<{ Bindings: Env; Variables: Vars }>;

const OAUTH = {
  authorize: "https://dash.cloudflare.com/oauth2/auth",
  token: "https://dash.cloudflare.com/oauth2/token",
  revoke: "https://dash.cloudflare.com/oauth2/revoke",
};

// Must match the scopes of the OAuth client (see docs/setup.md).
export const OAUTH_SCOPES = [
  "offline_access",
  "user-details.read",
  "memberships.read",
  "account-settings.read",
  "account-settings.write",
  "zone.read",
  "dns.read",
  "dns.write",
  "workers-routes.read",
  "workers-routes.write",
  "workers-scripts.read",
  "workers-scripts.write",
  "dynamic-redirect.read",
  "dynamic-redirect.write",
];

const COOKIE = "dpp_session";
const SESSION_DAYS = 30;

export const isDev = (c: Ctx) => {
  const host = new URL(c.req.url).hostname;
  return !!c.env.DEV_TOKEN && (host === "localhost" || host === "127.0.0.1");
};

// --- OAuth ---

const basic = async (env: Env) => {
  const cfg = await getConfig(env);
  return `Basic ${btoa(`${cfg.oauthClientId}:${cfg.oauthClientSecret}`)}`;
};

async function tokenRequest(env: Env, params: Record<string, string>) {
  const res = await fetch(OAUTH.token, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: await basic(env),
    },
    body: new URLSearchParams(params),
  });
  const json = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string; error_description?: string };
  if (!res.ok || !json.access_token) throw new Error(json.error_description ?? json.error ?? `HTTP ${res.status}`);
  return json as Tokens;
}

export const publicUrl = (c: Ctx) => c.env.PUBLIC_URL || new URL(c.req.url).origin;
export const redirectUri = (c: Ctx) => `${publicUrl(c)}/auth/callback`;

/** The Cloudflare sign-in address; after it, the callback goes on to `returnTo`. */
export async function cfAuthorizeUrl(c: Ctx, returnTo: string) {
  const state = randomToken(24);
  const verifier = randomToken(48);
  const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  await c.env.DB.prepare("DELETE FROM oauth_states WHERE created_at < ?").bind(now() - 600_000).run();
  await c.env.DB.prepare("INSERT INTO oauth_states (state, verifier, return_to, created_at) VALUES (?, ?, ?, ?)").bind(state, verifier, returnTo, now()).run();
  const url = new URL(OAUTH.authorize);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: (await getConfig(c.env)).oauthClientId,
    redirect_uri: redirectUri(c),
    scope: OAUTH_SCOPES.join(" "),
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();
  return url.toString();
}

export async function startLogin(c: Ctx) {
  const ret = c.req.query("return") ?? "/";
  return c.redirect(await cfAuthorizeUrl(c, ret.startsWith("/") && !ret.startsWith("//") ? ret : "/"));
}

// Sign-ins started by an MCP client: `return_to` is "mcp:<request id>" and no cookie is set.
export const MCP_RETURN = "mcp:";

export type Tokens = { access_token: string; refresh_token?: string; expires_in?: number };

/** Stores a session under the hash of its id. */
export async function insertSession(env: Env, id: string, email: string, tok: Tokens) {
  const t = now();
  await env.DB.prepare("INSERT INTO sessions (id, email, access_token, refresh_token, expires_at, created_at, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(id, email, await seal(env.SESSION_KEY, tok.access_token), tok.refresh_token ? await seal(env.SESSION_KEY, tok.refresh_token) : null, t + (tok.expires_in ?? 3600) * 1000, t, t)
    .run();
}

export async function finishLogin(c: Ctx): Promise<{ ok: true; returnTo: string; email: string; tokens: Tokens } | { ok: false; code: string; params?: Record<string, string> }> {
  const { code, state, error, error_description } = c.req.query();
  if (error) return { ok: false, code: error === "access_denied" ? "login-denied" : "login-failed", params: { message: error_description ?? error } };
  if (!code || !state) return { ok: false, code: "login-incomplete" };
  const row = await c.env.DB.prepare("DELETE FROM oauth_states WHERE state = ? RETURNING verifier, return_to, created_at").bind(state).first<{ verifier: string; return_to: string; created_at: number }>();
  if (!row || row.created_at < now() - 600_000) return { ok: false, code: "login-expired" };

  const tok = await tokenRequest(c.env, { grant_type: "authorization_code", code, redirect_uri: redirectUri(c), code_verifier: row.verifier });
  const me = await fetch("https://api.cloudflare.com/client/v4/user", { headers: { authorization: `Bearer ${tok.access_token}` } }).then((r) => r.json() as Promise<{ result?: { email?: string } }>);
  const email = me.result?.email?.toLowerCase();
  if (!email) return { ok: false, code: "login-no-email" };
  await claimAdmin(c.env, email);
  if (!row.return_to.startsWith(MCP_RETURN)) {
    const id = randomToken(32);
    await insertSession(c.env, await sha256(id), email, tok);
    setCookie(c, COOKIE, id, { httpOnly: true, secure: true, sameSite: "Lax", path: "/", maxAge: SESSION_DAYS * 86400 });
  }
  return { ok: true, returnTo: row.return_to, email, tokens: tok };
}

type SessionRow = { id: string; email: string; access_token: string; refresh_token: string | null; expires_at: number; last_seen: number };

/** The signed-in user and their token for this request, refreshed when about to expire. */
export async function session(c: Ctx) {
  const raw = getCookie(c, COOKIE);
  return raw ? sessionById(c, await sha256(raw)) : null;
}

/** The session stored under this id hash, with its token refreshed when about to expire. */
export async function sessionById(c: Ctx, id: string): Promise<{ email: string; token: string } | null> {
  const row = await c.env.DB.prepare("SELECT * FROM sessions WHERE id = ?").bind(id).first<SessionRow>();
  if (!row || row.last_seen < now() - SESSION_DAYS * 86400_000) return null;
  if (row.expires_at > now() + 60_000) {
    if (row.last_seen < now() - 300_000) c.executionCtx.waitUntil(c.env.DB.prepare("UPDATE sessions SET last_seen = ? WHERE id = ?").bind(now(), id).run());
    return { email: row.email, token: await open(c.env.SESSION_KEY, row.access_token) };
  }
  if (!row.refresh_token) return null;
  try {
    const tok = await tokenRequest(c.env, { grant_type: "refresh_token", refresh_token: await open(c.env.SESSION_KEY, row.refresh_token) });
    await c.env.DB.prepare("UPDATE sessions SET access_token = ?, refresh_token = COALESCE(?, refresh_token), expires_at = ?, last_seen = ? WHERE id = ?")
      .bind(await seal(c.env.SESSION_KEY, tok.access_token), tok.refresh_token ? await seal(c.env.SESSION_KEY, tok.refresh_token) : null, now() + (tok.expires_in ?? 3600) * 1000, now(), id)
      .run();
    return { email: row.email, token: tok.access_token };
  } catch {
    await c.env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(id).run();
    return null;
  }
}

export async function logout(c: Ctx) {
  const raw = getCookie(c, COOKIE);
  if (raw) {
    const id = await sha256(raw);
    const row = await c.env.DB.prepare("DELETE FROM sessions WHERE id = ? RETURNING refresh_token").bind(id).first<{ refresh_token: string | null }>();
    if (row?.refresh_token) {
      const token = await open(c.env.SESSION_KEY, row.refresh_token).catch(() => null);
      if (token)
        c.executionCtx.waitUntil(
          fetch(OAUTH.revoke, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded", authorization: await basic(c.env) },
            body: new URLSearchParams({ token, token_type_hint: "refresh_token" }),
          }).catch(() => {}),
        );
    }
  }
  deleteCookie(c, COOKIE, { path: "/" });
}
