import { describe, expect, it } from "vitest";
import { addRedirect, applyMailFix, Conflict, deleteRedirect, disableParking, enableParking, setDmarc, setMx, setSpf, updateRedirect } from "../src/worker/actions";
import type { CfApi } from "../src/worker/lib/cf";
import { analyzeMail } from "../src/worker/lib/mail";
import { parkingState, parseRedirects, servedBy, type Rec, type Route, type RulesetRule } from "../src/worker/lib/zone-state";
import type { ZoneData } from "../src/worker/services";

const Z = "esempio.it";
const ZID = "zone1";

// Finta API Cloudflare in memoria: solo gli endpoint che usano le azioni.
class FakeCf {
  records: Rec[] = [];
  routes: Route[] = [];
  ruleset: { id: string; rules: RulesetRule[] } | null = null;
  customDomains: { hostname: string; service: string }[] = [];
  calls: string[] = [];
  private n = 0;
  id = () => `id${++this.n}`;

  async req(method: string, path: string, body?: any): Promise<any> {
    this.calls.push(`${method} ${path}`);
    const p = path.replace(`/zones/${ZID}`, "");
    if (method === "POST" && p === "/dns_records") {
      const r = { id: this.id(), proxied: false, ...body };
      this.records.push(r);
      return r;
    }
    let m = p.match(/^\/dns_records\/(.+)$/);
    if (m && method === "DELETE") return (this.records = this.records.filter((r) => r.id !== m![1])), {};
    if (m && method === "PATCH") return Object.assign(this.records.find((r) => r.id === m![1])!, body);
    if (method === "POST" && p === "/workers/routes") return this.routes.push({ id: this.id(), ...body }), {};
    m = p.match(/^\/workers\/routes\/(.+)$/);
    if (m && method === "DELETE") return (this.routes = this.routes.filter((r) => r.id !== m![1])), {};
    if (m && method === "PUT") return Object.assign(this.routes.find((r) => r.id === m![1])!, body);
    if (method === "PUT" && p.endsWith("/entrypoint")) return (this.ruleset = { id: "rs1", rules: body.rules.map((r: any) => ({ id: this.id(), enabled: true, ...r })) });
    m = p.match(/^\/rulesets\/rs1\/rules$/);
    if (m && method === "POST") return this.ruleset!.rules.push({ id: this.id(), enabled: true, ...body }), {};
    m = p.match(/^\/rulesets\/rs1\/rules\/(.+)$/);
    if (m && method === "PATCH") return Object.assign(this.ruleset!.rules.find((r) => r.id === m![1])!, body);
    if (m && method === "DELETE") return (this.ruleset!.rules = this.ruleset!.rules.filter((r) => r.id !== m![1])), {};
    throw new Error(`endpoint non simulato: ${method} ${path}`);
  }

  data(): ZoneData {
    const parking = parkingState(Z, this.records, this.routes);
    const redirects = parseRedirects(Z, this.ruleset?.rules ?? []);
    return { zone: { id: ZID, name: Z, status: "active", account: { id: "acc", name: "A" } }, records: this.records, routes: this.routes, customDomains: this.customDomains, servedBy: servedBy(Z, this.routes, this.customDomains), ruleset: this.ruleset, parking, redirects, usage: "empty" };
  }
}

const noDns = { lookup: async () => [] };
const api = (f: FakeCf) => f as unknown as CfApi;
const mail = (f: FakeCf) => analyzeMail(Z, f.records, noDns);

describe("parcheggio", () => {
  it("parcheggia un dominio vuoto, protegge la posta e torna indietro pulito", async () => {
    const f = new FakeCf();
    f.records.push({ id: "dm", type: "TXT", name: `_dmarc.${Z}`, content: '"v=DMARC1; p=none;"' });
    await enableParking(api(f), f.data(), true, await mail(f));
    expect(f.data().parking.state).toBe("parked");
    const m = await mail(f);
    expect(m.mode).toBe("protected");
    expect(m.records.dmarc).toEqual(["v=DMARC1; p=reject"]);
    expect(f.records.filter((r) => r.type === "TXT" && r.name === `_dmarc.${Z}`)).toHaveLength(1);

    // Rifarlo non cambia nulla.
    const again = await enableParking(api(f), f.data(), true, m);
    expect(again).toEqual([]);

    await disableParking(api(f), f.data(), true);
    expect(f.data().parking.state).toBe("off");
    expect(f.routes).toEqual([]);
    expect(f.records.some((r) => r.type === "A")).toBe(false);
  });

  it("sposta sul Worker di Dash++ un parcheggio del vecchio Worker", async () => {
    const f = new FakeCf();
    f.records.push({ id: "a", type: "A", name: Z, content: "192.0.2.1", proxied: true }, { id: "b", type: "A", name: `www.${Z}`, content: "192.0.2.1", proxied: true });
    f.routes.push({ id: "r1", pattern: `${Z}/*`, script: "park-16bit" }, { id: "r2", pattern: `www.${Z}/*`, script: "park-16bit" });
    const done = await enableParking(api(f), f.data(), false, await mail(f));
    expect(done.map((d) => d.op)).toEqual(["route.migrate", "route.migrate"]);
    expect(f.data().parking).toMatchObject({ state: "parked", legacy: false });
  });

  it("non parcheggia né fa redirect di un dominio servito da un Worker come Custom Domain", async () => {
    const f = new FakeCf();
    f.customDomains.push({ hostname: Z, service: "sito" });
    await expect(enableParking(api(f), f.data(), false, await mail(f))).rejects.toMatchObject({ code: "served-by-worker", params: { worker: "sito" } });
    const base = { status: 301 as const, preservePath: false, preserveQuery: false, includeWww: true };
    await expect(addRedirect(api(f), f.data(), { ...base, target: "https://altro.it" })).rejects.toMatchObject({ code: "served-by-worker" });
    expect(f.calls).toEqual([]);
  });

  it("non tocca un record esistente senza proxy", async () => {
    const f = new FakeCf();
    f.records.push({ id: "a", type: "A", name: Z, content: "1.2.3.4", proxied: false });
    await expect(enableParking(api(f), f.data(), false, await mail(f))).rejects.toThrow(Conflict);
    expect(f.records).toHaveLength(1);
    expect(f.routes).toEqual([]);
  });

  it("rifiuta di parcheggiare un dominio servito da un altro Worker", async () => {
    const f = new FakeCf();
    f.routes.push({ id: "r", pattern: `${Z}/*`, script: "sito" });
    await expect(enableParking(api(f), f.data(), false, await mail(f))).rejects.toMatchObject({ code: "served-by-worker", params: { worker: "sito" } });
  });
});

describe("redirect", () => {
  it("crea il ruleset se manca, poi aggiunge e toglie la regola con i segnaposto", async () => {
    const f = new FakeCf();
    await addRedirect(api(f), f.data(), { target: "https://nuovo.it/", status: 301, preservePath: true, preserveQuery: false, includeWww: true });
    const [r] = f.data().redirects;
    expect(r).toMatchObject({ target: "https://nuovo.it", hosts: [Z, `www.${Z}`], preservePath: true });
    expect(f.records.filter((x) => x.proxied)).toHaveLength(2);

    await expect(addRedirect(api(f), f.data(), { target: "https://altro.it", status: 301, preservePath: false, preserveQuery: false, includeWww: false })).rejects.toMatchObject({ code: "redirect-exists" });

    await deleteRedirect(api(f), f.data(), r.id, true);
    expect(f.data().redirects).toEqual([]);
    expect(f.records).toEqual([]);
  });

  it("modifica un redirect esistente", async () => {
    const f = new FakeCf();
    const base = { status: 301 as const, preservePath: false, preserveQuery: false, includeWww: false };
    await addRedirect(api(f), f.data(), { ...base, target: "https://primo.it" });
    const [r] = f.data().redirects;
    await updateRedirect(api(f), f.data(), r.id, { ...base, target: "https://secondo.it", status: 302, includeWww: true });
    expect(f.data().redirects).toEqual([expect.objectContaining({ id: r.id, target: "https://secondo.it", status: 302, hosts: [Z, `www.${Z}`] })]);
    expect(f.records.filter((x) => x.proxied)).toHaveLength(2);
  });

  it("gestisce più redirect: un sottodominio e un percorso, anche su un dominio parcheggiato", async () => {
    const f = new FakeCf();
    f.records.push({ id: "a", type: "A", name: Z, content: "192.0.2.1", proxied: true }, { id: "b", type: "A", name: `www.${Z}`, content: "192.0.2.1", proxied: true });
    f.routes.push({ id: "r1", pattern: `${Z}/*`, script: "dash-plus-plus-park" }, { id: "r2", pattern: `www.${Z}/*`, script: "dash-plus-plus-park" });
    const base = { status: 301 as const, preservePath: false, preserveQuery: false, includeWww: false };
    await addRedirect(api(f), f.data(), { ...base, host: `shop.${Z}`, target: "https://negozio.it" });
    await addRedirect(api(f), f.data(), { ...base, path: "/promo", target: "https://promo.it" });
    expect(f.data().redirects.map((r) => [r.hosts.join(","), r.path])).toEqual([
      [`shop.${Z}`, null],
      [Z, "/promo"],
    ]);
    expect(f.records.some((r) => r.name === `shop.${Z}` && r.proxied)).toBe(true);
    // Lo stesso percorso due volte no; il dominio intero resta bloccato perché è parcheggiato.
    await expect(addRedirect(api(f), f.data(), { ...base, path: "/promo", target: "https://altro.it" })).rejects.toMatchObject({ code: "redirect-exists" });
    await expect(addRedirect(api(f), f.data(), { ...base, target: "https://altro.it" })).rejects.toMatchObject({ code: "is-parked" });
    // Togliendo il redirect del sottodominio sparisce anche il suo segnaposto, non quelli del parcheggio.
    await deleteRedirect(api(f), f.data(), f.data().redirects[0].id, true);
    expect(f.records.map((r) => r.name)).toEqual([Z, `www.${Z}`]);
  });

  it("togliendo un redirect con percorso toglie il segnaposto del sottodominio rimasto libero", async () => {
    const f = new FakeCf();
    const base = { status: 301 as const, preservePath: false, preserveQuery: false, includeWww: false };
    await addRedirect(api(f), f.data(), { ...base, host: "blog", path: "/vecchio", pathPrefix: true, target: "https://nuovo.it" });
    expect(f.records.map((r) => r.name)).toEqual([`blog.${Z}`]);
    await deleteRedirect(api(f), f.data(), f.data().redirects[0].id, true);
    expect(f.records).toEqual([]);
  });

  it("rifiuta un nome che non appartiene al dominio", async () => {
    const f = new FakeCf();
    await expect(addRedirect(api(f), f.data(), { host: "altro.com", target: "https://x.it", status: 301, preservePath: false, preserveQuery: false, includeWww: false })).rejects.toMatchObject({ code: "host-invalid" });
  });

  it("rifiuta destinazioni non valide o verso lo stesso dominio", async () => {
    const f = new FakeCf();
    const base = { status: 301 as const, preservePath: false, preserveQuery: false, includeWww: true };
    await expect(addRedirect(api(f), f.data(), { ...base, target: "ftp://x.it" })).rejects.toThrow(Conflict);
    await expect(addRedirect(api(f), f.data(), { ...base, target: `https://www.${Z}` })).rejects.toMatchObject({ code: "target-self" });
    expect(f.calls).toEqual([]);
  });
});

describe("correzioni posta", () => {
  it("aggiunge DMARC con indirizzo per i report e rifiuta un secondo DMARC", async () => {
    const f = new FakeCf();
    f.records.push({ id: "mx", type: "MX", name: Z, content: "mx.esempio.net", priority: 10 });
    await applyMailFix(api(f), f.data(), await mail(f), "add-dmarc", { policy: "quarantine", rua: "report@esempio.it" });
    expect((await mail(f)).records.dmarc).toEqual(["v=DMARC1; p=quarantine; rua=mailto:report@esempio.it;"]);
    await expect(applyMailFix(api(f), f.data(), await mail(f), "add-dmarc", {})).rejects.toMatchObject({ code: "dmarc-exists" });
  });

  it("non protegge come 'senza posta' un dominio che riceve posta", async () => {
    const f = new FakeCf();
    f.records.push({ id: "mx", type: "MX", name: Z, content: "mx.esempio.net", priority: 10 });
    await expect(applyMailFix(api(f), f.data(), await mail(f), "protect-no-mail", {})).rejects.toMatchObject({ code: "receives-mail" });
  });

  it("propone l'SPF del provider riconosciuto", async () => {
    const f = new FakeCf();
    f.records.push({ id: "mx", type: "MX", name: Z, content: "smtp.google.com", priority: 1 });
    await applyMailFix(api(f), f.data(), await mail(f), "add-spf", {});
    expect((await mail(f)).records.spf).toEqual(["v=spf1 include:_spf.google.com ~all"]);
  });
});

describe("strumenti posta", () => {
  it("imposta gli MX di un provider togliendo quelli vecchi e aggiorna l'SPF", async () => {
    const f = new FakeCf();
    f.records.push(
      { id: "mx0", type: "MX", name: Z, content: ".", priority: 0 },
      { id: "spf", type: "TXT", name: Z, content: '"v=spf1 -all"' },
    );
    await setMx(api(f), f.data(), "qboxmail", true);
    const m = await mail(f);
    expect(m.records.mx).toEqual([
      { host: "mx01.qboxmail.com", priority: 10 },
      { host: "mx02.qboxmail.com", priority: 20 },
    ]);
    expect(m.records.spf).toEqual(["v=spf1 include:spf.qboxmail.com ~all"]);
  });

  it("cambiando provider toglie dall'SPF quello vecchio", async () => {
    const f = new FakeCf();
    f.records.push({ id: "mx", type: "MX", name: Z, content: "smtp.google.com", priority: 1 }, { id: "spf", type: "TXT", name: Z, content: '"v=spf1 include:_spf.google.com include:servers.mcsv.net ~all"' });
    await setMx(api(f), f.data(), "qboxmail", true);
    expect((await mail(f)).records.spf).toEqual(["v=spf1 include:servers.mcsv.net include:spf.qboxmail.com ~all"]);
  });

  it("riscrive l'SPF in un solo record", async () => {
    const f = new FakeCf();
    f.records.push({ id: "s1", type: "TXT", name: Z, content: '"v=spf1 include:a.net -all"' }, { id: "s2", type: "TXT", name: Z, content: '"v=spf1 include:b.net -all"' });
    await setSpf(api(f), f.data(), "v=spf1 include:a.net include:b.net -all");
    expect((await mail(f)).records.spf).toEqual(["v=spf1 include:a.net include:b.net -all"]);
    await expect(setSpf(api(f), f.data(), "include:x.net")).rejects.toMatchObject({ code: "spf-invalid" });
  });

  it("aggiunge un include all'SPF esistente", async () => {
    const f = new FakeCf();
    f.records.push({ id: "mx", type: "MX", name: Z, content: "mx01.qboxmail.com", priority: 10 }, { id: "s1", type: "TXT", name: Z, content: '"v=spf1 mx -all"' });
    await applyMailFix(api(f), f.data(), await mail(f), "add-spf-include", { include: "sendgrid.net" });
    expect((await mail(f)).records.spf).toEqual(["v=spf1 mx include:sendgrid.net -all"]);
  });

  it("cambia il criterio DMARC tenendo gli altri tag", async () => {
    const f = new FakeCf();
    f.records.push({ id: "d", type: "TXT", name: `_dmarc.${Z}`, content: '"v=DMARC1; p=none; rua=mailto:r@cf.net"' });
    await setDmarc(api(f), f.data(), { policy: "reject" });
    expect((await mail(f)).records.dmarc).toEqual(["v=DMARC1; p=reject; rua=mailto:r@cf.net"]);
  });
});

describe("posta dei sottodomini", () => {
  const S = `send.${Z}`;

  it("imposta SPF, MX e DMARC di un sottodominio senza toccare il dominio principale", async () => {
    const f = new FakeCf();
    f.records.push({ id: "spf", type: "TXT", name: Z, content: '"v=spf1 include:_spf.google.com ~all"' }, { id: "s2", type: "TXT", name: S, content: '"v=spf1 include:amazonses.com ~all"' });
    await setSpf(api(f), f.data(), "v=spf1 include:amazonses.com -all", S);
    await setMx(api(f), f.data(), "none", false, S);
    await setDmarc(api(f), f.data(), { policy: "reject" }, S);
    const m = await mail(f);
    expect(m.records.spf).toEqual(["v=spf1 include:_spf.google.com ~all"]);
    expect(m.records.dmarc).toEqual([]);
    const s = m.subdomains.find((x) => x.name === S)!;
    expect(s.records.spf).toEqual(["v=spf1 include:amazonses.com -all"]);
    expect(s.records.mx).toEqual([{ host: "", priority: 0 }]);
    expect(s.records.dmarc).toEqual(["v=DMARC1; p=reject"]);
  });

  it("applica le correzioni al sottodominio indicato", async () => {
    const f = new FakeCf();
    f.records.push({ id: "mx", type: "MX", name: S, content: "smtp.google.com", priority: 1 });
    await applyMailFix(api(f), f.data(), await mail(f), "add-spf", {}, S);
    const m = await mail(f);
    expect(m.records.spf).toEqual([]);
    expect(m.subdomains.find((x) => x.name === S)!.records.spf).toEqual(["v=spf1 include:_spf.google.com ~all"]);
  });

  it("rifiuta nomi fuori dal dominio, tecnici o jolly", async () => {
    const f = new FakeCf();
    for (const name of ["altro.it", `_spf.${Z}`, `*.${Z}`, `a._domainkey.${Z}`]) {
      await expect(setSpf(api(f), f.data(), "v=spf1 -all", name)).rejects.toMatchObject({ code: "name-invalid" });
    }
  });

  it("proteggendo il dominio copre anche i sottodomini e tiene l'indirizzo dei report", async () => {
    const f = new FakeCf();
    f.records.push({ id: "d", type: "TXT", name: `_dmarc.${Z}`, content: '"v=DMARC1; p=none; sp=none; rua=mailto:r@cf.net"' });
    await applyMailFix(api(f), f.data(), await mail(f), "protect-no-mail", {});
    const m = await mail(f);
    expect(m.mode).toBe("protected");
    expect(m.records.dmarc).toEqual(["v=DMARC1; p=reject; sp=reject; rua=mailto:r@cf.net"]);
    expect(f.records.filter((r) => r.name === `*.${Z}`).map((r) => r.content)).toEqual(['"v=spf1 -all"']);
    expect(m.checks.map((c) => c.id)).not.toContain("subs-unprotected");
  });

  it("protegge un sottodominio senza posta senza toccare il dominio principale", async () => {
    const f = new FakeCf();
    f.records.push({ id: "spf", type: "TXT", name: Z, content: '"v=spf1 include:_spf.google.com ~all"' }, { id: "mx", type: "MX", name: `news.${Z}`, content: ".", priority: 0 });
    const before = await mail(f);
    expect(before.subdomains[0].checks.find((c) => c.fix === "protect-no-mail")).toBeTruthy();
    await applyMailFix(api(f), f.data(), before, "protect-no-mail", {}, `news.${Z}`);
    const m = await mail(f);
    expect(m.records.spf).toEqual(["v=spf1 include:_spf.google.com ~all"]);
    expect(m.subdomains.find((x) => x.name === `news.${Z}`)!.mode).toBe("protected");
    expect(f.records.some((r) => r.name.startsWith("*"))).toBe(false);
  });

  it("non protegge un sottodominio che riceve posta", async () => {
    const f = new FakeCf();
    f.records.push({ id: "mx", type: "MX", name: S, content: "smtp.google.com", priority: 1 });
    await expect(applyMailFix(api(f), f.data(), await mail(f), "protect-no-mail", {}, S)).rejects.toMatchObject({ code: "receives-mail" });
  });

  it("non aggiunge il jolly se il dominio ha già record jolly", async () => {
    const f = new FakeCf();
    f.records.push({ id: "w", type: "A", name: `*.${Z}`, content: "192.0.2.1", proxied: true });
    const done = await applyMailFix(api(f), f.data(), await mail(f), "protect-no-mail", {});
    expect(f.records.filter((r) => r.name === `*.${Z}`)).toHaveLength(1);
    expect(done.some((d) => d.name === `*.${Z}`)).toBe(false);
  });
});
