// D1 schema. Created on the first request, so a deploy has no manual steps.

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    access_token TEXT NOT NULL,
    refresh_token TEXT,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    last_seen INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS oauth_states (
    state TEXT PRIMARY KEY,
    verifier TEXT NOT NULL,
    return_to TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS zones (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    account_id TEXT NOT NULL,
    status TEXT,
    synced_at INTEGER,
    record_count INTEGER,
    usage TEXT,
    parking TEXT,
    redirect_target TEXT,
    redirects INTEGER,
    mail_mode TEXT,
    mail_provider TEXT,
    mail_errors INTEGER,
    mail_warnings INTEGER,
    mail_checks TEXT,
    last_change_at INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS zones_account ON zones(account_id)`,
  `CREATE TABLE IF NOT EXISTS snapshots (
    zone_id TEXT PRIMARY KEY,
    records TEXT NOT NULL,
    taken_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS changes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    zone_id TEXT NOT NULL,
    zone_name TEXT NOT NULL,
    account_id TEXT NOT NULL,
    detected_at INTEGER NOT NULL,
    kind TEXT NOT NULL,
    record_type TEXT NOT NULL,
    record_name TEXT NOT NULL,
    before TEXT,
    after TEXT,
    source TEXT NOT NULL,
    actor TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS changes_zone ON changes(zone_id, detected_at DESC)`,
  `CREATE INDEX IF NOT EXISTS changes_account ON changes(account_id, detected_at DESC)`,
  `CREATE TABLE IF NOT EXISTS audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    actor TEXT NOT NULL,
    account_id TEXT,
    zone_id TEXT,
    zone_name TEXT,
    action TEXT NOT NULL,
    detail TEXT
  )`,
  // Accounts this Dash++ serves (see tenants.ts), each with its optional read-only token.
  `CREATE TABLE IF NOT EXISTS tenants (
    account_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    added_at INTEGER NOT NULL,
    added_by TEXT NOT NULL,
    sync_token TEXT,
    token_set_at INTEGER,
    token_set_by TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS sync_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    zones INTEGER,
    changes INTEGER,
    error TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS park_settings (
    account_id TEXT PRIMARY KEY,
    brand TEXT,
    scope TEXT NOT NULL DEFAULT 'all',
    include TEXT NOT NULL DEFAULT '[]',
    exclude TEXT NOT NULL DEFAULT '[]',
    updated_at INTEGER,
    updated_by TEXT,
    published_at INTEGER
  )`,
  // Replaced by the settings inside the parking Worker; park_pages and park_settings are read
  // only for accounts saved before, until their next save.
  `CREATE TABLE IF NOT EXISTS park_pages (
    account_id TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    updated_at INTEGER,
    updated_by TEXT,
    published_at INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER,
    updated_by TEXT
  )`,
  // MCP clients (registered by themselves) and their pending authorizations (see mcp-auth.ts).
  `CREATE TABLE IF NOT EXISTS mcp_clients (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    redirect_uris TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS mcp_requests (
    id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    redirect_uri TEXT NOT NULL,
    state TEXT,
    challenge TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    code_hash TEXT,
    token TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS mcp_requests_code ON mcp_requests(code_hash)`,
  // Old rows used the Italian name for changes made outside Dash++.
  `UPDATE changes SET source = 'external' WHERE source = 'esterno'`,
];

let ready: Promise<unknown> | null = null;

export function ensureSchema(db: D1Database) {
  ready ??= db.batch(SCHEMA.map((s) => db.prepare(s))).catch((e) => {
    ready = null;
    throw e;
  });
  return ready;
}

export const now = () => Date.now();
