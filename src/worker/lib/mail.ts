// Mail analysis for a zone: MX, SPF, DKIM, DMARC and anomalies, for the apex and for each
// subdomain that has mail records of its own.
// Starts from the zone records (authoritative, read from the API) and uses public DNS only
// for names outside the zone: SPF includes and external MX hosts.
// Checks carry an id and params; the client turns them into text in the user's language.

import { QBOX_MX, QBOX_SPF, QBOX_WHITE_LABEL } from "./qboxmail";
import { detectSenders, type Sender } from "./senders";

export type DnsRecord = {
  id?: string;
  type: string;
  name: string;
  content: string;
  priority?: number;
  proxied?: boolean;
  ttl?: number;
};

export interface Resolver {
  lookup(name: string, type: "A" | "AAAA" | "TXT" | "MX"): Promise<string[]>;
}

export type Level = "error" | "warning" | "info" | "ok";
export type Area = "mx" | "spf" | "dkim" | "dmarc" | "other";
export type FixId = "protect-no-mail" | "add-dmarc" | "add-spf" | "add-spf-include" | "google-mx";

export type CheckParams = Record<string, string | number>;
// name: the subdomain the check is about; missing for the apex.
export type Check = { id: string; level: Level; area: Area; params?: CheckParams; fix?: FixId; name?: string };

// pec: certified email, which travels in the provider's name and needs no SPF or DKIM of its own.
export type Provider = { id: string; name: string; spf?: string; dkim?: string[]; pec?: boolean };

export type NameReport = {
  name: string;
  mode: "mail" | "none" | "protected";
  provider: Provider | null;
  records: {
    mx: { host: string; priority: number }[];
    spf: string[];
    dmarc: string[];
    dkim: { selector: string; type: string; content: string }[];
  };
  spfLookups: number | null;
  senders: Sender[];
  checks: Check[];
  score: { errors: number; warnings: number };
};

// The apex, plus the subdomains with mail records; total counts the problems of all of them.
export type MailReport = NameReport & { subdomains: NameReport[]; total: { errors: number; warnings: number } };

// spfOk: the includes that count as the provider's, when there is more than one; spfFor: the one
// to propose, from the MX in use.
const PROVIDERS: (Provider & { mx: RegExp; spfOk?: RegExp; spfFor?: (mx: string) => string })[] = [
  { id: "google", name: "Google Workspace", mx: /(^|\.)(google\.com|googlemail\.com)$/, spf: "_spf.google.com", dkim: ["google"] },
  { id: "microsoft", name: "Microsoft 365", mx: /\.mail\.protection\.outlook\.com$/, spf: "spf.protection.outlook.com", dkim: ["selector1", "selector2"] },
  { id: "cloudflare", name: "Cloudflare Email Routing", mx: /\.mx\.cloudflare\.net$/, spf: "_spf.mx.cloudflare.net", dkim: ["cf2024-1"] },
  { id: "zoho", name: "Zoho Mail", mx: /(^|\.)zoho(mail)?\.(com|eu|in)$/, spf: "zoho" },
  { id: "proton", name: "Proton Mail", mx: /\.protonmail\.ch$/, spf: "_spf.protonmail.ch", dkim: ["protonmail", "protonmail2", "protonmail3"] },
  { id: "forwardemail", name: "Forward Email", mx: /\.forwardemail\.net$/, spf: "spf.forwardemail.net" },
  { id: "fastmail", name: "Fastmail", mx: /\.messagingengine\.com$/, spf: "spf.messagingengine.com", dkim: ["fm1", "fm2", "fm3"] },
  { id: "icloud", name: "iCloud Mail", mx: /\.mail\.icloud\.com$/, spf: "icloud.com", dkim: ["sig1"] },
  { id: "ovh", name: "OVHcloud", mx: /\.(ovh\.net|ovh\.com)$/, spf: "mx.ovh.com" },
  // Certified email (PEC), usually on a "pec." subdomain.
  { id: "arubapec", name: "Aruba PEC", mx: /\.pec\.aruba\.it$/, spf: "pec.aruba.it", pec: true },
  { id: "legalmail", name: "Legalmail", mx: /\.legalmail\.it$/, pec: true },
  { id: "registerpec", name: "Register.it PEC", mx: /\.pec-email\.com$/, spf: "spf.pec-email.com", pec: true },
  { id: "postacert", name: "ITNet", mx: /\.postacert\.it\.net$/, spf: "postacert.it.net", pec: true },
  { id: "namirial", name: "Namirial", mx: /\.sicurezzapostale\.it$/, pec: true },
  { id: "postecert", name: "Poste Italiane", mx: /\.postecert\.it$/, pec: true },
  { id: "aruba", name: "Aruba", mx: /(^|\.)aruba\.it$/, spf: "_spf.aruba.it" },
  { id: "register", name: "Register.it", mx: /(^|\.)register\.it$/, spf: "spf.register.it" },
  { id: "qboxmail", name: "Qboxmail", mx: QBOX_MX, spf: "spf.qboxmail.com", spfOk: QBOX_SPF, spfFor: (mx) => `spf.${mx.match(QBOX_WHITE_LABEL)?.[1] ?? "qboxmail.com"}` },
];

/** Contenuto TXT come lo legge un server: senza virgolette, stringhe spezzate unite. */
export function txtValue(content: string): string {
  const parts = content.match(/"((?:[^"\\]|\\.)*)"/g);
  if (!parts) return content.trim();
  return parts.map((p) => p.slice(1, -1).replace(/\\(.)/g, "$1")).join("");
}

const lower = (s: string) => s.toLowerCase().replace(/\.$/, "");

export function parseTags(v: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of v.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    out[part.slice(0, i).trim().toLowerCase()] = part.slice(i + 1).trim();
  }
  return out;
}

/** Bit stimati di una chiave RSA dalla lunghezza della SubjectPublicKeyInfo. */
export function rsaBits(p: string): number | null {
  const clean = p.replace(/\s+/g, "");
  if (!clean) return null;
  const bytes = Math.floor((clean.length * 3) / 4) - (clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0);
  if (bytes < 110) return 512;
  if (bytes < 200) return 1024;
  if (bytes < 330) return 2048;
  return 4096;
}

async function countSpfLookups(spf: string, resolver: Resolver, seen = new Set<string>(), depth = 0): Promise<number> {
  let count = 0;
  for (const term of spf.split(/\s+/).slice(1)) {
    const t = term.replace(/^[+\-~?]/, "").toLowerCase();
    const [mech, arg] = t.includes(":") ? [t.slice(0, t.indexOf(":")), t.slice(t.indexOf(":") + 1)] : t.split("=");
    if (["a", "mx", "ptr", "exists"].includes(mech) || mech.startsWith("a/") || mech.startsWith("mx/")) count++;
    if ((mech === "include" || mech === "redirect") && arg) {
      count++;
      if (depth < 10 && !seen.has(arg)) {
        seen.add(arg);
        const txt = (await resolver.lookup(arg, "TXT")).map(txtValue).find((x) => /^v=spf1(\s|$)/i.test(x));
        if (txt) count += await countSpfLookups(txt, resolver, seen, depth + 1);
      }
    }
  }
  return count;
}

const isSpfValue = (t: string) => /^v=spf1(\s|$)/i.test(t);

/**
 * Subdomains with mail records of their own: MX, SPF, DMARC or DKIM keys. Technical names
 * (first label starting with "_", like an SPF include target) and wildcards are left out.
 */
export function mailSubdomains(zone: string, records: DnsRecord[]): string[] {
  const z = lower(zone);
  const out = new Set<string>();
  for (const r of records) {
    const n = lower(r.name);
    let owner: string | null = null;
    if (r.type === "MX" || (r.type === "TXT" && isSpfValue(txtValue(r.content)))) owner = n;
    else if (r.type === "TXT" && n.startsWith("_dmarc.") && /^v=DMARC1/i.test(txtValue(r.content))) owner = n.slice("_dmarc.".length);
    else if ((r.type === "TXT" || r.type === "CNAME") && n.includes("._domainkey.")) owner = n.slice(n.indexOf("._domainkey.") + "._domainkey.".length);
    if (owner && owner.endsWith(`.${z}`) && !/^[_*]/.test(owner)) out.add(owner);
  }
  return [...out].sort();
}

/** The report of one name of the zone: the apex or one of its subdomains. */
export function reportFor(mail: MailReport, name?: string): NameReport | undefined {
  const n = lower(name || mail.name);
  return n === mail.name ? mail : mail.subdomains.find((s) => s.name === n);
}

const POLICIES = ["none", "quarantine", "reject"];

/** The DMARC tags published on a name, when there is exactly one record with a valid policy. */
function dmarcAt(name: string, records: DnsRecord[]) {
  const found = records.filter((r) => r.type === "TXT" && lower(r.name) === `_dmarc.${name}`).map((r) => txtValue(r.content)).filter((t) => /^v=DMARC1/i.test(t));
  const tags = found.length === 1 ? parseTags(found[0]) : null;
  return tags && POLICIES.includes(tags.p?.toLowerCase() ?? "") ? tags : null;
}

/**
 * The policy a subdomain without its own DMARC follows, looking at the names above it inside the
 * zone. A name that declares itself the reference domain (psd=n) wins; otherwise the topmost
 * record, normally the apex. Its sp= applies, or p= when missing.
 */
function inheritedDmarc(zone: string, name: string, records: DnsRecord[]): { policy: string; from: string } | null {
  const above: string[] = [];
  for (let n = name.slice(name.indexOf(".") + 1); n.endsWith(zone); n = n.slice(n.indexOf(".") + 1)) {
    above.push(n);
    if (n === zone) break;
  }
  const found = above.map((n) => ({ n, tags: dmarcAt(n, records) })).filter((x) => x.tags);
  const ref = found.find((x) => x.tags!.psd?.toLowerCase() === "n") ?? found.at(-1);
  if (!ref) return null;
  const policy = (ref.tags!.sp && POLICIES.includes(ref.tags!.sp.toLowerCase()) ? ref.tags!.sp : ref.tags!.p).toLowerCase();
  return { policy, from: ref.n };
}

export async function analyzeMail(zone: string, records: DnsRecord[], resolver: Resolver): Promise<MailReport> {
  const apex = await analyzeName(zone, zone, records, resolver);
  const subdomains = await Promise.all(mailSubdomains(zone, records).map((n) => analyzeName(zone, n, records, resolver)));
  const sum = (k: "errors" | "warnings") => subdomains.reduce((x, s) => x + s.score[k], apex.score[k]);
  return { ...apex, subdomains, total: { errors: sum("errors"), warnings: sum("warnings") } };
}

// On a subdomain some checks don't apply: protection and reports are the apex's business, and
// DKIM signs for the sender address, which is often the apex even when bounces go to the subdomain.
async function analyzeName(zone: string, name: string, records: DnsRecord[], resolver: Resolver): Promise<NameReport> {
  const z = lower(zone);
  const n = lower(name);
  const sub = n !== z;
  const at = (x: string) => lower(x) === n;
  const checks: Check[] = [];
  const add = (c: Check) => checks.push(sub ? { ...c, name: n } : c);

  const mx = records
    .filter((r) => r.type === "MX" && at(r.name))
    .map((r) => ({ host: lower(r.content), priority: r.priority ?? 0 }))
    .sort((a, b) => a.priority - b.priority);
  const rootTxt = records.filter((r) => r.type === "TXT" && at(r.name)).map((r) => txtValue(r.content));
  const spf = rootTxt.filter((t) => /^v=spf1(\s|$)/i.test(t));
  const dmarc = records
    .filter((r) => r.type === "TXT" && lower(r.name) === `_dmarc.${n}`)
    .map((r) => txtValue(r.content))
    .filter((t) => /^v=DMARC1/i.test(t));
  const dkim = records
    .filter((r) => lower(r.name).endsWith(`._domainkey.${n}`) && (r.type === "TXT" || r.type === "CNAME"))
    .map((r) => ({
      selector: lower(r.name).slice(0, -`._domainkey.${n}`.length),
      type: r.type,
      content: r.type === "TXT" ? txtValue(r.content) : lower(r.content),
    }))
    .filter((d) => !d.selector.includes("."));

  const nullMx = mx.some((m) => m.host === "" || m.host === ".");
  const realMx = mx.filter((m) => m.host !== "" && m.host !== ".");
  const spfMain = spf[0];
  const spfAll = spfMain?.match(/\s([+\-~?]?)all(\s|$)/i);
  const spfHardFail = !!spfAll && spfAll[1] === "-";

  const mode: MailReport["mode"] = realMx.length ? "mail" : nullMx && spfHardFail && spf.length === 1 ? "protected" : "none";
  const providerDef = PROVIDERS.find((p) => realMx.some((m) => p.mx.test(m.host)));
  const providerMx = providerDef && realMx.find((m) => providerDef.mx.test(m.host))!.host;
  const provider = providerDef ? { id: providerDef.id, name: providerDef.name, spf: providerDef.spfFor?.(providerMx!) ?? providerDef.spf, dkim: providerDef.dkim, ...(providerDef.pec && { pec: true }) } : null;

  // MX
  if (nullMx && realMx.length) add({ id: "mx-null-mixed", level: "error", area: "mx" });
  if (mode === "none" && !nullMx && !sub) add({ id: "none-unprotected", level: "warning", area: "mx", fix: "protect-no-mail" });
  if (mode === "protected") add({ id: "protected", level: "ok", area: "mx" });
  for (const m of realMx) {
    const host = m.host;
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
      add({ id: "mx-ip", level: "error", area: "mx", params: { host } });
      continue;
    }
    if (host === z || host.endsWith(`.${z}`)) {
      const own = records.filter((r) => lower(r.name) === host && ["A", "AAAA", "CNAME"].includes(r.type));
      if (!own.length) add({ id: "mx-missing", level: "error", area: "mx", params: { host } });
      else if (own.some((r) => r.type === "CNAME")) add({ id: "mx-cname", level: "warning", area: "mx", params: { host } });
      if (own.some((r) => r.proxied)) add({ id: "mx-proxied", level: "error", area: "mx", params: { host } });
    } else {
      const [a, aaaa] = await Promise.all([resolver.lookup(host, "A"), resolver.lookup(host, "AAAA")]);
      if (!a.length && !aaaa.length) add({ id: "mx-unresolved", level: "error", area: "mx", params: { host } });
    }
  }
  // Google: smtp.google.com is the current record; the "aspmx" ones (before 2023) are still supported.
  const legacyGoogle = realMx.filter((m) => /(^|\.)aspmx\.l\.google\.com$|^aspmx\d?\.googlemail\.com$/.test(m.host));
  const newGoogle = realMx.some((m) => m.host === "smtp.google.com");
  if (legacyGoogle.length && newGoogle) add({ id: "mx-google-mixed", level: "warning", area: "mx", fix: "google-mx" });
  if (realMx.length && !checks.some((c) => c.area === "mx" && c.level !== "ok")) {
    add({ id: "mx-ok", level: "ok", area: "mx", params: { provider: provider?.name ?? "", count: realMx.length, hosts: realMx.map((m) => m.host).join(", ") } });
  }
  if (legacyGoogle.length && !newGoogle) add({ id: "mx-google-legacy", level: "info", area: "mx", fix: "google-mx" });

  // SPF
  let spfLookups: number | null = null;
  if (records.some((r) => r.type === "SPF" && at(r.name))) add({ id: "spf-type", level: "warning", area: "spf" });
  if (!spf.length) {
    // A subdomain that receives may not send at all: worth fixing, not an error.
    if (mode === "mail" && provider?.pec) add({ id: "pec-no-spf", level: "ok", area: "spf", params: { provider: provider.name } });
    else if (mode === "mail") add({ id: "spf-missing", level: sub ? "warning" : "error", area: "spf", fix: "add-spf" });
    else if (nullMx) add({ id: "spf-missing-nomail", level: "warning", area: "spf", fix: "protect-no-mail" });
  } else if (spf.length > 1) {
    add({ id: "spf-multiple", level: "error", area: "spf", params: { count: spf.length } });
  } else {
    if (!spfAll) add({ id: "spf-no-all", level: "warning", area: "spf" });
    else if (spfAll[1] === "+" || spfAll[1] === "") add({ id: "spf-pass-all", level: "error", area: "spf" });
    else if (spfAll[1] === "?") add({ id: "spf-neutral", level: "warning", area: "spf" });
    if (/\sptr(:|\s|$)/i.test(spfMain)) add({ id: "spf-ptr", level: "warning", area: "spf" });
    spfLookups = await countSpfLookups(spfMain, resolver);
    if (spfLookups > 10) add({ id: "spf-lookups", level: "error", area: "spf", params: { count: spfLookups } });
    else if (spfLookups > 8) add({ id: "spf-lookups-near", level: "warning", area: "spf", params: { count: spfLookups } });
    if (mode === "none" && nullMx && !spfHardFail) add({ id: "spf-soft-nomail", level: "warning", area: "spf", fix: "protect-no-mail" });
    const spfIncludes = [...spfMain.toLowerCase().matchAll(/\binclude:(\S+)/g)].map((m) => m[1]);
    const hasProviderSpf = providerDef?.spfOk ? spfIncludes.some((i) => providerDef.spfOk!.test(i)) : !!provider?.spf && spfMain.toLowerCase().includes(provider.spf);
    if (provider?.spf && !hasProviderSpf) add({ id: "spf-provider", level: "warning", area: "spf", params: { provider: provider.name, include: provider.spf }, fix: "add-spf-include" });
    if (!checks.some((c) => c.area === "spf")) add({ id: "spf-ok", level: "ok", area: "spf", params: { value: spfMain } });
  }

  // DMARC
  const dmarcTags = dmarc.length === 1 ? parseTags(dmarc[0]) : {};
  const inherited = !dmarc.length && sub ? inheritedDmarc(z, n, records) : null;
  if (inherited) {
    add({ id: "dmarc-inherited", level: inherited.policy === "none" ? "info" : "ok", area: "dmarc", params: inherited });
  } else if (!dmarc.length && sub) {
    // Nothing to follow: the subdomain needs a DMARC of its own (or the apex one).
    if (mode !== "none" || nullMx || spf.length) add({ id: "dmarc-missing", level: "warning", area: "dmarc", fix: "add-dmarc" });
  } else if (!dmarc.length) {
    if (mode !== "none" || nullMx) add({ id: "dmarc-missing", level: "warning", area: "dmarc", fix: "add-dmarc" });
  } else if (dmarc.length > 1) {
    add({ id: "dmarc-multiple", level: "error", area: "dmarc", params: { count: dmarc.length } });
  } else {
    const tags = dmarcTags;
    const p = tags.p?.toLowerCase();
    if (!p || !["none", "quarantine", "reject"].includes(p)) add({ id: "dmarc-invalid", level: "error", area: "dmarc" });
    else if (p === "none") add({ id: "dmarc-none", level: "warning", area: "dmarc" });
    if (mode === "protected" && p && p !== "reject") add({ id: "dmarc-nomail-soft", level: "warning", area: "dmarc" });
    if (mode === "protected" && !sub && tags.sp && tags.sp.toLowerCase() !== "reject") add({ id: "dmarc-sp-weak", level: "warning", area: "dmarc", fix: "protect-no-mail" });
    if (tags.pct && Number(tags.pct) < 100) add({ id: "dmarc-pct", level: "info", area: "dmarc", params: { pct: tags.pct } });
    if (!tags.rua && mode === "mail" && !sub) add({ id: "dmarc-no-rua", level: "info", area: "dmarc" });
    if (!checks.some((c) => c.area === "dmarc" && c.level !== "info")) add({ id: "dmarc-ok", level: "ok", area: "dmarc", params: { policy: p ?? "", value: dmarc[0] } });
  }

  // DKIM
  for (const d of dkim) {
    if (d.type !== "TXT") continue;
    const tags = parseTags(d.content);
    const selector = d.selector;
    if ("p" in tags && tags.p === "") {
      add({ id: "dkim-revoked", level: "info", area: "dkim", params: { selector } });
      continue;
    }
    if (!tags.p) {
      add({ id: "dkim-invalid", level: "error", area: "dkim", params: { selector } });
      continue;
    }
    if ((tags.k ?? "rsa").toLowerCase() === "rsa") {
      const bits = rsaBits(tags.p);
      if (bits && bits < 1024) add({ id: "dkim-weak", level: "error", area: "dkim", params: { selector, bits } });
      else if (bits === 1024) add({ id: "dkim-1024", level: "info", area: "dkim", params: { selector } });
    }
  }
  if (mode === "mail" && !sub && !provider?.pec) {
    if (!dkim.length) add({ id: "dkim-missing", level: "warning", area: "dkim", params: provider?.dkim ? { provider: provider.name, selectors: provider.dkim.join(", ") } : {} });
  }

  // Who sends: each service should be both in SPF and signing with DKIM.
  const senders = detectSenders(n, records);
  for (const sd of senders) {
    if (sd.unknown) continue;
    // Already covered: no DKIM at all is "dkim-missing", receiving provider missing from SPF is "spf-provider".
    if (sd.spf && !sd.dkim && sd.needsDkim && !sub && !(sd.receives && checks.some((c) => c.id === "dkim-missing"))) {
      add({ id: "sender-no-dkim", level: "warning", area: "dkim", params: { sender: sd.name, ...(sd.docs && { docs: sd.docs }) } });
    }
    if (sd.dkim && !sd.spf && sd.needsSpf && sd.include && spf.length === 1 && !sd.receives) {
      add({ id: "sender-no-spf", level: "warning", area: "spf", params: { sender: sd.name, include: sd.include }, fix: "add-spf-include" });
    }
  }
  if (mode === "mail" && dkim.length && !checks.some((c) => c.area === "dkim" && c.level !== "info")) {
    add({ id: "dkim-ok", level: "ok", area: "dkim", params: { selectors: dkim.map((d) => d.selector).join(", ") } });
  }

  // Other
  if (mode === "mail" && !sub) {
    const has = (x: string) => records.some((r) => lower(r.name) === `${x}.${z}` && r.type === "TXT");
    if (!has("_mta-sts")) add({ id: "mta-sts-missing", level: "info", area: "other" });
    if (!has("_smtp._tls")) add({ id: "tls-rpt-missing", level: "info", area: "other" });
  }
  // MX and SPF of the apex don't cover its subdomains: a wildcard SPF covers the names that don't exist.
  if (mode === "protected" && !sub && !records.some((r) => lower(r.name) === `*.${z}`)) add({ id: "subs-unprotected", level: "info", area: "other", fix: "protect-no-mail" });

  const score = { errors: checks.filter((c) => c.level === "error").length, warnings: checks.filter((c) => c.level === "warning").length };
  return { name: n, mode, provider, records: { mx, spf, dmarc, dkim }, spfLookups, senders, checks, score };
}
