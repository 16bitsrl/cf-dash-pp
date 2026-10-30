import { CfApi, CfError, type Zone } from "./lib/cf";
import { now } from "./lib/db";
import { dohResolver } from "./lib/doh";
import { analyzeMail, type MailReport, type Resolver } from "./lib/mail";
import { diffRecords, isWholeDomain, LEGACY_PARK_PREFIX, PARK_WORKER, parkingState, parseRedirects, servedBy, slimRecord, zoneUsage, type CustomDomain, type Parking, type Rec, type Redirect, type Route, type RulesetRule, type ServedBy, type Usage } from "./lib/zone-state";

export const REDIRECT_PHASE = "http_request_dynamic_redirect";

export type { Usage };

export type ZoneData = {
  zone: Zone;
  records: Rec[];
  routes: Route[];
  routesError?: string;
  customDomains: CustomDomain[];
  customDomainsError?: string;
  servedBy: ServedBy[];
  ruleset: { id: string; rules: RulesetRule[] } | null;
  rulesetError?: string;
  parking: Parking;
  redirects: Redirect[];
  usage: Usage;
};

const denied = (e: unknown) => (e instanceof CfError && e.forbidden ? "forbidden" : "cloudflare");

export async function loadZone(api: CfApi, zoneId: string): Promise<ZoneData> {
  const [zone, records, routesRes, rulesetRes] = await Promise.all([
    api.req<Zone>("GET", `/zones/${zoneId}`),
    api.all<Rec>(`/zones/${zoneId}/dns_records`, 500),
    api.req<Route[]>("GET", `/zones/${zoneId}/workers/routes`).then(
      (r) => ({ ok: r }),
      (e) => ({ err: denied(e) }),
    ),
    api.req<{ id: string; rules?: RulesetRule[] }>("GET", `/zones/${zoneId}/rulesets/phases/${REDIRECT_PHASE}/entrypoint`).then(
      (r) => ({ ok: { id: r.id, rules: r.rules ?? [] } }),
      (e) => (e instanceof CfError && e.notFound ? { ok: null } : { err: denied(e) }),
    ),
  ]);
  const routes = "ok" in routesRes ? routesRes.ok : [];
  const ruleset = ("ok" in rulesetRes ? rulesetRes.ok : null) ?? null;
  // Workers Custom Domains: their DNS record is not in the records API.
  const domainsRes = await api.req<CustomDomain[]>("GET", `/accounts/${zone.account.id}/workers/domains?zone_id=${zoneId}`).then(
    (r) => ({ ok: r.map((d) => ({ hostname: d.hostname, service: d.service })) }),
    (e) => ({ err: denied(e) }),
  );
  const customDomains = "ok" in domainsRes ? domainsRes.ok : [];
  const parking = parkingState(zone.name, records, routes);
  const redirects = parseRedirects(zone.name, ruleset?.rules ?? []);
  const incomplete = "err" in routesRes || "err" in domainsRes;
  return {
    zone,
    records,
    routes,
    routesError: "err" in routesRes ? routesRes.err : undefined,
    customDomains,
    customDomainsError: "err" in domainsRes ? domainsRes.err : undefined,
    servedBy: servedBy(zone.name, routes, customDomains),
    ruleset,
    rulesetError: "err" in rulesetRes ? rulesetRes.err : undefined,
    parking,
    redirects,
    usage: zoneUsage({ zone: zone.name, records, routes, customDomains, parking, redirects, incomplete }),
  };
}

export type ParkStatus = { published: boolean; legacy: string[] } | null;

/** Whether the Dash++ parking Worker exists in the account, and which old parking Workers are left. */
export async function parkStatus(api: CfApi, accountId: string): Promise<ParkStatus> {
  try {
    const ids = (await api.req<{ id: string }[]>("GET", `/accounts/${accountId}/workers/scripts`)).map((s) => s.id);
    return { published: ids.includes(PARK_WORKER), legacy: ids.filter((id) => id.startsWith(LEGACY_PARK_PREFIX)) };
  } catch {
    return null;
  }
}

export function mailReport(data: ZoneData, resolver: Resolver = dohResolver()): Promise<MailReport> {
  return analyzeMail(data.zone.name, data.records, resolver);
}

export type SyncSource = { source: "external" | "dash"; actor?: string };

/**
 * Snapshots the zone, records the differences from the previous snapshot and updates the cache
 * used by the lists. The first snapshot records nothing: there is no "before".
 */
export async function syncZone(db: D1Database, api: CfApi, zoneId: string, src: SyncSource, resolver?: Resolver) {
  const data = await loadZone(api, zoneId);
  const mail = await mailReport(data, resolver);
  const records = data.records.map(slimRecord);
  const prev = await db.prepare("SELECT records FROM snapshots WHERE zone_id = ?").bind(zoneId).first<{ records: string }>();
  const t = now();
  const stmts: D1PreparedStatement[] = [];
  let changes = 0;
  if (prev) {
    const d = diffRecords(JSON.parse(prev.records), records);
    const ins = db.prepare(
      "INSERT INTO changes (zone_id, zone_name, account_id, detected_at, kind, record_type, record_name, before, after, source, actor) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    const row = (kind: string, r: Rec, before: Rec | null, after: Rec | null) =>
      ins.bind(zoneId, data.zone.name, data.zone.account.id, t, kind, r.type, r.name, before && JSON.stringify(before), after && JSON.stringify(after), src.source, src.actor ?? null);
    for (const r of d.added) stmts.push(row("added", r, null, r));
    for (const r of d.removed) stmts.push(row("removed", r, r, null));
    for (const x of d.changed) stmts.push(row("changed", x.after, x.before, x.after));
    changes = stmts.length;
  }
  stmts.push(
    db.prepare("INSERT INTO snapshots (zone_id, records, taken_at) VALUES (?, ?, ?) ON CONFLICT(zone_id) DO UPDATE SET records = excluded.records, taken_at = excluded.taken_at").bind(zoneId, JSON.stringify(records), t),
    db
      .prepare(
        `INSERT INTO zones (id, name, account_id, status, synced_at, record_count, usage, parking, redirect_target, redirects, mail_mode, mail_provider, mail_errors, mail_warnings, mail_checks, last_change_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, account_id = excluded.account_id, status = excluded.status, synced_at = excluded.synced_at,
           record_count = excluded.record_count, usage = excluded.usage, parking = excluded.parking, redirect_target = excluded.redirect_target,
           redirects = excluded.redirects, mail_mode = excluded.mail_mode, mail_provider = excluded.mail_provider, mail_errors = excluded.mail_errors,
           mail_warnings = excluded.mail_warnings, mail_checks = excluded.mail_checks,
           last_change_at = COALESCE(excluded.last_change_at, zones.last_change_at)`,
      )
      .bind(
        zoneId,
        data.zone.name,
        data.zone.account.id,
        data.zone.status,
        t,
        records.length,
        data.usage,
        data.parking.state,
        data.redirects.find((r) => isWholeDomain(data.zone.name, r))?.target ?? data.servedBy.find((x) => x.host === data.zone.name.toLowerCase())?.worker ?? data.servedBy[0]?.worker ?? null,
        data.redirects.length,
        mail.mode,
        mail.provider?.name ?? null,
        mail.total.errors,
        mail.total.warnings,
        JSON.stringify(
          [mail, ...mail.subdomains]
            .flatMap((m) => m.checks)
            .filter((c) => c.level === "error" || c.level === "warning")
            .map((c) => ({ id: c.id, level: c.level, params: c.params, name: c.name })),
        ),
        changes ? t : null,
      ),
  );
  await db.batch(stmts);
  return { data, mail, changes };
}

/** Runs fn on every item, at most n at a time. */
export async function pool<T, R>(items: T[], n: number, fn: (item: T) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  const out: PromiseSettledResult<R>[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k]).then(
          (value) => ({ status: "fulfilled", value }) as const,
          (reason) => ({ status: "rejected", reason }) as const,
        );
      }
    }),
  );
  return out;
}

/** Background sync: every zone of each account, read with that account's token. */
export async function syncAll(db: D1Database, accounts: { id: string; token: string }[]) {
  const run = await db.prepare("INSERT INTO sync_runs (started_at) VALUES (?) RETURNING id").bind(now()).first<{ id: number }>();
  let zones = 0;
  let changes = 0;
  const failed: string[] = [];
  const resolver = dohResolver();
  for (const acc of accounts) {
    const api = new CfApi(acc.token);
    try {
      const list = await api.all<Zone>(`/zones?account.id=${encodeURIComponent(acc.id)}`, 50);
      const res = await pool(list, 6, (z) => syncZone(db, api, z.id, { source: "external" }, resolver));
      zones += list.length;
      changes += res.reduce((n, r) => n + (r.status === "fulfilled" ? r.value.changes : 0), 0);
      const bad = res.filter((r) => r.status === "rejected").length;
      if (bad) failed.push(`${acc.id}: ${bad} zones not read`);
    } catch (e) {
      failed.push(`${acc.id}: ${String(e)}`);
    }
  }
  await db.prepare("UPDATE sync_runs SET finished_at = ?, zones = ?, changes = ?, error = ? WHERE id = ?").bind(now(), zones, changes, failed.join("; ") || null, run!.id).run();
}
