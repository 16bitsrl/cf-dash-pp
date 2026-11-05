// Changes on Cloudflare. An existing record is never overwritten silently: if a name is
// already used by something else, the action stops and says why.
// Errors and results are codes with params; the client turns them into text.

import type { CfApi } from "./lib/cf";
import type { FixId, MailReport, NameReport } from "./lib/mail";
import { reportFor, txtValue } from "./lib/mail";
import { dmarcTags, dmarcValue, MX_PRESET_INCLUDE, mxPreset, proposeSpf, SENDERS, type MxPreset } from "./lib/senders";
import { isParkScript, isWholeDomain, PARK_ADDRESS, PARK_WORKER, redirectHosts, redirectRule, routeCovers, type Rec, type Redirect, type RedirectInput } from "./lib/zone-state";
import { REDIRECT_PHASE, type ZoneData } from "./services";

export type Params = Record<string, string | number>;

export class Conflict extends Error {
  constructor(
    public code: string,
    public params: Params = {},
  ) {
    super(code);
  }
}

/** One thing an action did, e.g. { op: "record.add", name: "www.example.com" }. */
export type Done = { op: string; name?: string; value?: string; changes?: string };

const lower = (s: string) => s.toLowerCase().replace(/\.$/, "");
const COMMENT = "Dash++";

const createRecord = (api: CfApi, zoneId: string, r: Partial<Rec>) => api.req<Rec>("POST", `/zones/${zoneId}/dns_records`, { ttl: 1, comment: COMMENT, ...r });

async function ensurePlaceholder(api: CfApi, data: ZoneData, host: string, done: Done[]) {
  const existing = data.records.filter((r) => lower(r.name) === host && ["A", "AAAA", "CNAME"].includes(r.type));
  if (existing.some((r) => r.proxied)) return;
  if (existing.length) throw new Conflict("host-taken", { host, target: existing.map((r) => r.content).join(", ") });
  await createRecord(api, data.zone.id, { type: "A", name: host, content: PARK_ADDRESS, proxied: true });
  done.push({ op: "record.add", name: host });
}

const hostsOf = (zone: string) => [lower(zone), `www.${lower(zone)}`];

/** Workers (other than parking) that answer on a host, through a route or a Custom Domain. */
function workersOn(data: ZoneData, host: string) {
  return [
    ...(data.customDomains ?? []).filter((d) => lower(d.hostname) === host).map((d) => d.service),
    ...data.routes.filter((r) => r.script && !isParkScript(r.script) && routeCovers(r.pattern, host)).map((r) => r.script!),
  ];
}
const routeFor = (data: ZoneData, host: string) => data.routes.find((r) => lower(r.pattern) === `${host}/*`);

export async function enableParking(api: CfApi, data: ZoneData, protectMail: boolean, mail: MailReport) {
  const workers = hostsOf(data.zone.name).flatMap((h) => workersOn(data, h));
  if (workers.length) throw new Conflict("served-by-worker", { worker: [...new Set(workers)].join(", ") });
  const live = data.redirects.find((r) => isWholeDomain(data.zone.name, r));
  if (live) throw new Conflict("has-redirect", { target: live.target });

  const done: Done[] = [];
  for (const host of hostsOf(data.zone.name)) {
    await ensurePlaceholder(api, data, host, done);
    const route = routeFor(data, host);
    if (!route) {
      await api.req("POST", `/zones/${data.zone.id}/workers/routes`, { pattern: `${host}/*`, script: PARK_WORKER });
      done.push({ op: "route.add", name: `${host}/*` });
    } else if (route.script !== PARK_WORKER) {
      await api.req("PUT", `/zones/${data.zone.id}/workers/routes/${route.id}`, { pattern: route.pattern, script: PARK_WORKER });
      done.push({ op: "route.migrate", name: route.pattern });
    }
  }
  if (protectMail && mail.mode === "none") done.push(...(await protectNoMail(api, data, mail)));
  return done;
}

export async function disableParking(api: CfApi, data: ZoneData, removeRecords: boolean) {
  const done: Done[] = [];
  for (const r of data.parking.routes) {
    if (!hostsOf(data.zone.name).some((h) => lower(r.pattern) === `${h}/*`)) continue;
    await api.req("DELETE", `/zones/${data.zone.id}/workers/routes/${r.id}`);
    done.push({ op: "route.remove", name: r.pattern });
  }
  if (removeRecords) done.push(...(await removePlaceholders(api, data, hostsOf(data.zone.name))));
  return done;
}

async function removePlaceholders(api: CfApi, data: ZoneData, hosts: string[]) {
  const done: Done[] = [];
  for (const r of data.records) {
    if (r.type === "A" && r.content === PARK_ADDRESS && hosts.includes(lower(r.name))) {
      await api.req("DELETE", `/zones/${data.zone.id}/dns_records/${r.id}`);
      done.push({ op: "record.remove", name: r.name });
    }
  }
  return done;
}

function checkTarget(data: ZoneData, input: RedirectInput) {
  let url: URL;
  try {
    url = new URL(input.target);
  } catch {
    throw new Conflict("target-invalid");
  }
  if (!/^https?:$/.test(url.protocol)) throw new Conflict("target-invalid");
  // Sending a name to itself without a path would loop.
  if (!input.path && redirectHosts(data.zone.name, input).includes(url.hostname.toLowerCase())) throw new Conflict("target-self");
}

/** Normalises where the redirect starts from and checks it belongs to the zone. */
function normalise(data: ZoneData, input: RedirectInput): RedirectInput {
  const z = lower(data.zone.name);
  let host = lower((input.host ?? "").trim() || z);
  if (host !== z && !host.endsWith(`.${z}`)) host = /^[a-z0-9*-]+(\.[a-z0-9-]+)*$/.test(host) && !host.includes(".") ? `${host}.${z}` : host;
  if (host !== z && !host.endsWith(`.${z}`)) throw new Conflict("host-invalid", { zone: z });
  let path = (input.path ?? "").trim() || null;
  if (path && !path.startsWith("/")) path = `/${path}`;
  if (path && /[\s"]/.test(path)) throw new Conflict("path-invalid");
  return { ...input, host, path, pathPrefix: !!path && !!input.pathPrefix, includeWww: host === z && input.includeWww };
}

const sameSource = (r: Redirect, hosts: string[], input: RedirectInput) => r.enabled && (r.path ?? null) === (input.path ?? null) && r.hosts.some((h) => hosts.includes(h));

const parkedHost = (data: ZoneData, host: string) => data.parking.state !== "off" && hostsOf(data.zone.name).includes(host);

export async function addRedirect(api: CfApi, data: ZoneData, raw: RedirectInput) {
  const input = normalise(data, raw);
  checkTarget(data, input);
  const hosts = redirectHosts(data.zone.name, input);
  // A parked domain can still redirect subdomains and single paths, not every address.
  if (!input.path && hosts.some((h) => parkedHost(data, h))) throw new Conflict("is-parked");
  const served = input.path ? [] : hosts.flatMap((h) => workersOn(data, h));
  if (served.length) throw new Conflict("served-by-worker", { worker: [...new Set(served)].join(", ") });
  const taken = data.redirects.find((r) => sameSource(r, hosts, input));
  if (taken) throw new Conflict("redirect-exists", { hosts: taken.hosts.join(", ") + (taken.path ?? ""), target: taken.target });

  const done: Done[] = [];
  for (const host of hosts) await ensurePlaceholder(api, data, host, done);
  const rule = redirectRule(data.zone.name, input);
  if (data.ruleset) await api.req("POST", `/zones/${data.zone.id}/rulesets/${data.ruleset.id}/rules`, rule);
  else await api.req("PUT", `/zones/${data.zone.id}/rulesets/phases/${REDIRECT_PHASE}/entrypoint`, { rules: [rule] });
  done.push({ op: "redirect.add", name: hosts.join(", ") + (input.path ?? ""), value: input.target });
  return done;
}

/** Replaces a redirect rule with new settings. Works on any redirect, whoever created it. */
export async function updateRedirect(api: CfApi, data: ZoneData, ruleId: string, raw: RedirectInput) {
  const current = data.redirects.find((r) => r.id === ruleId);
  if (!data.ruleset || !current) throw new Conflict("redirect-not-found");
  const input = normalise(data, raw);
  checkTarget(data, input);
  const hosts = redirectHosts(data.zone.name, input);
  if (!input.path && hosts.some((h) => parkedHost(data, h))) throw new Conflict("is-parked");
  const served = input.path ? [] : hosts.flatMap((h) => workersOn(data, h));
  if (served.length) throw new Conflict("served-by-worker", { worker: [...new Set(served)].join(", ") });
  const taken = data.redirects.find((r) => r.id !== ruleId && sameSource(r, hosts, input));
  if (taken) throw new Conflict("redirect-exists", { hosts: taken.hosts.join(", ") + (taken.path ?? ""), target: taken.target });
  const done: Done[] = [];
  for (const host of hosts) await ensurePlaceholder(api, data, host, done);
  const rule = redirectRule(data.zone.name, input);
  await api.req("PATCH", `/zones/${data.zone.id}/rulesets/${data.ruleset.id}/rules/${ruleId}`, { ...rule, description: current.description && !current.description.includes(" → ") ? current.description : rule.description });
  done.push({ op: "redirect.update", name: hosts.join(", ") + (input.path ?? ""), value: input.target });
  return done;
}

export async function deleteRedirect(api: CfApi, data: ZoneData, ruleId: string, removeRecords: boolean) {
  const rule = data.redirects.find((r) => r.id === ruleId);
  if (!data.ruleset || !rule) throw new Conflict("redirect-not-found");
  await api.req("DELETE", `/zones/${data.zone.id}/rulesets/${data.ruleset.id}/rules/${ruleId}`);
  const done: Done[] = [{ op: "redirect.remove", name: rule.hosts.join(", ") + (rule.path ?? ""), value: rule.target }];
  if (removeRecords) {
    // Only placeholders of names nothing else uses: no other redirect, no parking.
    const stillUsed = new Set(data.redirects.filter((r) => r.id !== ruleId).flatMap((r) => r.hosts));
    done.push(...(await removePlaceholders(api, data, rule.hosts.filter((h) => !stillUsed.has(h) && !parkedHost(data, h)))));
  }
  return done;
}

const quote = (v: string) => JSON.stringify(v);

async function upsertTxt(api: CfApi, data: ZoneData, name: string, match: RegExp, value: string): Promise<Done | null> {
  const existing = data.records.filter((r) => r.type === "TXT" && lower(r.name) === name && match.test(txtValue(r.content)));
  if (existing.length > 1) throw new Conflict("duplicate-records", { name, count: existing.length });
  if (existing[0]) {
    if (txtValue(existing[0].content) === value) return null;
    await api.req("PATCH", `/zones/${data.zone.id}/dns_records/${existing[0].id}`, { content: quote(value) });
    return { op: "record.update", name, value };
  }
  await createRecord(api, data.zone.id, { type: "TXT", name, content: quote(value) });
  return { op: "record.add", name, value };
}

/**
 * The domain neither receives nor sends: null MX, SPF "-all" and DMARC "reject", also for the
 * subdomains (sp= and, if the zone has no wildcard records yet, a wildcard SPF for the names that
 * don't exist). Other DMARC tags, like the report address, are kept.
 */
async function protectNoMail(api: CfApi, data: ZoneData, mail: MailReport) {
  if (mail.mode === "mail") throw new Conflict("receives-mail");
  const z = lower(data.zone.name);
  const done: Done[] = [];
  if (!mail.records.mx.length) {
    await createRecord(api, data.zone.id, { type: "MX", name: z, content: ".", priority: 0 });
    done.push({ op: "record.add", name: z, value: "MX ." });
  }
  const dmarc = mail.records.dmarc.length === 1 ? mail.records.dmarc[0] : undefined;
  const dmarcNew = dmarc ? dmarcValue(dmarc, { policy: "reject", ...(dmarcTags(dmarc).sp && { sp: "reject" }) }) : "v=DMARC1; p=reject;";
  for (const d of [await upsertTxt(api, data, z, /^v=spf1(\s|$)/i, "v=spf1 -all"), await upsertTxt(api, data, `_dmarc.${z}`, /^v=DMARC1/i, dmarcNew)]) if (d) done.push(d);
  if (!data.records.some((r) => lower(r.name) === `*.${z}`)) {
    await createRecord(api, data.zone.id, { type: "TXT", name: `*.${z}`, content: quote("v=spf1 -all") });
    done.push({ op: "record.add", name: `*.${z}`, value: "v=spf1 -all" });
  }
  return done;
}

/** A subdomain that neither receives nor sends: null MX and SPF "-all"; its own DMARC, if any, to reject. */
async function protectSubdomain(api: CfApi, data: ZoneData, mail: NameReport) {
  if (mail.mode === "mail") throw new Conflict("receives-mail");
  const n = mail.name;
  const done: Done[] = [];
  if (!mail.records.mx.length) {
    await createRecord(api, data.zone.id, { type: "MX", name: n, content: ".", priority: 0 });
    done.push({ op: "record.add", name: n, value: "MX ." });
  }
  const spf = await upsertTxt(api, data, n, /^v=spf1(\s|$)/i, "v=spf1 -all");
  if (spf) done.push(spf);
  if (mail.records.dmarc.length === 1) {
    const d = await upsertTxt(api, data, `_dmarc.${n}`, /^v=DMARC1/i, dmarcValue(mail.records.dmarc[0], { policy: "reject" }));
    if (d) done.push(d);
  }
  return done;
}

/** The name mail records go on: the apex, or a subdomain that isn't technical or a wildcard. */
function mailName(data: ZoneData, name?: string) {
  const z = lower(data.zone.name);
  const n = lower((name ?? "").trim() || z);
  if (n !== z && (!n.endsWith(`.${z}`) || /^[_*]/.test(n) || n.split(".").some((l) => l.startsWith("_")))) throw new Conflict("name-invalid", { zone: z });
  return n;
}

export type FixOptions = { policy?: "none" | "quarantine" | "reject"; rua?: string; include?: string };

const isSpf = (r: Rec, n: string) => r.type === "TXT" && lower(r.name) === n && /^v=spf1(\s|$)/i.test(txtValue(r.content));

/** Leaves exactly one SPF record with this value on the name. */
async function writeSpf(api: CfApi, data: ZoneData, value: string, z: string): Promise<Done[]> {
  const existing = data.records.filter((r) => isSpf(r, z));
  const done: Done[] = [];
  if (!existing.length) {
    await createRecord(api, data.zone.id, { type: "TXT", name: z, content: quote(value) });
    return [{ op: "record.add", name: z, value }];
  }
  if (txtValue(existing[0].content) !== value) {
    await api.req("PATCH", `/zones/${data.zone.id}/dns_records/${existing[0].id}`, { content: quote(value) });
    done.push({ op: "record.update", name: z, value });
  }
  for (const r of existing.slice(1)) {
    await api.req("DELETE", `/zones/${data.zone.id}/dns_records/${r.id}`);
    done.push({ op: "record.remove", name: `${z} (${txtValue(r.content)})` });
  }
  return done;
}

export async function setSpf(api: CfApi, data: ZoneData, value: string, name?: string) {
  const z = mailName(data, name);
  const v = value.trim().replace(/\s+/g, " ");
  if (!/^v=spf1(\s|$)/i.test(v) || v.length > 450 || /"/.test(v)) throw new Conflict("spf-invalid");
  return writeSpf(api, data, v, z);
}

/** Replaces the MX records of a name with those of a provider, and optionally adds it to SPF. */
export async function setMx(api: CfApi, data: ZoneData, preset: MxPreset, updateSpf: boolean, name?: string) {
  const z = mailName(data, name);
  const target = mxPreset(preset, z);
  const current = data.records.filter((r) => r.type === "MX" && lower(r.name) === z);
  const done: Done[] = [];
  for (const r of current) {
    if (target.some((t) => t.host === lower(r.content) && t.priority === r.priority)) continue;
    await api.req("DELETE", `/zones/${data.zone.id}/dns_records/${r.id}`);
    done.push({ op: "record.remove", name: z, value: `MX ${r.content}` });
  }
  for (const t of target) {
    if (current.some((r) => lower(r.content) === t.host && r.priority === t.priority)) continue;
    await createRecord(api, data.zone.id, { type: "MX", name: z, content: t.host, priority: t.priority });
    done.push({ op: "record.add", name: z, value: `MX ${t.priority} ${t.host}` });
  }
  if (updateSpf) {
    const spf = data.records.filter((r) => isSpf(r, z)).map((r) => txtValue(r.content));
    const include = MX_PRESET_INCLUDE[preset];
    if (preset === "none") done.push(...(await writeSpf(api, data, "v=spf1 -all", z)));
    else if (include) {
      // Mail moves away from the previous provider: it no longer needs to be in SPF.
      const previous = SENDERS.filter((d) => d.mx && d.include && d.include !== include && current.some((r) => d.mx!.test(lower(r.content)))).map((d) => d.include!);
      done.push(...(await writeSpf(api, data, proposeSpf(spf, [include], previous), z)));
    }
  }
  return done;
}

export async function setDmarc(api: CfApi, data: ZoneData, change: { policy: "none" | "quarantine" | "reject"; rua?: string }, target?: string) {
  const n = mailName(data, target);
  if (!["none", "quarantine", "reject"].includes(change.policy)) throw new Conflict("dmarc-invalid-policy");
  if (change.rua && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(change.rua)) throw new Conflict("rua-invalid");
  const name = `_dmarc.${n}`;
  const existing = data.records.filter((r) => r.type === "TXT" && lower(r.name) === name && /^v=DMARC1/i.test(txtValue(r.content)));
  if (existing.length > 1) throw new Conflict("duplicate-records", { name, count: existing.length });
  const value = dmarcValue(existing[0] ? txtValue(existing[0].content) : undefined, change);
  const d = await upsertTxt(api, data, name, /^v=DMARC1/i, value);
  return d ? [d] : [];
}

export async function applyMailFix(api: CfApi, data: ZoneData, report: MailReport, fix: FixId, opts: FixOptions, name?: string): Promise<Done[]> {
  const z = mailName(data, name);
  const mail = reportFor(report, z);
  if (!mail) throw new Conflict("name-invalid", { zone: lower(data.zone.name) });
  if (fix === "protect-no-mail") return z === lower(data.zone.name) ? protectNoMail(api, data, report) : protectSubdomain(api, data, mail);
  if (fix === "add-dmarc") {
    if (mail.records.dmarc.length) throw new Conflict("dmarc-exists");
    const policy = opts.policy && ["none", "quarantine", "reject"].includes(opts.policy) ? opts.policy : "none";
    if (opts.rua && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(opts.rua)) throw new Conflict("rua-invalid");
    const value = `v=DMARC1; p=${policy};${opts.rua ? ` rua=mailto:${opts.rua};` : ""}`;
    await createRecord(api, data.zone.id, { type: "TXT", name: `_dmarc.${z}`, content: quote(value) });
    return [{ op: "record.add", name: `_dmarc.${z}`, value }];
  }
  if (fix === "add-spf-include") {
    const include = String(opts.include ?? "").trim().toLowerCase();
    if (!/^[a-z0-9._-]+\.[a-z]{2,}$/.test(include)) throw new Conflict("spf-invalid");
    return writeSpf(api, data, proposeSpf(mail.records.spf, [include]), z);
  }
  if (fix === "add-spf") {
    if (mail.records.spf.length) throw new Conflict("spf-exists");
    const value = mail.provider?.spf ? `v=spf1 include:${mail.provider.spf} ~all` : "v=spf1 mx ~all";
    await createRecord(api, data.zone.id, { type: "TXT", name: z, content: quote(value) });
    return [{ op: "record.add", name: z, value }];
  }
  throw new Conflict("unknown-fix");
}
