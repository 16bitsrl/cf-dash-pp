import { describe, expect, it } from "vitest";
import { cleanParkSettings, fromLegacy, parkFiles, readSettingsModule, settingsModule, settingsFromVersion, siteUrl, type ParkSettings } from "../src/worker/park/publish";

const brand = { name: "Acme", site: "https://acme.it", accent: "#ff0000", leadEn: null, leadIt: null, logo: null, logoHeight: null, icon: null };

describe("fromLegacy", () => {
  it("senza marchio: una sola pagina neutra", () => {
    expect(fromLegacy({ brand: null, scope: "all", include: [], exclude: [] })).toEqual({
      pages: [{ id: "neutral", label: "", brand: null, noneEn: null, noneIt: null }],
      defaultPage: "neutral",
      assign: {},
    });
  });

  it("marchio su tutti tranne alcuni: il marchio è la predefinita, gli esclusi vanno sulla neutra", () => {
    const s = fromLegacy({ brand, scope: "all", include: [], exclude: ["b.it"] });
    expect(s.defaultPage).toBe("brand");
    expect(s.pages.map((p) => [p.id, p.brand?.name ?? null])).toEqual([
      ["neutral", null],
      ["brand", "Acme"],
    ]);
    expect(s.assign).toEqual({ "b.it": "neutral" });
  });

  it("marchio solo su alcuni: la neutra è la predefinita, gli scelti vanno sul marchio", () => {
    const s = fromLegacy({ brand, scope: "listed", include: ["a.it", "c.it"], exclude: [] });
    expect(s.defaultPage).toBe("neutral");
    expect(s.assign).toEqual({ "a.it": "brand", "c.it": "brand" });
  });
});

describe("cleanParkSettings", () => {
  const base: ParkSettings = {
    pages: [
      { id: "neutral", label: "", brand: null },
      { id: "acme", label: "Acme", brand },
    ],
    defaultPage: "acme",
    assign: { "A.it": "neutral", "b.it": "sparita", "c.it": "acme" },
  };

  it("tiene solo le assegnazioni a pagine esistenti e diverse dalla predefinita, con nomi minuscoli", () => {
    expect(cleanParkSettings(base).assign).toEqual({ "a.it": "neutral" });
  });

  it("se la predefinita non esiste usa la prima pagina", () => {
    expect(cleanParkSettings({ ...base, defaultPage: "sparita" }).defaultPage).toBe("neutral");
  });

  it("senza pagine ne crea una neutra", () => {
    expect(cleanParkSettings({ pages: [], defaultPage: "x", assign: {} })).toEqual({ pages: [{ id: "neutral", label: "", brand: null, noneEn: null, noneIt: null }], defaultPage: "neutral", assign: {} });
  });

  it("tiene la frase al posto di quella standard, vuota vuol dire standard; le pagine salvate prima non l'hanno", () => {
    const c = cleanParkSettings({ ...base, pages: [{ ...base.pages[0], noneEn: "  For sale.  ", noneIt: " " }, base.pages[1]] });
    expect(c.pages.map((p) => [p.noneEn, p.noneIt])).toEqual([
      ["For sale.", null],
      [null, null],
    ]);
  });
});

describe("parkFiles", () => {
  it("mette nella pagina pubblicata tutte le pagine, la predefinita e le assegnazioni", async () => {
    const { config, files } = await parkFiles(
      cleanParkSettings({
        pages: [
          { id: "neutral", label: "", brand: null, noneEn: null, noneIt: "In vendita." },
          { id: "acme", label: "Acme", brand: { ...brand, logo: { type: "image/png", data: "iVBORw0KGgo=" } } },
        ],
        defaultPage: "neutral",
        assign: { "a.it": "acme" },
      }),
    );
    expect(config.defaultPage).toBe("neutral");
    expect(config.assign).toEqual({ "a.it": "acme" });
    expect(config.pages.neutral).toEqual({ brand: null, noneEn: null, noneIt: "In vendita." });
    expect(config.pages.acme.brand?.logo).toMatch(/^\/\.park\/logo-[0-9a-f]{10}\.png$/);
    expect(files.map((f) => f.path)).toContain(config.pages.acme.brand?.logo);
  });
});

describe("impostazioni nel Worker di parcheggio", () => {
  const s = cleanParkSettings({ pages: [{ id: "neutral", label: "", brand: null }, { id: "acme", label: "Acme", brand }], defaultPage: "neutral", assign: { "a.it": "acme" } });

  it("si rileggono dal contenuto del Worker restituito da Cloudflare", async () => {
    const form = new FormData();
    form.append("settings.json", new Blob([settingsModule(s, { updatedAt: 1000, updatedBy: "admin@example.com" })], { type: "text/plain" }), "settings.json");
    form.append("worker.js", new Blob(["export default {}"], { type: "application/javascript+module" }), "worker.js");
    const res = new Response(form);
    expect(await readSettingsModule(res)).toEqual({ settings: s, updatedAt: 1000, updatedBy: "admin@example.com" });
  });

  it("un Worker pubblicato prima, senza impostazioni, non ne ha", async () => {
    const form = new FormData();
    form.append("worker.js", new Blob(["export default {}"], { type: "application/javascript+module" }), "worker.js");
    expect(await readSettingsModule(new Response(form))).toBeNull();
  });
});

describe("siteUrl", () => {
  it("accetta indirizzi web validi", () => {
    expect(siteUrl("https://acme.it")).toBe("https://acme.it/");
    expect(siteUrl("http://www.acme.it/chi-siamo?x=1")).toBe("http://www.acme.it/chi-siamo?x=1");
  });

  it("senza protocollo aggiunge https", () => {
    expect(siteUrl("  acme.it ")).toBe("https://acme.it/");
    expect(siteUrl("acme.it:8080")).toBe("https://acme.it:8080/");
  });

  it("rifiuta tutto il resto", () => {
    for (const s of ["", "acme", "acme .it", "javascript:alert(1)", "ftp://acme.it", "https://", "https://acme.", "mailto:a@acme.it", "https://user:pw@acme.it"]) expect(siteUrl(s), s).toBeNull();
  });

  it("le impostazioni salvate tengono solo siti validi", () => {
    const s = cleanParkSettings({ pages: [{ id: "a", label: "", brand: { ...brand, site: "acme .it" } }], defaultPage: "a", assign: {} });
    expect(s.pages[0].brand?.site).toBeNull();
  });
});

describe("settingsFromVersion", () => {
  const b64 = (s: string) => btoa(s);
  const saved = { settings: { pages: [{ id: "a", label: "Acme", brand }], defaultPage: "a", assign: { "x.it": "a" } }, updatedAt: 1, updatedBy: "mt@16bit.it" };

  it("legge le pagine salvate in una pubblicazione", () => {
    const s = settingsFromVersion({ modules: [{ name: "worker.js", content_base64: b64("x") }, { name: "settings.json", content_base64: b64(JSON.stringify(saved)) }] });
    expect(s?.pages.map((p) => p.label)).toEqual(["Acme"]);
    expect(s?.defaultPage).toBe("a");
  });

  it("null per le pubblicazioni senza pagine salvate", () => {
    expect(settingsFromVersion({ modules: [{ name: "worker.js", content_base64: b64("x") }] })).toBeNull();
    expect(settingsFromVersion({})).toBeNull();
  });
});
