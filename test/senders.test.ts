import { describe, expect, it } from "vitest";
import { analyzeMail, type DnsRecord } from "../src/worker/lib/mail";
import { detectSenders, dmarcValue, mxPreset, proposeSpf } from "../src/worker/lib/senders";

const Z = "esempio.it";
const rec = (type: string, name: string, content: string, extra: Partial<DnsRecord> = {}): DnsRecord => ({ type, name: name === "@" ? Z : `${name}.${Z}`, content, ...extra });
const resolver = { lookup: async (n: string, t: string) => (t === "A" ? ["1.2.3.4"] : []) };

describe("detectSenders", () => {
  it("riconosce chi invia da SPF e DKIM e cosa manca", () => {
    const s = detectSenders(Z, [
      rec("MX", "@", "smtp.google.com", { priority: 1 }),
      rec("TXT", "@", '"v=spf1 include:_spf.google.com include:spf.qboxmail.com ~all"'),
      rec("CNAME", "abc._domainkey", "abc.dkim.amazonses.com"),
      rec("CNAME", "nl1._domainkey", "nl1.dkim.smtpfy.com"),
    ]);
    const by = Object.fromEntries(s.map((x) => [x.id, x]));
    expect(by.google).toMatchObject({ spf: true, dkim: false, receives: true });
    expect(by.qboxmail).toMatchObject({ spf: true, dkim: true, receives: false });
    expect(by.amazonses).toMatchObject({ spf: false, dkim: true });
  });

  it("elenca gli include SPF sconosciuti", () => {
    const s = detectSenders(Z, [rec("TXT", "@", '"v=spf1 include:spf.example.net include:servers.mcsv.net mx -all"')]);
    expect(s.map((x) => x.id)).toEqual(["mailchimp", "other:spf.example.net"]);
  });

  it("riconosce Qboxmail anche con i domini white label e i DKIM di smtpfy", () => {
    const s = detectSenders(Z, [
      rec("MX", "@", "mx01.cbsolt.net", { priority: 10 }),
      rec("TXT", "@", '"v=spf1 include:spf-c.cbsolt.net include:spf.cbsolt.net mx a -all"'),
      rec("CNAME", "nl4685901013._domainkey", "nl4685901013.dkim.smtpfy.com"),
      rec("CNAME", "tr1798236304._domainkey", "tr1798236304.dkim.smtpfy.com"),
    ]);
    expect(s.map((x) => x.id)).toEqual(["qboxmail"]);
    expect(s[0]).toMatchObject({ spf: true, dkim: true, receives: true });
  });

  it("riconosce i selettori DKIM di Qboxmail e Forward Email", () => {
    const s = detectSenders(Z, [rec("TXT", "qbm2312302383._domainkey", '"v=DKIM1; p=abc"'), rec("TXT", "fe-2fa636a07d._domainkey", '"v=DKIM1; p=abc"')]);
    expect(s.filter((x) => x.dkim).map((x) => x.id).sort()).toEqual(["forwardemail", "qboxmail"]);
  });
});

describe("controlli sugli invii", () => {
  it("segnala un servizio nell'SPF senza DKIM e uno con DKIM fuori dall'SPF", async () => {
    const r = await analyzeMail(
      Z,
      [
        rec("MX", "@", "mx01.qboxmail.com", { priority: 10 }),
        rec("TXT", "@", '"v=spf1 include:spf.qboxmail.com ~all"'),
        rec("TXT", "_dmarc", '"v=DMARC1; p=reject"'),
        rec("CNAME", "s1._domainkey", "s1.domainkey.u123.wl.sendgrid.net"),
      ],
      resolver,
    );
    const ids = r.checks.map((c) => `${c.id}:${c.params?.sender ?? ""}`);
    expect(ids).toContain("sender-no-dkim:Qboxmail");
    expect(ids).toContain("sender-no-spf:SendGrid");
    expect(r.checks.find((c) => c.id === "sender-no-spf")).toMatchObject({ fix: "add-spf-include", params: { include: "sendgrid.net" } });
    expect(r.senders.map((s) => s.id)).toEqual(["qboxmail", "sendgrid"]);
  });
});

describe("Qboxmail white label", () => {
  it("con MX cbsolt.net e SPF spf-c.cbsolt.net non segnala nulla su SPF e DKIM", async () => {
    const r = await analyzeMail(
      Z,
      [
        rec("MX", "@", "mx01.cbsolt.net", { priority: 10 }),
        rec("MX", "@", "mx02.cbsolt.net", { priority: 20 }),
        rec("TXT", "@", '"v=spf1 include:spf-c.cbsolt.net mx a -all"'),
        rec("TXT", "_dmarc", '"v=DMARC1; p=reject"'),
        rec("CNAME", "nl4685901013._domainkey", "nl4685901013.dkim.smtpfy.com"),
      ],
      resolver,
    );
    expect(r.provider?.name).toBe("Qboxmail");
    expect(r.checks.filter((c) => c.area === "spf" || c.area === "dkim").map((c) => c.id)).toEqual(["spf-ok", "dkim-ok"]);
  });

  it("senza include propone quello dello stesso dominio white label", async () => {
    const r = await analyzeMail(Z, [rec("MX", "@", "mx01.emailpnl.com", { priority: 10 }), rec("TXT", "@", '"v=spf1 mx -all"')], resolver);
    expect(r.checks.find((c) => c.id === "spf-provider")?.params).toMatchObject({ provider: "Qboxmail", include: "spf.emailpnl.com" });
  });
});

describe("proposeSpf", () => {
  it("unisce più record, toglie i doppioni e aggiunge gli include mancanti", () => {
    expect(proposeSpf(["v=spf1 include:a.net mx ~all", "v=spf1 include:b.net include:a.net -all"], ["c.net", "a.net"])).toBe("v=spf1 include:a.net mx include:b.net include:c.net ~all");
  });

  it("parte da zero e passa a ~all un dominio che prima non spediva", () => {
    expect(proposeSpf([], ["_spf.google.com"])).toBe("v=spf1 include:_spf.google.com ~all");
    expect(proposeSpf(["v=spf1 -all"], ["spf.qboxmail.com"])).toBe("v=spf1 include:spf.qboxmail.com ~all");
  });

  it("toglie un include", () => {
    expect(proposeSpf(["v=spf1 include:a.net include:b.net -all"], [], ["a.net"])).toBe("v=spf1 include:b.net -all");
  });
});

describe("mxPreset", () => {
  it("dà gli MX dei provider", () => {
    expect(mxPreset("google", Z)).toEqual([{ host: "smtp.google.com", priority: 1 }]);
    expect(mxPreset("microsoft", "studio-rossi.it")).toEqual([{ host: "studio-rossi-it.mail.protection.outlook.com", priority: 0 }]);
    expect(mxPreset("qboxmail", Z)).toEqual([
      { host: "mx01.qboxmail.com", priority: 10 },
      { host: "mx02.qboxmail.com", priority: 20 },
    ]);
    expect(mxPreset("forwardemail", Z)).toEqual([
      { host: "mx1.forwardemail.net", priority: 10 },
      { host: "mx2.forwardemail.net", priority: 10 },
    ]);
  });
});

describe("dmarcValue", () => {
  it("cambia criterio e report tenendo gli altri tag", () => {
    expect(dmarcValue("v=DMARC1; p=none; pct=100; rua=mailto:x@y.it", { policy: "quarantine" })).toBe("v=DMARC1; p=quarantine; pct=100; rua=mailto:x@y.it");
    expect(dmarcValue("v=DMARC1; p=none", { policy: "reject", rua: "dmarc@esempio.it" })).toBe("v=DMARC1; p=reject; rua=mailto:dmarc@esempio.it");
    expect(dmarcValue(undefined, { policy: "none" })).toBe("v=DMARC1; p=none");
  });
});
