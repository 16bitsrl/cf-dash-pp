// Changes to DNS records, as in the dashboard's DNS > Records. A record is changed or deleted only
// in the version the user saw: if it changed since, nothing happens and the app says so.

import { Conflict, type Done } from "./actions";
import { CfError, type CfApi } from "./lib/cf";
import { cfRecordError, IMPORT_MAX_BYTES, parseZoneFile, recordChanges, recordValue, validateRecord, type RecordInput } from "./lib/dns";
import type { Rec } from "./lib/zone-state";
import type { ZoneData } from "./services";

/** Cloudflare's refusals of a record, as codes the app explains. */
async function dns<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (e) {
    const known = e instanceof CfError && !e.forbidden && cfRecordError(e.errors);
    if (known) throw new Conflict(known.code, known.params);
    throw e;
  }
}

function valid(data: ZoneData, input: RecordInput) {
  const r = validateRecord(data.zone.name, input);
  if ("error" in r) throw new Conflict(r.error.code, r.error.params);
  return r.body;
}

/** The record as the user saw it: still there, still the same, and not managed by Cloudflare. */
function seen(data: ZoneData, id: string, modifiedOn: unknown) {
  const r = data.records.find((x) => x.id === id);
  if (!r) throw new Conflict("record-not-found");
  if (r.meta?.read_only) throw new Conflict("record-read-only", { name: r.name });
  if (r.modified_on !== modifiedOn) throw new Conflict("record-changed", { name: r.name });
  return r;
}

const label = (r: Rec) => `${r.type} ${recordValue(r)}`;

export async function addRecord(api: CfApi, data: ZoneData, input: RecordInput): Promise<Done[]> {
  const rec = await dns(api.req<Rec>("POST", `/zones/${data.zone.id}/dns_records`, valid(data, input)));
  return [{ op: "record.add", name: rec.name, value: label(rec) }];
}

export async function updateRecord(api: CfApi, data: ZoneData, id: string, input: RecordInput, modifiedOn: unknown): Promise<Done[]> {
  const before = seen(data, id, modifiedOn);
  const body = valid(data, input);
  if (body.type !== before.type) throw new Conflict("record-type-change");
  const changes = recordChanges(before, body);
  if (!changes.length) return [];
  const after = await dns(api.req<Rec>("PATCH", `/zones/${data.zone.id}/dns_records/${id}`, body));
  return [{ op: "record.update", name: after.name, value: `${label(before)} → ${label(after)}`, changes: changes.map((c) => `${c.field}: ${c.before} → ${c.after}`).join("; ") }];
}

const BATCH = 200;

export async function deleteRecords(api: CfApi, data: ZoneData, items: { id?: unknown; modifiedOn?: unknown }[]): Promise<Done[]> {
  const ids = [...new Set(items.map((i) => String(i.id ?? "")))];
  if (!ids.length) throw new Conflict("records-none");
  const recs = ids.map((id) => seen(data, id, items.find((i) => String(i.id) === id)!.modifiedOn));
  if (recs.length === 1) await dns(api.req("DELETE", `/zones/${data.zone.id}/dns_records/${recs[0].id}`));
  // Many at once in a single change (in groups, beyond what one call takes).
  else for (let i = 0; i < recs.length; i += BATCH) await dns(api.req("POST", `/zones/${data.zone.id}/dns_records/batch`, { deletes: recs.slice(i, i + BATCH).map((r) => ({ id: r.id })) }));
  return recs.map((r) => ({ op: "record.remove", name: r.name, value: label(r) }));
}

/** Imports a BIND zone file. Cloudflare only adds records: it never replaces existing ones. */
export async function importRecords(api: CfApi, data: ZoneData, file: string, proxied: boolean): Promise<Done[]> {
  if (new TextEncoder().encode(file).length > IMPORT_MAX_BYTES) throw new Conflict("import-too-large", { max: IMPORT_MAX_BYTES / 1024 });
  if (!parseZoneFile(file, data.zone.name).records.length) throw new Conflict("import-empty");
  const form = new FormData();
  form.append("file", new File([file], "zone.txt", { type: "text/plain" }));
  form.append("proxied", String(proxied));
  const { result, messages } = await api.formWithMessages<{ recs_added: number; total_records_parsed: number }>("POST", `/zones/${data.zone.id}/dns_records/import`, form).catch((e) => {
    // A line Cloudflare can't read: it refuses the whole file.
    const unreadable = e instanceof CfError && e.errors.find((x) => x.code === 9209);
    if (unreadable) throw new Conflict("import-invalid", { message: unreadable.message });
    return dns(Promise.reject(e));
  });
  const had = new Set(data.records.map((r) => r.id));
  const added = (await api.all<Rec>(`/zones/${data.zone.id}/dns_records`, 500)).filter((r) => !had.has(r.id));
  return [
    { op: "record.import", value: `${result.recs_added}/${result.total_records_parsed}` },
    ...added.map((r) => ({ op: "record.add", name: r.name, value: label(r) })),
    // Records Cloudflare left out, with the reason: "name: message".
    ...messages.map((m) => ({ op: "record.skip", name: m.message.match(/^([^\s:]+):/)?.[1] ?? "", value: cfRecordError([m])?.code ?? "record-invalid" })),
  ];
}

type Dnssec = Record<string, unknown> & { status: string };

/** What the DNS tab shows next to the records. Each part says on its own if it can't be read. */
export async function dnsSettings(api: CfApi, zoneId: string) {
  const why = (e: unknown) => (e instanceof CfError && e.forbidden ? "forbidden" : "cloudflare");
  const [zone, dnssec, settings] = await Promise.all([
    api.req<{ name_servers?: string[]; plan?: { name: string } }>("GET", `/zones/${zoneId}`),
    api.req<Dnssec>("GET", `/zones/${zoneId}/dnssec`).then(
      (r) => ({ ok: Object.fromEntries(Object.entries(r).filter(([, v]) => v !== null && v !== undefined)) as Dnssec }),
      (e) => ({ err: why(e) }),
    ),
    api.req<{ flatten_all_cnames?: boolean }>("GET", `/zones/${zoneId}/dns_settings`).then(
      (r) => ({ ok: !!r.flatten_all_cnames }),
      (e) => ({ err: why(e) }),
    ),
  ]);
  return {
    nameServers: zone.name_servers ?? [],
    plan: zone.plan?.name ?? null,
    dnssec: "ok" in dnssec ? dnssec.ok : null,
    dnssecError: "err" in dnssec ? dnssec.err : null,
    flattenAllCnames: "ok" in settings ? settings.ok : null,
    settingsError: "err" in settings ? settings.err : null,
  };
}

export async function setDnssec(api: CfApi, zoneId: string, enable: boolean): Promise<Done[]> {
  await api.req("PATCH", `/zones/${zoneId}/dnssec`, { status: enable ? "active" : "disabled" });
  return [{ op: enable ? "dnssec.enable" : "dnssec.disable" }];
}

export async function setFlattenAll(api: CfApi, zoneId: string, on: boolean): Promise<Done[]> {
  await api.req("PATCH", `/zones/${zoneId}/dns_settings`, { flatten_all_cnames: on }).catch((e) => {
    if (e instanceof CfError && e.errors.some((x) => /flattening is not available/i.test(x.message))) throw new Conflict("flatten-all-unavailable");
    throw e;
  });
  return [{ op: "dns.flatten-all", value: on ? "on" : "off" }];
}
