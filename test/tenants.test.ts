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
  it("everyone sees all their accounts, those not enabled marked as such", () => {
    expect(visibleAccounts(accounts, tenants, new Set(), new Set()).map((a) => [a.id, a.enabled])).toEqual([
      ["a16", true],
      ["away", true],
      ["aother", false],
    ]);
  });

  it("an account not enabled can be asked for by who manages it, once", () => {
    const [, , other] = visibleAccounts(accounts, tenants, new Set(), new Set(["aother", "a16"]));
    expect(other).toMatchObject({ canRequest: true, requested: false });
    expect(visibleAccounts(accounts, tenants, new Set(["aother"]), new Set(["aother"]))[2]).toMatchObject({ requested: true });
  });

  it("nothing to ask for an account already enabled", () => {
    expect(visibleAccounts(accounts, tenants, new Set(["a16"]), new Set(["a16"]))[0]).toMatchObject({ enabled: true, canRequest: false, requested: false });
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
