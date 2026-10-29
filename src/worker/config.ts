// Credentials set from the setup page. They live in D1, encrypted with SESSION_KEY, so an
// installation can be completed from the browser without touching Worker secrets.
// A value saved from the setup page wins over the one given at deploy time.

import type { Env } from "./auth";
import { open, seal } from "./lib/crypto";
import { now } from "./lib/db";

export type Config = { oauthClientId: string; oauthClientSecret: string; serviceToken: string };
type Key = keyof Config;
// Also stored, not given at deploy: who became administrator from the panel (see claimAdmin).
type Stored = Partial<Config & { admins: string }>;

const FROM_ENV: Record<Key, (env: Env) => string | undefined> = {
  oauthClientId: (e) => e.OAUTH_CLIENT_ID,
  oauthClientSecret: (e) => e.OAUTH_CLIENT_SECRET,
  serviceToken: (e) => e.SERVICE_TOKEN,
};

// Placeholders used when the deploy did not have a real value yet.
const usable = (v?: string | null) => !!v && v !== "da-impostare" && v !== "unused";

let cache: { at: number; values: Stored } | null = null;

async function stored(env: Env): Promise<Stored> {
  if (cache && Date.now() - cache.at < 30_000) return cache.values;
  const rows = await env.DB.prepare("SELECT key, value FROM config").all<{ key: keyof Stored; value: string }>();
  const values: Stored = {};
  for (const r of rows.results) values[r.key] = await open(env.SESSION_KEY, r.value).catch(() => undefined);
  cache = { at: Date.now(), values };
  return values;
}

export async function getConfig(env: Env): Promise<Config & { source: Record<Key, "setup" | "deploy" | null> }> {
  const s = await stored(env);
  const out = { source: {} } as Config & { source: Record<Key, "setup" | "deploy" | null> };
  for (const k of Object.keys(FROM_ENV) as Key[]) {
    const v = usable(s[k]) ? s[k]! : usable(FROM_ENV[k](env)) ? FROM_ENV[k](env)! : "";
    out[k] = v;
    out.source[k] = usable(s[k]) ? "setup" : usable(FROM_ENV[k](env)) ? "deploy" : null;
  }
  return out;
}

export async function setConfig(env: Env, values: Stored, actor: string) {
  const stmts = [];
  for (const [k, v] of Object.entries(values)) {
    if (v === undefined) continue;
    stmts.push(
      env.DB.prepare("INSERT INTO config (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by").bind(
        k,
        await seal(env.SESSION_KEY, v),
        now(),
        actor,
      ),
    );
  }
  if (stmts.length) await env.DB.batch(stmts);
  cache = null;
}

const emails = (v?: string) =>
  (v ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

/** Who can open the setup page: those given at deploy, plus whoever claimed it from the panel. */
export async function admins(env: Env) {
  return [...new Set([...emails(env.ADMIN_EMAILS), ...emails((await stored(env)).admins)])];
}

export const isAdmin = async (env: Env, email: string) => (await admins(env)).includes(email.toLowerCase());

/** An installation without administrators gives the role to the first person who signs in. */
export async function claimAdmin(env: Env, email: string) {
  if (!(await admins(env)).length) await setConfig(env, { admins: email }, email);
}
