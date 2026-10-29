import { describe, expect, it } from "vitest";
import { diffRecords, displayRecords, parkingState, parseRedirects, redirectRule, servedBy, zoneUsage, type CustomDomain, type Rec, type Route } from "../src/worker/lib/zone-state";

const Z = "esempio.it";

describe("parkingState", () => {
  const routes = [
    { id: "r1", pattern: `${Z}/*`, script: "park-16bit" },
    { id: "r2", pattern: `www.${Z}/*`, script: "park-16bit" },
  ];
  const records = [
    { id: "a", type: "A", name: Z, content: "192.0.2.1", proxied: true },
    { id: "b", type: "A", name: `www.${Z}`, content: "192.0.2.1", proxied: true },
  ];

  it("riconosce un dominio parcheggiato", () => {
    expect(parkingState(Z, records, routes)).toMatchObject({ state: "parked", script: "park-16bit", legacy: true, missing: [] });
  });

  it("riconosce il Worker di parcheggio di Dash++", () => {
    const own = routes.map((r) => ({ ...r, script: "dash-plus-plus-park" }));
    expect(parkingState(Z, records, own)).toMatchObject({ state: "parked", legacy: false });
  });

  it("segnala un parcheggio a metà", () => {
    const s = parkingState(Z, records.slice(0, 1), routes.slice(0, 1));
    expect(s.state).toBe("partial");
    expect(s.missing).toEqual(["route www", "record www"]);
  });

  it("segnala un record senza proxy come mancante", () => {
    const s = parkingState(Z, [records[0], { ...records[1], proxied: false }], routes);
    expect(s.state).toBe("partial");
    expect(s.missing).toEqual(["record www"]);
  });

  it("non considera parcheggiato un dominio con route di altri Worker", () => {
    const s = parkingState(Z, records, [{ id: "x", pattern: `${Z}/*`, script: "sito" }]);
    expect(s.state).toBe("off");
  });
});

describe("redirect", () => {
  const dnscontrolRule = {
    id: "r1",
    description: "gidinet redirect",
    enabled: true,
    action: "redirect",
    expression: `(http.host in {"${Z}" "www.${Z}"})`,
    action_parameters: {
      from_value: { status_code: 301, target_url: { expression: 'concat("https://esempio.com", "/")' }, preserve_query_string: false },
    },
  };

  it("legge un redirect scritto da dnscontrol", () => {
    expect(parseRedirects(Z, [dnscontrolRule])).toEqual([
      {
        id: "r1",
        description: "gidinet redirect",
        enabled: true,
        hosts: [Z, `www.${Z}`],
        target: "https://esempio.com",
        status: 301,
        preservePath: false,
        preserveQuery: false,
        path: null,
        pathPrefix: false,
      },
    ]);
  });

  it("crea e rilegge un redirect di un sottodominio con un percorso", () => {
    const rule = redirectRule(Z, { host: `blog.${Z}`, path: "/vecchio", pathPrefix: true, target: "https://nuovo.it/blog", status: 302, preservePath: false, preserveQuery: false, includeWww: true });
    expect(rule.expression).toBe(`(http.host in {"blog.${Z}"} and starts_with(http.request.uri.path, "/vecchio"))`);
    const [parsed] = parseRedirects(Z, [{ ...rule, id: "p", enabled: true }]);
    expect(parsed).toMatchObject({ hosts: [`blog.${Z}`], path: "/vecchio", pathPrefix: true, target: "https://nuovo.it/blog", status: 302 });
    const exact = redirectRule(Z, { path: "/promo", target: "https://x.it", status: 301, preservePath: false, preserveQuery: false, includeWww: false });
    expect(exact.expression).toBe(`(http.host in {"${Z}"} and http.request.uri.path eq "/promo")`);
    expect(parseRedirects(Z, [{ ...exact, id: "e", enabled: true }])[0]).toMatchObject({ path: "/promo", pathPrefix: false, hosts: [Z] });
  });

  it("crea una regola che conserva il percorso e si rilegge uguale", () => {
    const rule = redirectRule(Z, { target: "https://nuovo.it", status: 301, preservePath: true, preserveQuery: true, includeWww: true });
    expect(rule.expression).toBe(`(http.host in {"${Z}" "www.${Z}"})`);
    const [parsed] = parseRedirects(Z, [{ ...rule, id: "n", enabled: true }]);
    expect(parsed).toMatchObject({ target: "https://nuovo.it", preservePath: true, preserveQuery: true, hosts: [Z, `www.${Z}`] });
  });

  it("ignora le regole che non sono redirect", () => {
    expect(parseRedirects(Z, [{ id: "x", action: "block", expression: "true", enabled: true }])).toEqual([]);
  });
});

describe("diffRecords", () => {
  const a = { id: "1", type: "A", name: Z, content: "1.1.1.1", proxied: true, ttl: 1 };
  const b = { id: "2", type: "TXT", name: Z, content: '"v=spf1 -all"', ttl: 1 };

  it("trova record aggiunti, tolti e modificati", () => {
    const c = { id: "3", type: "MX", name: Z, content: ".", priority: 0, ttl: 1 };
    const d = diffRecords([a, b], [{ ...a, content: "2.2.2.2" }, c]);
    expect(d.added.map((r) => r.id)).toEqual(["3"]);
    expect(d.removed.map((r) => r.id)).toEqual(["2"]);
    expect(d.changed.map((x) => [x.before.content, x.after.content])).toEqual([["1.1.1.1", "2.2.2.2"]]);
  });

  it("non vede differenze se cambia solo l'ordine", () => {
    const d = diffRecords([a, b], [b, a]);
    expect(d.added.length + d.removed.length + d.changed.length).toBe(0);
  });
});

describe("zoneUsage e servedBy", () => {
  const off = parkingState(Z, [], []);
  const base = { zone: Z, records: [] as Rec[], routes: [] as Route[], customDomains: [] as CustomDomain[], parking: off, redirects: [], incomplete: false };

  it("vede un Worker collegato come Custom Domain anche senza record DNS visibili", () => {
    const customDomains = [{ hostname: Z, service: "sito" }];
    expect(zoneUsage({ ...base, customDomains })).toBe("site");
    expect(servedBy(Z, [], customDomains)).toEqual([{ host: Z, worker: "sito", kind: "custom-domain" }]);
  });

  it("considera sito un record all'apex anche se è il segnaposto 100::", () => {
    expect(zoneUsage({ ...base, records: [{ id: "a", type: "AAAA", name: Z, content: "100::", proxied: true }] })).toBe("site");
  });

  it("riconosce le route con il jolly", () => {
    const routes = [{ id: "r", pattern: `*${Z}/*`, script: "sito" }];
    expect(zoneUsage({ ...base, routes })).toBe("site");
    expect(servedBy(Z, routes, [])).toEqual([
      { host: Z, worker: "sito", kind: "route" },
      { host: `www.${Z}`, worker: "sito", kind: "route" },
    ]);
    expect(servedBy(Z, [{ id: "x", pattern: `*.${Z}/*`, script: "app" }], [])).toEqual([{ host: `www.${Z}`, worker: "app", kind: "route" }]);
  });

  it("non dice vuoto se non ha potuto leggere route o Custom Domain", () => {
    expect(zoneUsage({ ...base, incomplete: true })).toBe("unknown");
    expect(zoneUsage(base)).toBe("empty");
  });
});

describe("displayRecords", () => {
  const domains: CustomDomain[] = [{ hostname: Z, service: "sito" }];
  const records: Rec[] = [
    { id: "w", type: "AAAA", name: Z, content: "100::", proxied: true, meta: { read_only: true, origin_worker_id: "abc" } },
    { id: "mx", type: "MX", name: Z, content: "mx1.forwardemail.net", priority: 10 },
    { id: "txt", type: "TXT", name: Z, content: '"v=spf1 include:spf.forwardemail.net -all"' },
    { id: "www", type: "A", name: `www.${Z}`, content: "192.0.2.1", proxied: true },
  ];

  it("mostra il record del Worker come A e AAAA, e lascia stare gli altri record con lo stesso nome", () => {
    const rows = displayRecords(records, domains);
    expect(rows.map((r) => [r.type, r.name, r.worker ?? r.content])).toEqual([
      ["A", Z, "sito"],
      ["A", `www.${Z}`, "192.0.2.1"],
      ["AAAA", Z, "sito"],
      ["MX", Z, "mx1.forwardemail.net"],
      ["TXT", Z, '"v=spf1 include:spf.forwardemail.net -all"'],
    ]);
  });

  it("riconosce un record di Worker anche senza sapere quale Worker", () => {
    expect(displayRecords([records[0]], []).map((r) => [r.type, r.worker])).toEqual([
      ["A", ""],
      ["AAAA", ""],
    ]);
  });
});
