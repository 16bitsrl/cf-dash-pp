// Tenants: the Cloudflare accounts this Dash++ serves. Everyone signs in with their own Cloudflare
// user and acts with its permissions; on top of that only enabled accounts can be used, except by
// the superadmins (ADMIN_EMAILS), who see every account of theirs and enable the others.
// Who manages an account not enabled yet can ask for it; a superadmin approves, even without being
// a member of that account.
// Each tenant can have its own read-only token for the background sync.

import type { Env } from "./auth";
import { open, seal } from "./lib/crypto";
import { now } from "./lib/db";

export type TenantInfo = { syncToken: boolean };
type Row = { account_id: string; name: string; sync_token: string | null; token_set_at: number | null; token_set_by: string | null };

export async function loadTenants(db: D1Database): Promise<Map<string, TenantInfo>> {
  const rows = await db.prepare("SELECT account_id, sync_token FROM tenants").all<Pick<Row, "account_id" | "sync_token">>();
  return new Map(rows.results.map((r) => [r.account_id, { syncToken: !!r.sync_token }]));
}

/** Every enabled account, with who enabled it. */
export async function allTenants(db: D1Database) {
  const rows = await db.prepare("SELECT account_id, name, added_at, added_by FROM tenants ORDER BY name").all<{ account_id: string; name: string; added_at: number; added_by: string }>();
  return rows.results.map((r) => ({ id: r.account_id, name: r.name, addedAt: r.added_at, addedBy: r.added_by }));
}

export const isTenant = async (db: D1Database, accountId: string) => !!(await db.prepare("SELECT 1 FROM tenants WHERE account_id = ?").bind(accountId).first());

/**
 * The accounts a user can pick: all of theirs, marked when not enabled. Only superadmins can open
 * those; the others see whether the account was asked for and whether they can ask (`managed`).
 */
export function visibleAccounts(accounts: { id: string; name: string }[], tenants: Map<string, TenantInfo>, requested: Set<string>, managed: Set<string>) {
  return accounts.map((a) => {
    const enabled = tenants.has(a.id);
    return { id: a.id, name: a.name, enabled, syncToken: tenants.get(a.id)?.syncToken ?? false, requested: !enabled && requested.has(a.id), canRequest: !enabled && managed.has(a.id) };
  });
}

/** Enables the account; a request for it, if any, is answered. */
export async function enableTenant(db: D1Database, account: { id: string; name: string }, actor: string) {
  await db.batch([
    db.prepare("INSERT INTO tenants (account_id, name, added_at, added_by) VALUES (?, ?, ?, ?) ON CONFLICT(account_id) DO UPDATE SET name = excluded.name").bind(account.id, account.name, now(), actor),
    db.prepare("DELETE FROM tenant_requests WHERE account_id = ?").bind(account.id),
  ]);
}

export type TenantRequest = { accountId: string; name: string; requestedBy: string; requestedAt: number };

/** Records the request; false if the account was already asked for. */
export async function requestTenant(db: D1Database, account: { id: string; name: string }, email: string) {
  const res = await db.prepare("INSERT INTO tenant_requests (account_id, name, requested_by, requested_at) VALUES (?, ?, ?, ?) ON CONFLICT(account_id) DO NOTHING").bind(account.id, account.name, email, now()).run();
  return res.meta.changes > 0;
}

export async function tenantRequests(db: D1Database): Promise<TenantRequest[]> {
  const rows = await db.prepare("SELECT account_id, name, requested_by, requested_at FROM tenant_requests ORDER BY requested_at").all<{ account_id: string; name: string; requested_by: string; requested_at: number }>();
  return rows.results.map((r) => ({ accountId: r.account_id, name: r.name, requestedBy: r.requested_by, requestedAt: r.requested_at }));
}

export const tenantRequest = async (db: D1Database, accountId: string) => (await tenantRequests(db)).find((r) => r.accountId === accountId) ?? null;

export const dropTenantRequest = (db: D1Database, accountId: string) => db.prepare("DELETE FROM tenant_requests WHERE account_id = ?").bind(accountId).run();

export const disableTenant = (db: D1Database, accountId: string) => db.prepare("DELETE FROM tenants WHERE account_id = ?").bind(accountId).run();

export async function setSyncToken(env: Env, accountId: string, token: string | null, actor: string) {
  await env.DB.prepare("UPDATE tenants SET sync_token = ?, token_set_at = ?, token_set_by = ? WHERE account_id = ?")
    .bind(token ? await seal(env.SESSION_KEY, token) : null, now(), actor, accountId)
    .run();
}

/** Every tenant with its own token, or null where it has none. */
export async function tenantTokens(env: Env) {
  const rows = await env.DB.prepare("SELECT account_id, name, sync_token FROM tenants").all<Row>();
  return Promise.all(rows.results.map(async (r) => ({ id: r.account_id, name: r.name, token: r.sync_token ? await open(env.SESSION_KEY, r.sync_token).catch(() => null) : null })));
}

// Read-only, the same permissions the background sync uses. The last one is "Dynamic URL Redirects
// Read", which has no short key in token links.
const SYNC_PERMISSIONS = ["zone", "dns", "workers_routes", "workers_scripts", "account_settings", "d8e12db741544d1586ec1d6f5d3c7786"];

/** Opens the dashboard on a new account token with the permissions already chosen. */
export function tokenLink(accountId: string) {
  const u = new URL("https://dash.cloudflare.com/");
  u.searchParams.set("to", `/${accountId}/api-tokens`);
  u.searchParams.set("permissionGroupKeys", JSON.stringify(SYNC_PERMISSIONS.map((key) => ({ key, type: "read" }))));
  u.searchParams.set("name", "Dash++ sync");
  return u.toString();
}
