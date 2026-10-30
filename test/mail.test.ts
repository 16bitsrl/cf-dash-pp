import { describe, expect, it } from "vitest";
import { analyzeMail, type DnsRecord, type NameReport, type Resolver } from "../src/worker/lib/mail";

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

const ids = (r: NameReport, level?: string) =>
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

describe("sottodomini", () => {
  const sub = (r: Awaited<ReturnType<typeof analyzeMail>>, name: string) => r.subdomains.find((s) => s.name === `${name}.${Z}`)!;

  it("analizza a parte il sottodominio di un servizio di invio, senza falsi allarmi", async () => {
    const r = await analyzeMail(
      Z,
      [
        rec("MX", "@", "smtp.google.com", { priority: 1 }),
        rec("TXT", "@", '"v=spf1 include:_spf.google.com ~all"'),
        rec("TXT", "google._domainkey", '"v=DKIM1; k=rsa; p=' + "A".repeat(392) + '"'),
        rec("TXT", "resend._domainkey", '"v=DKIM1; k=rsa; p=' + "A".repeat(216) + '"'),
        rec("TXT", "_dmarc", '"v=DMARC1; p=quarantine; rua=mailto:d@esempio.it"'),
        rec("MX", "send", "feedback-smtp.eu-west-1.amazonses.com", { priority: 10 }),
        rec("TXT", "send", '"v=spf1 include:amazonses.com ~all"'),
      ],
      fakeResolver({ "A smtp.google.com": ["1.1.1.1"], "A feedback-smtp.eu-west-1.amazonses.com": ["1.1.1.1"] }),
    );
    expect(r.subdomains.map((s) => s.name)).toEqual([`send.${Z}`]);
    const s = sub(r, "send");
    expect(s.mode).toBe("mail");
    expect(s.senders.map((x) => x.id)).toEqual(["amazonses"]);
    expect(ids(s, "error")).toEqual([]);
    expect(ids(s, "warning")).toEqual([]);
    expect(s.checks.find((c) => c.id === "dmarc-inherited")).toMatchObject({ level: "ok", params: { policy: "quarantine" } });
    expect(s.checks.every((c) => c.name === `send.${Z}`)).toBe(true);
    // Il dominio principale non vede i record del sottodominio.
    expect(r.senders.map((x) => x.id)).toEqual(["google"]);
    expect(r.records.mx.map((m) => m.host)).toEqual(["smtp.google.com"]);
  });

  it("segnala i problemi di un sottodominio e li conta nel totale", async () => {
    const r = await analyzeMail(
      Z,
      [
        rec("MX", "@", ".", { priority: 0 }),
        rec("TXT", "@", '"v=spf1 -all"'),
        rec("TXT", "_dmarc", '"v=DMARC1; p=reject;"'),
        rec("MX", "lists", "mx.esempio.it", { priority: 10 }),
        rec("TXT", "lists", '"v=spf1 mx -all"'),
        rec("TXT", "lists", '"v=spf1 a -all"'),
      ],
      fakeResolver(),
    );
    const s = sub(r, "lists");
    expect(ids(s, "error")).toEqual(expect.arrayContaining(["mx-missing", "spf-multiple"]));
    expect(r.score.errors).toBe(0);
    expect(r.total.errors).toBe(s.score.errors);
  });

  it("trova i sottodomini anche solo da DMARC o DKIM, ignora nomi tecnici e jolly", async () => {
    const r = await analyzeMail(
      Z,
      [
        rec("TXT", "_dmarc", '"v=DMARC1; p=reject; sp=none"'),
        rec("TXT", "_dmarc.news", '"v=DMARC1; p=none"'),
        rec("TXT", "s1._domainkey.mkt", '"v=DKIM1; k=rsa; p=' + "A".repeat(392) + '"'),
        rec("TXT", "_spf", '"v=spf1 ip4:192.0.2.1 -all"'),
        rec("TXT", "*", '"v=spf1 -all"'),
      ],
      fakeResolver(),
    );
    expect(r.subdomains.map((s) => s.name)).toEqual([`mkt.${Z}`, `news.${Z}`]);
    expect(ids(sub(r, "news"), "warning")).toContain("dmarc-none");
    expect(sub(r, "mkt").checks.find((c) => c.id === "dmarc-inherited")).toMatchObject({ level: "info", params: { policy: "none" } });
    expect(sub(r, "mkt").records.dkim.map((d) => d.selector)).toEqual(["s1"]);
  });

  it("riconosce la PEC di Aruba su un sottodominio", async () => {
    const r = await analyzeMail(
      Z,
      [rec("MX", "@", "smtp.google.com", { priority: 1 }), rec("TXT", "@", '"v=spf1 include:_spf.google.com ~all"'), rec("TXT", "_dmarc", '"v=DMARC1; p=reject"'), rec("MX", "pec", "mx.pec.aruba.it", { priority: 10 }), rec("TXT", "pec", '"v=spf1 include:pec.aruba.it -all"')],
      fakeResolver({ "A smtp.google.com": ["1.1.1.1"], "A mx.pec.aruba.it": ["1.1.1.1"] }),
    );
    const s = sub(r, "pec");
    expect(s.provider?.name).toBe("Aruba PEC");
    expect(s.senders.map((x) => x.id)).toEqual(["arubapec"]);
    expect(ids(s, "warning")).toEqual([]);
  });

  it("su un sottodominio che riceve, l'SPF mancante è un avviso", async () => {
    const r = await analyzeMail(Z, [rec("MX", "app", "mx1.forwardemail.net", { priority: 10 })], fakeResolver({ "A mx1.forwardemail.net": ["1.1.1.1"] }));
    expect(sub(r, "app").checks.find((c) => c.id === "spf-missing")?.level).toBe("warning");
  });

  it("segnala un sottodominio senza DMARC proprio né ereditabile", async () => {
    const r = await analyzeMail(Z, [rec("MX", "pec", "mx.pec.aruba.it", { priority: 10 }), rec("TXT", "pec", '"v=spf1 include:pec.aruba.it -all"')], fakeResolver({ "A mx.pec.aruba.it": ["1.1.1.1"] }));
    expect(sub(r, "pec").checks.find((c) => c.id === "dmarc-missing")).toMatchObject({ level: "warning", fix: "add-dmarc" });
  });

  it("non eredita da un DMARC con criterio non valido", async () => {
    const r = await analyzeMail(Z, [rec("TXT", "_dmarc", '"v=DMARC1; p=invalid; sp=reject"'), rec("TXT", "send", '"v=spf1 include:amazonses.com -all"')], fakeResolver());
    expect(ids(sub(r, "send"))).not.toContain("dmarc-inherited");
    expect(ids(sub(r, "send"), "warning")).toContain("dmarc-missing");
  });

  it("eredita dal dominio intermedio che si dichiara dominio di riferimento (psd=n)", async () => {
    const r = await analyzeMail(
      Z,
      [rec("TXT", "_dmarc", '"v=DMARC1; p=reject"'), rec("TXT", "_dmarc.team", '"v=DMARC1; p=none; sp=none; psd=n"'), rec("TXT", "send.team", '"v=spf1 include:amazonses.com -all"')],
      fakeResolver(),
    );
    expect(sub(r, "send.team").checks.find((c) => c.id === "dmarc-inherited")).toMatchObject({ params: { policy: "none", from: `team.${Z}` } });
  });

  it("senza psd=n segue il DMARC del dominio principale anche sotto un intermedio", async () => {
    const r = await analyzeMail(Z, [rec("TXT", "_dmarc", '"v=DMARC1; p=reject"'), rec("TXT", "_dmarc.team", '"v=DMARC1; p=none"'), rec("TXT", "send.team", '"v=spf1 -all"')], fakeResolver());
    expect(sub(r, "send.team").checks.find((c) => c.id === "dmarc-inherited")).toMatchObject({ params: { policy: "reject", from: Z } });
  });

  it("su un dominio protetto segnala i sottodomini scoperti", async () => {
    const base = [rec("MX", "@", ".", { priority: 0 }), rec("TXT", "@", '"v=spf1 -all"')];
    const open = await analyzeMail(Z, [...base, rec("TXT", "_dmarc", '"v=DMARC1; p=reject; sp=none"')], fakeResolver());
    expect(open.mode).toBe("protected");
    expect(open.checks.find((c) => c.id === "subs-unprotected")?.fix).toBe("protect-no-mail");
    expect(open.checks.find((c) => c.id === "dmarc-sp-weak")?.fix).toBe("protect-no-mail");

    const closed = await analyzeMail(Z, [...base, rec("TXT", "_dmarc", '"v=DMARC1; p=reject;"'), rec("TXT", "*", '"v=spf1 -all"')], fakeResolver());
    expect(ids(closed)).not.toContain("subs-unprotected");
    expect(ids(closed)).not.toContain("dmarc-sp-weak");
  });
});
