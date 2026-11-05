// Zone state derived from what is really on Cloudflare: records, routes and rules.
// No separate state is stored: if someone changes things by hand or with another tool,
// the next read sees it.

export type Rec = {
  id: string;
  type: string;
  name: string;
  content: string;
  proxied?: boolean;
  proxiable?: boolean;
  ttl?: number;
  priority?: number;
  comment?: string | null;
  tags?: string[];
  data?: Record<string, string | number>;
  settings?: { flatten_cname?: boolean; ipv4_only?: boolean; ipv6_only?: boolean };
  modified_on?: string;
  meta?: { read_only?: boolean; origin_worker_id?: string };
};
export type Route = { id: string; pattern: string; script?: string };

export const PARK_WORKER = "dash-plus-plus-park";
// Workers of the previous parking project, still recognised until they are retired.
export const LEGACY_PARK_PREFIX = "park-";
export const isParkScript = (s?: string) => !!s && (s === PARK_WORKER || s.startsWith(LEGACY_PARK_PREFIX));
export const PARK_ADDRESS = "192.0.2.1";

const lower = (s: string) => s.toLowerCase().replace(/\.$/, "");

export type Parking = { state: "parked" | "partial" | "off"; script: string | null; legacy: boolean; missing: string[]; routes: Route[] };

export function parkingState(zone: string, records: Rec[], routes: Route[]): Parking {
  const z = lower(zone);
  const hosts = [
    { label: "@", name: z },
    { label: "www", name: `www.${z}` },
  ];
  const parkRoutes = routes.filter((r) => isParkScript(r.script));
  const missing: string[] = [];
  let found = 0;
  for (const h of hosts) {
    const route = parkRoutes.find((r) => lower(r.pattern) === `${h.name}/*`);
    const rec = records.find((r) => lower(r.name) === h.name && ["A", "AAAA", "CNAME"].includes(r.type) && r.proxied);
    if (route) found++;
    else missing.push(`route ${h.label}`);
    if (rec) found++;
    else missing.push(`record ${h.label}`);
  }
  const anyRoute = parkRoutes.some((r) => hosts.some((h) => lower(r.pattern) === `${h.name}/*`));
  const state = !anyRoute ? "off" : missing.length ? "partial" : "parked";
  return { state, script: parkRoutes[0]?.script ?? null, legacy: parkRoutes.some((r) => r.script !== PARK_WORKER), missing: state === "off" ? [] : missing, routes: parkRoutes };
}

// What serves the apex and www besides DNS: Workers routes (also with "*") and Workers Custom
// Domains. Custom Domains keep their DNS record hidden from the records API, so they must be read
// on their own, or a domain with a site would look empty.

export type CustomDomain = { hostname: string; service: string };
export type ServedBy = { host: string; worker: string; kind: "route" | "custom-domain" };
export type Usage = "parked" | "parking-partial" | "redirect" | "site" | "empty" | "unknown";

/** Whether a route pattern ("example.com/*", "*.example.com/*", "*example.com/x") covers a host. */
export function routeCovers(pattern: string, host: string) {
  const h = lower(pattern.split("/")[0]);
  if (h.startsWith("*")) return lower(host).endsWith(h.slice(1));
  return h === lower(host);
}

export function servedBy(zone: string, routes: Route[], customDomains: CustomDomain[]): ServedBy[] {
  const out: ServedBy[] = [];
  for (const host of [lower(zone), `www.${lower(zone)}`]) {
    for (const d of customDomains) if (lower(d.hostname) === host) out.push({ host, worker: d.service, kind: "custom-domain" });
    for (const r of routes) if (r.script && !isParkScript(r.script) && routeCovers(r.pattern, host) && !out.some((o) => o.host === host && o.worker === r.script)) out.push({ host, worker: r.script, kind: "route" });
  }
  return out;
}

export function zoneUsage(z: { zone: string; records: Rec[]; routes: Route[]; customDomains: CustomDomain[]; parking: Parking; redirects: Redirect[]; incomplete: boolean }): Usage {
  if (z.parking.state === "parked") return "parked";
  if (z.parking.state === "partial") return "parking-partial";
  const zone = lower(z.zone);
  if (z.redirects.some((r) => isWholeDomain(zone, r))) return "redirect";
  if (servedBy(zone, z.routes, z.customDomains).length) return "site";
  // Any record on the apex or www that isn't the Dash++ placeholder may be a site: better say so than call it empty.
  if (z.records.some((r) => ["A", "AAAA", "CNAME"].includes(r.type) && [zone, `www.${zone}`].includes(lower(r.name)) && r.content !== PARK_ADDRESS)) return "site";
  return z.incomplete ? "unknown" : "empty";
}

// Redirects: rules of the http_request_dynamic_redirect phase (Single Redirects).

export type RulesetRule = {
  id: string;
  description?: string;
  enabled?: boolean;
  action: string;
  expression: string;
  action_parameters?: {
    from_value?: {
      status_code?: number;
      preserve_query_string?: boolean;
      target_url?: { value?: string; expression?: string };
    };
  };
};

export type Redirect = {
  id: string;
  description: string;
  enabled: boolean;
  hosts: string[];
  // Only this path (or everything under it with pathPrefix); null for every address of the hosts.
  path: string | null;
  pathPrefix: boolean;
  target: string;
  status: number;
  preservePath: boolean;
  preserveQuery: boolean;
};

const PATH_EQ = /http\.request\.uri\.path\s+eq\s+"([^"]*)"/;
const PATH_PREFIX = /starts_with\(\s*http\.request\.uri\.path\s*,\s*"([^"]*)"\s*\)/;

export function parseRedirects(zone: string, rules: RulesetRule[]): Redirect[] {
  const z = lower(zone);
  const out: Redirect[] = [];
  for (const rule of rules) {
    if (rule.action !== "redirect") continue;
    const fv = rule.action_parameters?.from_value;
    const hosts = [...rule.expression.matchAll(/"([^"]+)"/g)].map((m) => lower(m[1])).filter((h) => h === z || h.endsWith(`.${z}`));
    const exact = rule.expression.match(PATH_EQ);
    const prefix = rule.expression.match(PATH_PREFIX);
    let target = fv?.target_url?.value ?? "";
    let preservePath = false;
    const expr = fv?.target_url?.expression;
    if (expr) {
      const lit = [...expr.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
      preservePath = /http\.request\.uri\.path/.test(expr);
      target = preservePath ? (lit[0] ?? "") : lit.join("");
    }
    // "https://example.com/" and "https://example.com" are the same destination.
    target = target.replace(/^(https?:\/\/[^/]+)\/$/, "$1");
    out.push({
      id: rule.id,
      description: rule.description ?? "",
      enabled: rule.enabled !== false,
      hosts: [...new Set(hosts)],
      path: prefix?.[1] ?? exact?.[1] ?? null,
      pathPrefix: !!prefix,
      target,
      status: fv?.status_code ?? 301,
      preservePath,
      preserveQuery: !!fv?.preserve_query_string,
    });
  }
  return out;
}

export type RedirectInput = {
  // Name inside the zone the redirect starts from; the zone apex when missing.
  host?: string;
  path?: string | null;
  pathPrefix?: boolean;
  target: string;
  status: 301 | 302 | 307 | 308;
  preservePath: boolean;
  preserveQuery: boolean;
  // Also www, when the redirect starts from the apex.
  includeWww: boolean;
};

/** Names a redirect starts from. */
export function redirectHosts(zone: string, input: Pick<RedirectInput, "host" | "includeWww">) {
  const z = lower(zone);
  const host = lower(input.host || z);
  return host === z && input.includeWww ? [z, `www.${z}`] : [host];
}

/** Whether a redirect sends away the whole domain (every address of the apex). */
export const isWholeDomain = (zone: string, r: Pick<Redirect, "hosts" | "path" | "enabled">) => r.enabled && !r.path && r.hosts.includes(lower(zone));

export function redirectRule(zone: string, input: RedirectInput) {
  const hosts = redirectHosts(zone, input);
  const target = input.target.replace(/\/+$/, "");
  const quoted = JSON.stringify(target);
  const path = input.path || null;
  const pathClause = path ? (input.pathPrefix ? ` and starts_with(http.request.uri.path, ${JSON.stringify(path)})` : ` and http.request.uri.path eq ${JSON.stringify(path)}`) : "";
  return {
    action: "redirect" as const,
    description: `${hosts.join(", ")}${path ? `${path}${input.pathPrefix ? "*" : ""}` : ""} → ${target}`,
    expression: `(http.host in {${hosts.map((h) => JSON.stringify(h)).join(" ")}}${pathClause})`,
    action_parameters: {
      from_value: {
        status_code: input.status,
        preserve_query_string: input.preserveQuery,
        target_url: input.preservePath ? { expression: `concat(${quoted}, http.request.uri.path)` } : { value: /^https?:\/\/[^/]+$/.test(target) ? `${target}/` : target },
      },
    },
  };
}

// Comparison between two snapshots of the records of a zone.

export type RecordDiff = { added: Rec[]; removed: Rec[]; changed: { before: Rec; after: Rec }[] };

const sig = (r: Rec) => JSON.stringify([r.type, lower(r.name), r.content, r.proxied ?? null, r.ttl ?? null, r.priority ?? null]);

export function diffRecords(before: Rec[], after: Rec[]): RecordDiff {
  const b = new Map(before.map((r) => [r.id, r]));
  const a = new Map(after.map((r) => [r.id, r]));
  const added = after.filter((r) => !b.has(r.id));
  const removed = before.filter((r) => !a.has(r.id));
  const changed = after.filter((r) => b.has(r.id) && sig(b.get(r.id)!) !== sig(r)).map((r) => ({ before: b.get(r.id)!, after: r }));
  return { added, removed, changed };
}

export const slimRecord = (r: Rec): Rec => ({
  id: r.id,
  type: r.type,
  name: r.name,
  content: r.content,
  proxied: r.proxied,
  ttl: r.ttl,
  ...(r.priority !== undefined && { priority: r.priority }),
});

export type DisplayRecord = Rec & { key: string; worker?: string };

/**
 * A Workers Custom Domain is one read-only record in the zone, but the Worker answers
 * every visitor: show it as the A and AAAA records people expect. Other records on the
 * same name (MX, TXT...) stay as they are. `worker` is "" when the Worker is unknown.
 */
export function displayRecords(records: Rec[], domains: CustomDomain[]): DisplayRecord[] {
  return records
    .flatMap((r): DisplayRecord[] => {
      const domain = domains.find((d) => lower(d.hostname) === lower(r.name));
      const isWorker = !!r.meta?.origin_worker_id || (!!domain && r.type === "AAAA" && r.content === "100::");
      if (!isWorker) return [{ ...r, key: r.id }];
      return ["A", "AAAA"].map((type) => ({ ...r, type, key: `${r.id}-${type}`, worker: domain?.service ?? "" }));
    })
    .sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
}
