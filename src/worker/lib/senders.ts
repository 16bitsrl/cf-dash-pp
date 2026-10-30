// Who sends (and receives) email for a zone, worked out from MX, SPF includes and DKIM selectors,
// plus helpers to build the records that fix what is missing.

import { parseTags, txtValue, type DnsRecord } from "./mail";
import { QBOX_MX, QBOX_SPF } from "./qboxmail";

type Dkim = { selector: string; type: string; content: string };

type SenderDef = {
  id: string;
  name: string;
  include?: string; // SPF include to add
  spf?: RegExp; // matches the SPF include domains of the service
  dkim?: (d: Dkim) => boolean;
  mx?: RegExp;
  needsSpf: boolean; // the service asks to be in SPF
  needsDkim: boolean; // the service can sign and we can recognise its selector
  docs?: string;
};

const sel = (re: RegExp) => (d: Dkim) => re.test(d.selector);
const cname = (re: RegExp) => (d: Dkim) => d.type === "CNAME" && re.test(d.content);

export const SENDERS: SenderDef[] = [
  { id: "google", name: "Google Workspace", include: "_spf.google.com", spf: /^_spf\.google\.com$/, dkim: sel(/^google$/), mx: /(^|\.)(google|googlemail)\.com$/, needsSpf: true, needsDkim: true, docs: "https://support.google.com/a/answer/174124" },
  {
    id: "microsoft",
    name: "Microsoft 365",
    include: "spf.protection.outlook.com",
    spf: /^spf\.protection\.outlook\.com$/,
    dkim: sel(/^selector[12]$/),
    mx: /\.mail\.protection\.outlook\.com$/,
    needsSpf: true,
    needsDkim: true,
    docs: "https://learn.microsoft.com/en-us/defender-office-365/email-authentication-dkim-configure",
  },
  // Qboxmail signs as qbm…, or through its smtpfy.com service with nl… and tr… selectors.
  { id: "qboxmail", name: "Qboxmail", include: "spf.qboxmail.com", spf: QBOX_SPF, dkim: (d) => /^qbm\d+$/.test(d.selector) || (d.type === "CNAME" && /\.dkim\.smtpfy\.com$/.test(d.content)), mx: QBOX_MX, needsSpf: true, needsDkim: true, docs: "https://docs.qboxmail.com/it" },
  { id: "forwardemail", name: "Forward Email", include: "spf.forwardemail.net", spf: /^spf\.forwardemail\.net$/, dkim: sel(/^fe-[0-9a-f]+$/), mx: /\.forwardemail\.net$/, needsSpf: true, needsDkim: true, docs: "https://forwardemail.net/en/faq#how-do-i-set-up-dkim" },
  { id: "cloudflare", name: "Cloudflare Email Routing", include: "_spf.mx.cloudflare.net", spf: /^_spf\.mx\.cloudflare\.net$/, dkim: sel(/^cf\d{4}-\d+$/), mx: /\.mx\.cloudflare\.net$/, needsSpf: true, needsDkim: false, docs: "https://developers.cloudflare.com/email-routing/" },
  { id: "zoho", name: "Zoho Mail", include: "zoho.eu", spf: /^(zoho(mail)?\.(com|eu|in)|zcsend\.net)$/, mx: /(^|\.)zoho(mail)?\.(com|eu|in)$/, needsSpf: true, needsDkim: false },
  { id: "arubapec", name: "Aruba PEC", include: "pec.aruba.it", spf: /^pec\.aruba\.it$/, mx: /\.pec\.aruba\.it$/, needsSpf: false, needsDkim: false },
  { id: "aruba", name: "Aruba", include: "_spf.aruba.it", spf: /^_spf\.aruba\.it$/, mx: /^(?!.*\.pec\.aruba\.it$).*(^|\.)aruba\.it$/, needsSpf: true, needsDkim: false },
  { id: "ovh", name: "OVHcloud", include: "mx.ovh.com", spf: /^mx\.ovh\.com$/, mx: /\.(ovh\.net|ovh\.com)$/, needsSpf: true, needsDkim: false },
  { id: "register", name: "Register.it", include: "spf.register.it", spf: /^spf\.register\.it$/, mx: /(^|\.)register\.it$/, needsSpf: true, needsDkim: false },
  { id: "mailchimp", name: "Mailchimp", include: "servers.mcsv.net", spf: /^servers\.mcsv\.net$/, dkim: cname(/dkim\.mcsv\.net$/), needsSpf: false, needsDkim: true, docs: "https://mailchimp.com/help/set-up-email-domain-authentication/" },
  { id: "sendgrid", name: "SendGrid", include: "sendgrid.net", spf: /^sendgrid\.net$/, dkim: cname(/sendgrid\.net$/), needsSpf: true, needsDkim: true, docs: "https://www.twilio.com/docs/sendgrid/ui/account-and-settings/how-to-set-up-domain-authentication" },
  { id: "amazonses", name: "Amazon SES", include: "amazonses.com", spf: /^amazonses\.com$/, dkim: cname(/\.dkim\.amazonses\.com$/), needsSpf: false, needsDkim: true, docs: "https://docs.aws.amazon.com/ses/latest/dg/send-email-authentication-dkim-easy.html" },
  { id: "brevo", name: "Brevo", include: "spf.brevo.com", spf: /^spf\.(brevo|sendinblue)\.com$/, dkim: (d) => /^brevo\d$/.test(d.selector) || /(brevo|sendinblue)\.com$/.test(d.content), needsSpf: true, needsDkim: true },
  { id: "mailgun", name: "Mailgun", include: "mailgun.org", spf: /^mailgun\.org$/, dkim: (d) => /mailgun\.(org|com)$/.test(d.content), needsSpf: true, needsDkim: true },
];

export type Sender = {
  id: string;
  name: string;
  spf: boolean;
  dkim: boolean;
  receives: boolean;
  include: string | null;
  needsSpf: boolean;
  needsDkim: boolean;
  docs: string | null;
  unknown: boolean;
};

const lower = (s: string) => s.toLowerCase().replace(/\.$/, "");

export function spfIncludes(spf: string[]) {
  return spf.flatMap((v) => [...v.matchAll(/(?:^|\s)[+\-~?]?(?:include:|redirect=)(\S+)/gi)].map((m) => lower(m[1])));
}

export function detectSenders(zone: string, records: DnsRecord[]): Sender[] {
  const z = lower(zone);
  const spf = records.filter((r) => r.type === "TXT" && lower(r.name) === z).map((r) => txtValue(r.content)).filter((v) => /^v=spf1(\s|$)/i.test(v));
  const includes = spfIncludes(spf);
  const dkim: Dkim[] = records
    .filter((r) => lower(r.name).endsWith(`._domainkey.${z}`) && (r.type === "TXT" || r.type === "CNAME"))
    .map((r) => ({ selector: lower(r.name).slice(0, -`._domainkey.${z}`.length), type: r.type, content: r.type === "CNAME" ? lower(r.content) : txtValue(r.content) }));
  const mx = records.filter((r) => r.type === "MX" && lower(r.name) === z).map((r) => lower(r.content));

  const known = new Set<string>();
  const out: Sender[] = [];
  for (const d of SENDERS) {
    const inSpf = includes.filter((i) => d.spf?.test(i));
    inSpf.forEach((i) => known.add(i));
    const s = { spf: inSpf.length > 0, dkim: !!d.dkim && dkim.some(d.dkim), receives: !!d.mx && mx.some((h) => d.mx!.test(h)) };
    if (s.spf || s.dkim || s.receives) out.push({ id: d.id, name: d.name, ...s, include: d.include ?? null, needsSpf: d.needsSpf, needsDkim: d.needsDkim, docs: d.docs ?? null, unknown: false });
  }
  for (const i of includes) {
    if (!known.has(i)) out.push({ id: `other:${i}`, name: i, spf: true, dkim: false, receives: false, include: i, needsSpf: false, needsDkim: false, docs: null, unknown: true });
  }
  return out;
}

/** One SPF record from the current ones: merged, without duplicates, with includes added or removed. */
export function proposeSpf(current: string[], add: string[], remove: string[] = []) {
  const terms: string[] = [];
  let all: string | null = null;
  for (const v of current) {
    for (const t of v.trim().split(/\s+/).slice(1)) {
      const m = t.match(/^([+\-~?]?)all$/i);
      if (m) all ??= m[1] || "+";
      else if (!terms.includes(t)) terms.push(t);
    }
  }
  const hadMechanisms = terms.length > 0;
  const drop = new Set(remove.map((r) => `include:${lower(r)}`));
  const out = terms.filter((t) => !drop.has(t.toLowerCase()));
  for (const a of add) if (!out.some((t) => t.toLowerCase() === `include:${lower(a)}`)) out.push(`include:${lower(a)}`);
  // A domain that did not send ("-all" alone) now does: "~all" while it gets going. "+all" is never kept.
  const q = !all || all === "+" || (!hadMechanisms && all === "-" && add.length) ? "~" : all;
  return ["v=spf1", ...out, `${q}all`].join(" ");
}

export type MxPreset = "google" | "microsoft" | "qboxmail" | "forwardemail" | "none";

export function mxPreset(preset: MxPreset, zone: string): { host: string; priority: number }[] {
  switch (preset) {
    case "google":
      return [{ host: "smtp.google.com", priority: 1 }];
    case "microsoft":
      return [{ host: `${lower(zone).replace(/\./g, "-")}.mail.protection.outlook.com`, priority: 0 }];
    case "qboxmail":
      return [
        { host: "mx01.qboxmail.com", priority: 10 },
        { host: "mx02.qboxmail.com", priority: 20 },
      ];
    case "forwardemail":
      return [
        { host: "mx1.forwardemail.net", priority: 10 },
        { host: "mx2.forwardemail.net", priority: 10 },
      ];
    case "none":
      return [{ host: ".", priority: 0 }];
  }
}

export const MX_PRESET_INCLUDE: Partial<Record<MxPreset, string>> = { google: "_spf.google.com", microsoft: "spf.protection.outlook.com", qboxmail: "spf.qboxmail.com", forwardemail: "spf.forwardemail.net" };

/** DMARC with a new policy and optionally a report address and subdomain policy; other tags are kept. */
export function dmarcValue(current: string | undefined, change: { policy: "none" | "quarantine" | "reject"; rua?: string; sp?: "none" | "quarantine" | "reject" }) {
  const tags = (current ?? "")
    .split(";")
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => [t.slice(0, t.indexOf("=")).trim().toLowerCase(), t.slice(t.indexOf("=") + 1).trim()] as [string, string])
    .filter(([k]) => k && k !== "v");
  const set = (k: string, v: string) => {
    const i = tags.findIndex(([x]) => x === k);
    if (i >= 0) tags[i] = [k, v];
    else if (k === "p") tags.unshift([k, v]);
    else tags.push([k, v]);
  };
  set("p", change.policy);
  if (change.sp) set("sp", change.sp);
  if (change.rua) set("rua", `mailto:${change.rua}`);
  return ["v=DMARC1", ...tags.map(([k, v]) => `${k}=${v}`)].join("; ");
}

export const dmarcTags = (v: string | undefined) => (v ? parseTags(v) : {});
