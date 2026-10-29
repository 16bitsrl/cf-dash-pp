import { describe, expect, it } from "vitest";
import { tokenLink, visibleAccounts } from "../src/worker/tenants";

const accounts = [
  { id: "a16", name: "16bit" },
  { id: "away", name: "WAY" },
  { id: "aother", name: "Altro" },
];
const tenants = new Map([
  ["a16", { syncToken: true }],
  ["away", { syncToken: false }],
]);

describe("visibleAccounts", () => {
  it("chi non è superadmin vede solo gli account abilitati", () => {
    expect(visibleAccounts(accounts, tenants, false)).toEqual([
      { id: "a16", name: "16bit", enabled: true, syncToken: true },
      { id: "away", name: "WAY", enabled: true, syncToken: false },
    ]);
  });

  it("il superadmin vede anche quelli non abilitati, segnati come tali", () => {
    expect(visibleAccounts(accounts, tenants, true).map((a) => [a.id, a.enabled])).toEqual([
      ["a16", true],
      ["away", true],
      ["aother", false],
    ]);
  });

  it("senza account abilitati chi non è superadmin non vede niente", () => {
    expect(visibleAccounts(accounts, new Map(), false)).toEqual([]);
  });
});

describe("tokenLink", () => {
  it("apre la creazione di un token dell'account con i permessi di sola lettura già scelti", () => {
    const u = new URL(tokenLink("a16"));
    expect(u.origin + u.pathname).toBe("https://dash.cloudflare.com/");
    expect(u.searchParams.get("to")).toBe("/a16/api-tokens");
    expect(u.searchParams.get("name")).toBe("Dash++ sync");
    expect(JSON.parse(u.searchParams.get("permissionGroupKeys")!).map((p: { key: string; type: string }) => `${p.key}:${p.type}`)).toEqual([
      "zone:read",
      "dns:read",
      "workers_routes:read",
      "workers_scripts:read",
      "account_settings:read",
      "d8e12db741544d1586ec1d6f5d3c7786:read",
    ]);
  });
});
