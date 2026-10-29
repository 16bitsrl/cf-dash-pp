import { describe, expect, it } from "vitest";
import { analyzeMail, type DnsRecord, type Resolver } from "../src/worker/lib/mail";

const Z = "esempio.it";
const rec = (type: string, name: string, content: string, extra: Partial<DnsRecord> = {}): DnsRecord => ({
  type,
  name: name === "@" ? Z : `${name}.${Z}`,
  content,
  ...extra,
});

// Il DNS esterno è l'unica cosa che non controlliamo: un risolutore finto con risposte fisse.
const fakeResolver = (answers: Record<string, string[]> = {}): Resolver => ({
  async lookup(name, type) {
    return answers[`${type} ${name}`] ?? [];
  },
});

const ids = (r: Awaited<ReturnType<typeof analyzeMail>>, level?: string) =>
  r.checks.filter((c) => !level || c.level === level).map((c) => c.id);

describe("analyzeMail", () => {
  it("riconosce un dominio senza posta protetto", async () => {
    const r = await analyzeMail(
      Z,
      [
        rec("MX", "@", ".", { priority: 0 }),
        rec("TXT", "@", '"v=spf1 -all"'),
        rec("TXT", "_dmarc", '"v=DMARC1; p=reject; rua=mailto:x@dmarc-reports.cloudflare.net;"'),
      ],
      fakeResolver(),
    );
    expect(r.mode).toBe("protected");
    expect(ids(r, "error")).toEqual([]);
    expect(ids(r, "warning")).toEqual([]);
  });

  it("segnala un dominio senza posta e senza protezione", async () => {
    const r = await analyzeMail(Z, [rec("A", "@", "192.0.2.1", { proxied: true })], fakeResolver());
    expect(r.mode).toBe("none");
    expect(ids(r)).toContain("none-unprotected");
    expect(r.checks.find((c) => c.id === "none-unprotected")?.fix).toBe("protect-no-mail");
  });

  it("rileva Google Workspace e la mancanza di DKIM", async () => {
    const r = await analyzeMail(
      Z,
      [
        rec("MX", "@", "smtp.google.com", { priority: 1 }),
        rec("TXT", "@", '"v=spf1 include:_spf.google.com ~all"'),
        rec("TXT", "_dmarc", '"v=DMARC1; p=quarantine"'),
      ],
      fakeResolver({ "A smtp.google.com": ["142.250.1.26"], "TXT _spf.google.com": ["v=spf1 include:_netblocks.google.com ~all"] }),
    );
    expect(r.provider?.id).toBe("google");
    expect(r.mode).toBe("mail");
    expect(ids(r, "warning")).toContain("dkim-missing");
  });

  it("considera ok Microsoft 365 con i selettori DKIM", async () => {
    const r = await analyzeMail(
      Z,
      [
        rec("MX", "@", "esempio-it.mail.protection.outlook.com", { priority: 0 }),
        rec("TXT", "@", '"v=spf1 include:spf.protection.outlook.com -all"'),
        rec("TXT", "_dmarc", '"v=DMARC1; p=reject; rua=mailto:a@esempio.it"'),
        rec("CNAME", "selector1._domainkey", "selector1-esempio-it._domainkey.esempio.onmicrosoft.com"),
        rec("CNAME", "selector2._domainkey", "selector2-esempio-it._domainkey.esempio.onmicrosoft.com"),
      ],
      fakeResolver({
        "A esempio-it.mail.protection.outlook.com": ["52.101.1.1"],
        "TXT spf.protection.outlook.com": ["v=spf1 ip4:40.92.0.0/15 -all"],
      }),
    );
    expect(r.provider?.id).toBe("microsoft");
    expect(ids(r, "error")).toEqual([]);
    expect(ids(r, "warning")).toEqual([]);
  });

  it("segnala due record SPF", async () => {
    const r = await analyzeMail(
      Z,
      [
        rec("MX", "@", "mx.esempio.net", { priority: 10 }),
        rec("TXT", "@", '"v=spf1 include:a.net -all"'),
        rec("TXT", "@", '"v=spf1 include:b.net -all"'),
      ],
      fakeResolver({ "A mx.esempio.net": ["1.2.3.4"] }),
    );
    expect(ids(r, "error")).toContain("spf-multiple");
  });

  it("unisce le stringhe TXT spezzate", async () => {
    const r = await analyzeMail(
      Z,
      [rec("MX", "@", "mx.esempio.net", { priority: 10 }), rec("TXT", "@", '"v=spf1 include:a.net " "-all"')],
      fakeResolver({ "A mx.esempio.net": ["1.2.3.4"] }),
    );
    expect(r.records.spf).toEqual(["v=spf1 include:a.net -all"]);
  });

  it("conta le ricerche DNS dello SPF oltre il limite di 10", async () => {
    const answers: Record<string, string[]> = { "A mx.esempio.net": ["1.2.3.4"] };
    for (let i = 0; i < 11; i++) answers[`TXT i${i}.net`] = ["v=spf1 ip4:1.1.1.1 -all"];
    const spf = `v=spf1 ${Array.from({ length: 11 }, (_, i) => `include:i${i}.net`).join(" ")} -all`;
    const r = await analyzeMail(
      Z,
      [rec("MX", "@", "mx.esempio.net", { priority: 10 }), rec("TXT", "@", `"${spf}"`)],
      fakeResolver(answers),
    );
    expect(ids(r, "error")).toContain("spf-lookups");
    expect(r.spfLookups).toBe(11);
  });

  it("segnala SPF +all, DMARC p=none e DMARC mancante", async () => {
    const plus = await analyzeMail(
      Z,
      [rec("MX", "@", "mx.esempio.net", { priority: 10 }), rec("TXT", "@", '"v=spf1 +all"')],
      fakeResolver({ "A mx.esempio.net": ["1.2.3.4"] }),
    );
    expect(ids(plus, "error")).toContain("spf-pass-all");
    expect(ids(plus)).toContain("dmarc-missing");

    const none = await analyzeMail(
      Z,
      [
        rec("MX", "@", "mx.esempio.net", { priority: 10 }),
        rec("TXT", "@", '"v=spf1 mx -all"'),
        rec("TXT", "_dmarc", '"v=DMARC1; p=none"'),
      ],
      fakeResolver({ "A mx.esempio.net": ["1.2.3.4"] }),
    );
    expect(ids(none, "warning")).toContain("dmarc-none");
  });

  it("segnala MX nullo insieme ad altri MX", async () => {
    const r = await analyzeMail(
      Z,
      [rec("MX", "@", ".", { priority: 0 }), rec("MX", "@", "mx.esempio.net", { priority: 10 })],
      fakeResolver({ "A mx.esempio.net": ["1.2.3.4"] }),
    );
    expect(ids(r, "error")).toContain("mx-null-mixed");
  });

  it("segnala un MX che punta a un nome con proxy attivo", async () => {
    const r = await analyzeMail(
      Z,
      [
        rec("MX", "@", `mail.${Z}`, { priority: 10 }),
        rec("A", "mail", "1.2.3.4", { proxied: true }),
        rec("TXT", "@", '"v=spf1 mx -all"'),
      ],
      fakeResolver(),
    );
    expect(ids(r, "error")).toContain("mx-proxied");
  });

  it("segnala un MX che non risolve", async () => {
    const r = await analyzeMail(
      Z,
      [rec("MX", "@", "mx.sparito.net", { priority: 10 }), rec("TXT", "@", '"v=spf1 mx -all"')],
      fakeResolver(),
    );
    expect(ids(r, "error")).toContain("mx-unresolved");
  });

  it("segnala una chiave DKIM debole", async () => {
    // Chiave RSA a 512 bit: modulo di 64 byte.
    const weak = "MFwwDQYJKoZIhvcNAQEBBQADSwAwSAJBAL" + "A".repeat(80) + "CAwEAAQ==";
    const r = await analyzeMail(
      Z,
      [
        rec("MX", "@", "mx.esempio.net", { priority: 10 }),
        rec("TXT", "@", '"v=spf1 mx -all"'),
        rec("TXT", "_dmarc", '"v=DMARC1; p=reject"'),
        rec("TXT", "default._domainkey", `"v=DKIM1; k=rsa; p=${weak}"`),
      ],
      fakeResolver({ "A mx.esempio.net": ["1.2.3.4"] }),
    );
    expect(ids(r, "error")).toContain("dkim-weak");
  });

  it("riconosce i vecchi MX di Google: vanno bene, ma si può passare al record unico", async () => {
    const legacy = ["aspmx.l.google.com", "alt1.aspmx.l.google.com", "alt2.aspmx.l.google.com", "alt3.aspmx.l.google.com", "alt4.aspmx.l.google.com"];
    const answers = Object.fromEntries(legacy.map((h) => [`A ${h}`, ["1.2.3.4"]]));
    const r = await analyzeMail(
      Z,
      [...legacy.map((h, i) => rec("MX", "@", h, { priority: [1, 5, 5, 10, 10][i] })), rec("TXT", "@", '"v=spf1 include:_spf.google.com ~all"')],
      fakeResolver(answers),
    );
    expect(r.provider?.id).toBe("google");
    expect(r.checks.find((c) => c.id === "mx-google-legacy")).toMatchObject({ level: "info" });
    expect(ids(r, "warning")).not.toContain("mx-google-mixed");
  });

  it("segnala vecchi e nuovi MX di Google insieme", async () => {
    const r = await analyzeMail(
      Z,
      [rec("MX", "@", "smtp.google.com", { priority: 1 }), rec("MX", "@", "aspmx.l.google.com", { priority: 1 }), rec("TXT", "@", '"v=spf1 include:_spf.google.com ~all"')],
      fakeResolver({ "A smtp.google.com": ["1.1.1.1"], "A aspmx.l.google.com": ["1.1.1.1"] }),
    );
    expect(ids(r, "warning")).toContain("mx-google-mixed");
    expect(ids(r)).not.toContain("mx-google-legacy");
  });
});
