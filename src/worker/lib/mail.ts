// Mail analysis for a zone: MX, SPF, DKIM, DMARC and anomalies.
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
export type Check = { id: string; level: Level; area: Area; params?: CheckParams; fix?: FixId };

export type Provider = { id: string; name: string; spf?: string; dkim?: string[] };

export type MailReport = {
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

export async function analyzeMail(zone: string, records: DnsRecord[], resolver: Resolver): Promise<MailReport> {
  const z = lower(zone);
  const at = (name: string) => lower(name) === z;
  const checks: Check[] = [];
  const add = (c: Check) => checks.push(c);

  const mx = records
    .filter((r) => r.type === "MX" && at(r.name))
    .map((r) => ({ host: lower(r.content), priority: r.priority ?? 0 }))
    .sort((a, b) => a.priority - b.priority);
  const rootTxt = records.filter((r) => r.type === "TXT" && at(r.name)).map((r) => txtValue(r.content));
  const spf = rootTxt.filter((t) => /^v=spf1(\s|$)/i.test(t));
  const dmarc = records
    .filter((r) => r.type === "TXT" && lower(r.name) === `_dmarc.${z}`)
    .map((r) => txtValue(r.content))
    .filter((t) => /^v=DMARC1/i.test(t));
  const dkim = records
    .filter((r) => lower(r.name).endsWith(`._domainkey.${z}`) && (r.type === "TXT" || r.type === "CNAME"))
    .map((r) => ({
      selector: lower(r.name).slice(0, -`._domainkey.${z}`.length),
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
  const provider = providerDef ? { id: providerDef.id, name: providerDef.name, spf: providerDef.spfFor?.(providerMx!) ?? providerDef.spf, dkim: providerDef.dkim } : null;

  // MX
  if (nullMx && realMx.length) add({ id: "mx-null-mixed", level: "error", area: "mx" });
  if (mode === "none" && !nullMx) add({ id: "none-unprotected", level: "warning", area: "mx", fix: "protect-no-mail" });
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
    if (mode === "mail") add({ id: "spf-missing", level: "error", area: "spf", fix: "add-spf" });
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
  if (!dmarc.length) {
    if (mode !== "none" || nullMx) add({ id: "dmarc-missing", level: "warning", area: "dmarc", fix: "add-dmarc" });
  } else if (dmarc.length > 1) {
    add({ id: "dmarc-multiple", level: "error", area: "dmarc", params: { count: dmarc.length } });
  } else {
    const tags = parseTags(dmarc[0]);
    const p = tags.p?.toLowerCase();
    if (!p || !["none", "quarantine", "reject"].includes(p)) add({ id: "dmarc-invalid", level: "error", area: "dmarc" });
    else if (p === "none") add({ id: "dmarc-none", level: "warning", area: "dmarc" });
    if (mode === "protected" && p && p !== "reject") add({ id: "dmarc-nomail-soft", level: "warning", area: "dmarc" });
    if (tags.pct && Number(tags.pct) < 100) add({ id: "dmarc-pct", level: "info", area: "dmarc", params: { pct: tags.pct } });
    if (!tags.rua && mode === "mail") add({ id: "dmarc-no-rua", level: "info", area: "dmarc" });
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
  if (mode === "mail") {
    if (!dkim.length) add({ id: "dkim-missing", level: "warning", area: "dkim", params: provider?.dkim ? { provider: provider.name, selectors: provider.dkim.join(", ") } : {} });
  }

  // Who sends: each service should be both in SPF and signing with DKIM.
  const senders = detectSenders(z, records);
  for (const sd of senders) {
    if (sd.unknown) continue;
    // Already covered: no DKIM at all is "dkim-missing", receiving provider missing from SPF is "spf-provider".
    if (sd.spf && !sd.dkim && sd.needsDkim && !(sd.receives && checks.some((c) => c.id === "dkim-missing"))) {
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
  if (mode === "mail") {
    const has = (n: string) => records.some((r) => lower(r.name) === `${n}.${z}` && r.type === "TXT");
    if (!has("_mta-sts")) add({ id: "mta-sts-missing", level: "info", area: "other" });
    if (!has("_smtp._tls")) add({ id: "tls-rpt-missing", level: "info", area: "other" });
  }

  const score = { errors: checks.filter((c) => c.level === "error").length, warnings: checks.filter((c) => c.level === "warning").length };
  return { mode, provider, records: { mx, spf, dmarc, dkim }, spfLookups, senders, checks, score };
}
