// DNS records as the Cloudflare dashboard edits them: the supported types and their fields,
// validation (the same in the Worker and in the app), old → new comparison, Cloudflare error
// codes, and BIND zone files for import. Errors are codes with params; the app turns them into text.

import type { Rec } from "./zone-state";

export type FieldKind = "int" | "decimal" | "text" | "target" | "hex" | "base64" | "choice";
/** One structured value of a record (the `data` object of the API). */
export type Field = { key: string; kind: FieldKind; min?: number; max?: number; options?: string[]; optional?: boolean; wide?: boolean };
export type TypeSpec = {
  /** Records with a single value: what the value must be. */
  content?: "ipv4" | "ipv6" | "hostname" | "text" | "base64";
  /** Records with structured values. */
  data?: Field[];
  /** A priority outside `data` (MX, URI). */
  priority?: boolean;
  proxiable?: boolean;
  /** The name must start with _service._protocol (SRV). */
  service?: boolean;
};

const u8 = (key: string): Field => ({ key, kind: "int", min: 0, max: 255 });
const u16 = (key: string): Field => ({ key, kind: "int", min: 0, max: 65535 });
const svc: Field[] = [u16("priority"), { key: "target", kind: "target" }, { key: "value", kind: "text", optional: true, wide: true }];
const cert: Field[] = [u8("usage"), u8("selector"), u8("matching_type"), { key: "certificate", kind: "hex", wide: true }];

export const TYPE_SPECS: Record<string, TypeSpec> = {
  A: { content: "ipv4", proxiable: true },
  AAAA: { content: "ipv6", proxiable: true },
  CAA: { data: [u8("flags"), { key: "tag", kind: "choice", options: ["issue", "issuewild", "iodef"] }, { key: "value", kind: "text", wide: true }] },
  CERT: { data: [u16("type"), u16("key_tag"), u8("algorithm"), { key: "certificate", kind: "base64", wide: true }] },
  CNAME: { content: "hostname", proxiable: true },
  DNSKEY: { data: [u16("flags"), u8("protocol"), u8("algorithm"), { key: "public_key", kind: "base64", wide: true }] },
  DS: { data: [u16("key_tag"), u8("algorithm"), u8("digest_type"), { key: "digest", kind: "hex", wide: true }] },
  HTTPS: { data: svc },
  LOC: {
    data: [
      { key: "lat_degrees", kind: "int", min: 0, max: 90 },
      { key: "lat_minutes", kind: "int", min: 0, max: 59 },
      { key: "lat_seconds", kind: "decimal", min: 0, max: 59.999 },
      { key: "lat_direction", kind: "choice", options: ["N", "S"] },
      { key: "long_degrees", kind: "int", min: 0, max: 180 },
      { key: "long_minutes", kind: "int", min: 0, max: 59 },
      { key: "long_seconds", kind: "decimal", min: 0, max: 59.999 },
      { key: "long_direction", kind: "choice", options: ["E", "W"] },
      { key: "altitude", kind: "decimal", min: -100000, max: 42849672.95 },
      { key: "size", kind: "decimal", min: 0, max: 90000000 },
      { key: "precision_horz", kind: "decimal", min: 0, max: 90000000 },
      { key: "precision_vert", kind: "decimal", min: 0, max: 90000000 },
    ],
  },
  MX: { content: "hostname", priority: true },
  NAPTR: {
    data: [u16("order"), u16("preference"), { key: "flags", kind: "text", optional: true }, { key: "service", kind: "text", optional: true }, { key: "regex", kind: "text", optional: true, wide: true }, { key: "replacement", kind: "target" }],
  },
  NS: { content: "hostname" },
  OPENPGPKEY: { content: "base64" },
  PTR: { content: "hostname" },
  SMIMEA: { data: cert },
  SRV: { service: true, data: [u16("priority"), u16("weight"), u16("port"), { key: "target", kind: "target" }] },
  SSHFP: { data: [u8("algorithm"), u8("type"), { key: "fingerprint", kind: "hex", wide: true }] },
  SVCB: { data: svc },
  TLSA: { data: cert },
  TXT: { content: "text" },
  URI: { priority: true, data: [u16("weight"), { key: "target", kind: "text", wide: true }] },
};

export const RECORD_TYPES = Object.keys(TYPE_SPECS);

/** TTL choices of the dashboard, in seconds; 1 is Auto. */
export const TTL_CHOICES = [1, 60, 120, 300, 600, 900, 1800, 3600, 7200, 18000, 43200, 86400];
export const TXT_MAX = 4096;
export const COMMENT_MAX = 500;
export const TAGS_MAX = 20;

export type RecordSettings = { flatten_cname?: boolean; ipv4_only?: boolean; ipv6_only?: boolean };

/** A record as the form edits it. */
export type RecordInput = {
  type: string;
  name: string;
  content: string;
  data: Record<string, string | number>;
  priority?: number | string;
  proxied: boolean;
  ttl: number;
  comment: string;
  tags: string[];
  settings: RecordSettings;
};

/** A record as Cloudflare takes it. */
export type RecordBody = {
  type: string;
  name: string;
  content?: string;
  data?: Record<string, string | number>;
  priority?: number;
  proxied?: boolean;
  ttl: number;
  comment: string;
  tags: string[];
  settings?: RecordSettings;
};

export type Invalid = { code: string; params: Record<string, string | number> };

export const emptyInput = (type = "A"): RecordInput => ({ type, name: "", content: "", data: {}, priority: TYPE_SPECS[type]?.priority ? 10 : undefined, proxied: false, ttl: 1, comment: "", tags: [], settings: {} });

const lower = (s: string) => s.toLowerCase().replace(/\.$/, "");
const LABEL = /^[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?$/;

/** International names in their ASCII form, as Cloudflare keeps them. */
function ascii(s: string) {
  if (!/[^\x00-\x7f]/.test(s)) return s;
  try {
    return new URL(`http://${s}`).hostname;
  } catch {
    return null;
  }
}

/** Full record name from what was typed: "@", "www", "www.example.com." */
export function normalizeName(zone: string, raw: string) {
  const z = lower(zone);
  let n: string | null = lower(String(raw ?? "").trim());
  if (!n || n === "@") return z;
  n = ascii(n);
  if (!n) return null;
  if (n !== z && !n.endsWith(`.${z}`)) n = `${n}.${z}`;
  if (n.length > 253) return null;
  return n.split(".").every((l, i) => LABEL.test(l) || (l === "*" && i === 0)) ? n : null;
}

/** Name relative to the zone, "@" for the apex. */
export function relativeName(zone: string, name: string) {
  const z = lower(zone);
  const n = lower(name);
  return n === z ? "@" : n.endsWith(`.${z}`) ? n.slice(0, -z.length - 1) : n;
}

const isIpv4 = (s: string) => /^((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/.test(s);
function isIpv6(s: string) {
  if (!s.includes(":") || /[^0-9a-f:.]/i.test(s)) return false;
  try {
    new URL(`http://[${s}]`);
    return true;
  } catch {
    return false;
  }
}
/** A host outside the zone (content of CNAME, MX, NS...), without the final dot. */
function host(raw: string, root = false) {
  const s = String(raw ?? "").trim().toLowerCase();
  if (root && s === ".") return ".";
  const h = ascii(s.replace(/\.$/, ""));
  if (!h || h.length > 253) return null;
  return h.split(".").every((l, i) => LABEL.test(l) || (l === "*" && i === 0)) ? h : null;
}

const ok = (body: RecordBody) => ({ body });
const fail = (code: string, params: Invalid["params"] = {}) => ({ error: { code, params } });

function field(f: Field, raw: unknown): { value: string | number } | null {
  const s = String(raw ?? "").trim();
  if (!s) return f.optional ? { value: "" } : null;
  switch (f.kind) {
    case "int":
    case "decimal": {
      if (!(f.kind === "int" ? /^-?\d+$/ : /^-?\d+(\.\d+)?$/).test(s)) return null;
      const n = Number(s);
      return n >= (f.min ?? -Infinity) && n <= (f.max ?? Infinity) ? { value: n } : null;
    }
    case "choice":
      return f.options!.includes(s) ? { value: s } : null;
    case "target": {
      const h = host(s, true);
      return h ? { value: h } : null;
    }
    case "hex": {
      const v = s.replace(/\s+/g, "");
      return /^[0-9a-f]+$/i.test(v) ? { value: v } : null;
    }
    case "base64": {
      const v = s.replace(/\s+/g, "");
      return /^[A-Za-z0-9+/]+=*$/.test(v) ? { value: v } : null;
    }
    default:
      return /[\r\n]/.test(s) ? null : { value: s };
  }
}

export function validateRecord(zone: string, input: RecordInput): { body: RecordBody } | { error: Invalid } {
  const type = String(input.type ?? "").toUpperCase();
  const spec = TYPE_SPECS[type];
  if (!spec) return fail("record-type-invalid");
  const name = normalizeName(zone, input.name);
  if (!name) return fail("record-name-invalid", { zone: lower(zone) });
  if (spec.service && !/^_[^.]+\._[^.]+(\.|$)/.test(name)) return fail("record-srv-name");
  const body: RecordBody = { type, name, ttl: 1, comment: "", tags: [] };

  if (spec.content) {
    const raw = String(input.content ?? "").trim();
    if (!raw) return fail("record-content-required");
    if (spec.content === "ipv4") {
      if (!isIpv4(raw)) return fail("record-ipv4-invalid");
      body.content = raw;
    } else if (spec.content === "ipv6") {
      if (!isIpv6(raw)) return fail("record-ipv6-invalid");
      body.content = raw.toLowerCase();
    } else if (spec.content === "hostname") {
      const h = host(raw, type === "MX");
      if (!h) return fail("record-hostname-invalid");
      if (type === "CNAME" && h === name) return fail("record-cname-self");
      body.content = h;
    } else if (spec.content === "base64") {
      const v = field({ key: "content", kind: "base64" }, raw);
      if (!v) return fail("record-base64-invalid");
      body.content = String(v.value);
    } else {
      if (raw.length > TXT_MAX) return fail("record-text-too-long", { max: TXT_MAX });
      body.content = raw;
    }
  }
  if (spec.data) {
    const data: Record<string, string | number> = {};
    for (const f of spec.data) {
      const v = field(f, input.data?.[f.key]);
      if (!v) return fail("record-field-invalid", { field: f.key });
      if (v.value !== "") data[f.key] = v.value;
    }
    body.data = data;
  }
  if (spec.priority) {
    const p = String(input.priority ?? "").trim();
    if (!/^\d+$/.test(p) || Number(p) > 65535) return fail("record-priority-invalid");
    body.priority = Number(p);
  }
  if (spec.proxiable) body.proxied = !!input.proxied;

  // Proxied records always have the automatic TTL.
  const ttl = Number(input.ttl ?? 1);
  if (!body.proxied && ttl !== 1 && !(Number.isInteger(ttl) && ttl >= 30 && ttl <= 86400)) return fail("record-ttl-invalid");
  body.ttl = body.proxied ? 1 : ttl;

  const comment = String(input.comment ?? "").trim();
  if (/[\r\n]/.test(comment) || comment.length > COMMENT_MAX) return fail("record-comment-invalid", { max: COMMENT_MAX });
  body.comment = comment;

  const tags = [...new Set((input.tags ?? []).map((t) => String(t).trim()).filter(Boolean))];
  if (tags.length > TAGS_MAX) return fail("record-tags-too-many", { max: TAGS_MAX });
  for (const tag of tags) {
    const [n, ...rest] = tag.split(":");
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(n) || rest.join(":").length > 100 || /[\r\n]/.test(tag)) return fail("record-tag-invalid", { tag });
  }
  body.tags = tags;

  const s = input.settings ?? {};
  // Flattening a single CNAME: not at the apex and not when proxied (both are always flattened).
  if (type === "CNAME" && s.flatten_cname !== undefined && !body.proxied && name !== lower(zone)) body.settings = { flatten_cname: !!s.flatten_cname };
  // IPv4 or IPv6 only: what Cloudflare answers for a proxied name.
  if ((type === "A" || type === "AAAA") && body.proxied && (s.ipv4_only !== undefined || s.ipv6_only !== undefined)) {
    if (s.ipv4_only && s.ipv6_only) return fail("record-ip-only-both");
    body.settings = { ipv4_only: !!s.ipv4_only, ipv6_only: !!s.ipv6_only };
  }
  return ok(body);
}

/** The form of an existing record. */
export function inputFromRecord(zone: string, r: Rec): RecordInput {
  const spec = TYPE_SPECS[r.type];
  return {
    type: r.type,
    name: relativeName(zone, r.name),
    content: spec?.content ? r.content : "",
    data: Object.fromEntries(Object.entries(r.data ?? {}).map(([k, v]) => [k, String(v)])),
    priority: r.priority,
    proxied: !!r.proxied,
    ttl: r.ttl ?? 1,
    comment: r.comment ?? "",
    tags: r.tags ?? [],
    settings: { ...r.settings },
  };
}

export type FieldChange = { field: string; before: string; after: string };

/** What an edit changes, field by field, as text. */
export function recordChanges(before: Rec, body: RecordBody): FieldChange[] {
  const spec = TYPE_SPECS[body.type] ?? {};
  const out: FieldChange[] = [];
  const add = (field: string, b: unknown, a: unknown, loose = false) => {
    const x = String(b ?? "");
    const y = String(a ?? "");
    if (loose ? x.toLowerCase().replace(/\.$/, "") !== y.toLowerCase().replace(/\.$/, "") : x !== y) out.push({ field, before: x, after: y });
  };
  add("name", lower(before.name), body.name);
  if (body.type !== before.type) add("type", before.type, body.type);
  if (spec.content) add("content", before.content, body.content, spec.content !== "text" && spec.content !== "base64");
  for (const f of spec.data ?? []) add(f.key, before.data?.[f.key], body.data?.[f.key], f.kind === "hex" || f.kind === "target");
  if (spec.priority) add("priority", before.priority, body.priority);
  if (spec.proxiable) add("proxied", !!before.proxied, !!body.proxied);
  add("ttl", before.ttl ?? 1, body.ttl);
  add("comment", before.comment ?? "", body.comment);
  add("tags", [...(before.tags ?? [])].sort().join(", "), [...body.tags].sort().join(", "));
  for (const [k, v] of Object.entries(body.settings ?? {})) add(k, !!before.settings?.[k as keyof RecordSettings], !!v);
  return out;
}

/** Value of a record in one line, as the dashboard shows it. */
export function recordValue(r: Pick<Rec, "type" | "content" | "priority" | "data">) {
  const spec = TYPE_SPECS[r.type];
  const content = r.content || (spec?.data ?? []).map((f) => r.data?.[f.key] ?? "").filter((v) => v !== "").join(" ");
  // MX and URI keep the priority apart; so does SRV in the records Cloudflare returns.
  const withPriority = (spec?.priority || (r.type === "SRV" && !!r.content)) && r.priority !== undefined && r.priority !== null;
  return withPriority ? `${r.priority} ${content}` : content;
}

/** "MX example.com 10 mx.example.net": a record in lists and in the history of actions. */
export const recordLabel = (r: Pick<Rec, "type" | "name" | "content" | "priority" | "data">) => `${r.type} ${lower(r.name)} ${recordValue(r)}`;

/** Cloudflare's answer to a record change, as a code the app can explain. Null if it isn't about the record. */
export function cfRecordError(errors: { code: number; message: string }[]): Invalid | null {
  for (const e of errors) {
    if (e.code === 81057 || e.code === 81058) return { code: "record-duplicate", params: {} };
    if (e.code >= 81053 && e.code <= 81056) return { code: "record-host-taken", params: {} };
    if (e.code === 9300) return { code: "record-tags-unavailable", params: {} };
    if (e.code === 9226) return { code: "record-flatten-unavailable", params: {} };
    if (e.code === 9227) return { code: "record-ip-only-unavailable", params: {} };
    if (e.code === 9313) return { code: "record-comment-too-long", params: { max: Number(e.message.match(/(\d+) char/)?.[1] ?? 100) } };
    if (e.code === 9004) return { code: "record-not-proxiable", params: {} };
    if (e.code === 81044) return { code: "record-not-found", params: {} };
  }
  const e = errors.find((x) => x.code === 1004 || (x.code >= 9000 && x.code < 10000) || (x.code >= 81000 && x.code < 82000));
  return e ? { code: "record-invalid", params: { message: e.message } } : null;
}

// --- Zone files ---

export type ParsedRecord = { line: number; type: string; name: string; content: string; ttl: number; priority?: number; proxied?: boolean };
export const IMPORT_MAX_BYTES = 256 * 1024;

const TTL_UNITS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 };
function parseTtl(s: string) {
  if (/^\d+$/.test(s)) return Number(s);
  const parts = s.toLowerCase().match(/^(\d+[smhdw])+$/) ? s.toLowerCase().match(/\d+[smhdw]/g)! : null;
  return parts ? parts.reduce((n, p) => n + Number(p.slice(0, -1)) * TTL_UNITS[p.slice(-1)], 0) : null;
}

/** Splits a line at its comment, outside quotes. */
function splitComment(line: string): [string, string] {
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "\\") i++;
    else if (c === '"') q = !q;
    else if (c === ";" && !q) return [line.slice(0, i), line.slice(i + 1)];
  }
  return [line, ""];
}

const tokens = (s: string) => s.match(/"(?:[^"\\]|\\.)*"|[^\s()]+/g) ?? [];
const unquote = (s: string) => (s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1).replace(/\\(.)/g, "$1") : s);
const CLASSES = new Set(["IN", "CH", "HS", "CS"]);

/** Records of a BIND zone file. SOA is left out: Cloudflare manages it. */
export function parseZoneFile(text: string, zone: string) {
  const lines = text.split(/\r?\n/);
  const records: ParsedRecord[] = [];
  const errors: { line: number; text: string }[] = [];
  let origin = lower(zone);
  let defaultTtl: number | null = null;
  let owner = origin;
  const abs = (n: string) => (n === "@" ? origin : n.endsWith(".") ? lower(n) : lower(`${n}.${origin}`));

  for (let i = 0; i < lines.length; i++) {
    const start = i;
    const raw = lines[i];
    let [body, comment] = splitComment(raw);
    // Values in parentheses go on over several lines.
    let depth = (body.match(/\(/g) ?? []).length - (body.match(/\)/g) ?? []).length;
    while (depth > 0 && i + 1 < lines.length) {
      const [b, c] = splitComment(lines[++i]);
      body += ` ${b}`;
      comment = c || comment;
      depth += (b.match(/\(/g) ?? []).length - (b.match(/\)/g) ?? []).length;
    }
    const tk = tokens(body);
    const first = tk[0];
    if (!first) continue;
    const bad = () => errors.push({ line: start + 1, text: raw.trim() });
    if (first.startsWith("$")) {
      const d = first.toUpperCase();
      if (d === "$ORIGIN" && tk[1]) origin = lower(tk[1].endsWith(".") ? tk[1] : `${tk[1]}.${origin}`);
      else if (d === "$TTL" && tk[1] && parseTtl(tk[1]) !== null) defaultTtl = parseTtl(tk[1]);
      else bad();
      continue;
    }
    if (!/^\s/.test(raw)) owner = abs(tk.shift()!);
    let ttl: number | null = null;
    while (tk[0] !== undefined && (CLASSES.has(tk[0].toUpperCase()) || (ttl === null && parseTtl(tk[0]) !== null))) {
      const t = tk.shift()!;
      if (!CLASSES.has(t.toUpperCase())) ttl = parseTtl(t);
    }
    const type = (tk.shift() ?? "").toUpperCase();
    if (type === "SOA") continue;
    const rd = tk;
    if (!TYPE_SPECS[type] || !rd.length) {
      bad();
      continue;
    }
    const target = (s: string | undefined) => (s === undefined ? null : s === "." ? "." : abs(s));
    const rec: ParsedRecord = { line: start + 1, type, name: owner, content: "", ttl: ttl ?? defaultTtl ?? 1 };
    if (type === "MX" || type === "SRV" || type === "URI") {
      if (!/^\d+$/.test(rd[0] ?? "") || rd.length < (type === "MX" ? 2 : type === "SRV" ? 4 : 3)) {
        bad();
        continue;
      }
      rec.priority = Number(rd[0]);
      rec.content = type === "MX" ? target(rd[1])! : type === "SRV" ? `${rd[1]} ${rd[2]} ${target(rd[3])}` : rd.slice(1).join(" ");
    } else if (type === "CNAME" || type === "NS" || type === "PTR") {
      rec.content = target(rd[0])!;
    } else if (type === "TXT") {
      rec.content = rd.map(unquote).join("");
    } else {
      rec.content = rd.join(" ");
    }
    const proxied = comment.match(/cf-proxied:(true|false)/);
    if (proxied) rec.proxied = proxied[1] === "true";
    records.push(rec);
  }
  return { records, errors };
}

/** Text of a value, to compare records whatever way they were written. */
function same(type: string, content: string) {
  // TXT: "a" "b" and ab are the same text.
  if (type === "TXT") return content.trim().startsWith('"') ? tokens(content).map(unquote).join("") : content.trim();
  return content.toLowerCase().replace(/"/g, "").replace(/\.(\s|$)/g, "$1").replace(/\s+/g, " ").trim();
}

/** What an import would do: records added, already there (skipped) or refused because the name is taken. */
export function previewImport(zone: string, existing: Rec[], parsed: ParsedRecord[]) {
  const key = (r: { type: string; name: string; content: string; priority?: number }) => [r.type, lower(r.name), same(r.type, r.content), r.type === "MX" || r.type === "SRV" || r.type === "URI" ? (r.priority ?? "") : ""].join("|");
  const seen = new Set(existing.map(key));
  const add: ParsedRecord[] = [];
  const sameRecords: ParsedRecord[] = [];
  const conflicts: { record: ParsedRecord; with: Rec[] }[] = [];
  for (const r of parsed) {
    const k = key(r);
    if (seen.has(k)) {
      sameRecords.push(r);
      continue;
    }
    // A CNAME can't share its name with other records.
    const onName = existing.filter((e) => lower(e.name) === lower(r.name));
    const clash = r.type === "CNAME" ? onName : onName.filter((e) => e.type === "CNAME");
    if (clash.length) conflicts.push({ record: r, with: clash });
    else add.push(r);
    seen.add(k);
  }
  return { add, same: sameRecords, conflicts };
}
