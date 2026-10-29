import { describe, expect, it } from "vitest";
import { handleRpc, ToolError, type McpCtx } from "../src/worker/mcp";
import { loopbackOrHttps, pkceOk } from "../src/worker/mcp-auth";

type Req = { method: string; path: string; body?: unknown };

function ctx(answers: Record<string, unknown>, zones: Record<string, string> = { "acme.it": "z1" }) {
  const calls: Req[] = [];
  const c: McpCtx = {
    async call(method, path, body) {
      calls.push({ method, path, body });
      const a = answers[`${method} ${path}`];
      if (a instanceof Error) throw a;
      return (a ?? { ok: true }) as never;
    },
    async zone(domain) {
      if (!zones[domain]) throw new ToolError("zone-not-found", { domain });
      return zones[domain];
    },
  };
  return { c, calls };
}

const call = (c: McpCtx, name: string, args: Record<string, unknown> = {}) =>
  handleRpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, c) as Promise<{ result: { content: { text: string }[]; isError?: boolean } }>;
const json = (r: { result: { content: { text: string }[] } }) => JSON.parse(r.result.content[0].text);

describe("handleRpc", () => {
  it("risponde a initialize con gli strumenti tra le capacità", async () => {
    const r = (await handleRpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }, ctx({}).c)) as { result: { protocolVersion: string; capabilities: object; serverInfo: { name: string } } };
    expect(r.result.protocolVersion).toBe("2025-06-18");
    expect(r.result.capabilities).toHaveProperty("tools");
    expect(r.result.serverInfo.name).toBe("dash-plus-plus");
  });

  it("non risponde alle notifiche", async () => {
    expect(await handleRpc({ jsonrpc: "2.0", method: "notifications/initialized" }, ctx({}).c)).toBeNull();
  });

  it("elenca gli strumenti con il loro schema e segna quelli che modificano", async () => {
    const r = (await handleRpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }, ctx({}).c)) as { result: { tools: { name: string; inputSchema: { type: string }; annotations: { readOnlyHint: boolean } }[] } };
    const byName = Object.fromEntries(r.result.tools.map((t) => [t.name, t]));
    expect(Object.keys(byName)).toEqual(expect.arrayContaining(["list_accounts", "list_domains", "get_domain", "park_domain", "add_redirect", "set_parking_page"]));
    expect(r.result.tools.every((t) => t.inputSchema.type === "object")).toBe(true);
    expect(byName.get_domain.annotations.readOnlyHint).toBe(true);
    expect(byName.park_domain.annotations.readOnlyHint).toBe(false);
  });

  it("metodo sconosciuto: errore JSON-RPC", async () => {
    const r = (await handleRpc({ jsonrpc: "2.0", id: 3, method: "nope" }, ctx({}).c)) as { error: { code: number } };
    expect(r.error.code).toBe(-32601);
  });

  it("get_domain trova la zona dal nome e riduce la cronologia", async () => {
    const changes = Array.from({ length: 50 }, (_, i) => ({ id: i }));
    const { c, calls } = ctx({ "GET /zones/z1": { zone: { id: "z1", name: "acme.it" }, usage: "parked", records: [], changes, park: {}, routes: [] } });
    const out = json(await call(c, "get_domain", { domain: "ACME.it" }));
    expect(calls[0]).toEqual({ method: "GET", path: "/zones/z1", body: undefined });
    expect(out.usage).toBe("parked");
    expect(out.changes).toHaveLength(20);
    expect(out).not.toHaveProperty("park");
  });

  it("park_domain protegge la posta se non si dice altrimenti", async () => {
    const { c, calls } = ctx({ "POST /zones/z1/parking": { done: [{ op: "record.add" }], zone: { usage: "parked", changes: [] } } });
    const out = json(await call(c, "park_domain", { domain: "acme.it" }));
    expect(calls[0].body).toEqual({ enable: true, protectMail: true });
    expect(out.done).toEqual([{ op: "record.add" }]);
  });

  it("list_domains accetta il nome dell'account", async () => {
    const { c, calls } = ctx({
      "GET /me": { email: "a@b.it", accounts: [{ id: "acc1", name: "16bit" }] },
      "GET /accounts/acc1/zones": { zones: [{ id: "z1", name: "acme.it", status: "active", paused: false, cached: { usage: "parked", parking: "ok", redirectTarget: null, mail: { mode: "none", provider: null, errors: 0, warnings: 0, checks: [] }, lastChangeAt: null } }] },
    });
    const out = json(await call(c, "list_domains", { account: "16BIT" }));
    expect(calls.map((x) => x.path)).toEqual(["/me", "/accounts/acc1/zones"]);
    expect(out.domains[0]).toMatchObject({ name: "acme.it", usage: "parked" });
  });

  it("set_parking_page assegna la pagina e, se è la predefinita, toglie l'assegnazione", async () => {
    const settings = { pages: [{ id: "neutral", label: "" }, { id: "brand", label: "Acme" }], defaultPage: "neutral", assign: { "old.it": "brand" } };
    const { c, calls } = ctx({ "GET /me": { accounts: [{ id: "acc1", name: "16bit" }] }, "GET /accounts/acc1/park": { settings } });
    await call(c, "set_parking_page", { account: "acc1", domains: ["acme.it"], page: "brand" });
    expect(calls.at(-1)).toEqual({ method: "PUT", path: "/accounts/acc1/park", body: { ...settings, assign: { "old.it": "brand", "acme.it": "brand" } } });
    await call(c, "set_parking_page", { account: "acc1", domains: ["old.it"], page: "neutral" });
    expect((calls.at(-1)!.body as typeof settings).assign).toEqual({});
  });

  it("set_parking_page rifiuta una pagina che non esiste", async () => {
    const { c, calls } = ctx({ "GET /me": { accounts: [{ id: "acc1", name: "16bit" }] }, "GET /accounts/acc1/park": { settings: { pages: [{ id: "neutral" }], defaultPage: "neutral", assign: {} } } });
    const r = await call(c, "set_parking_page", { account: "acc1", domains: ["acme.it"], page: "nope" });
    expect(r.result.isError).toBe(true);
    expect(calls.some((x) => x.method === "PUT")).toBe(false);
  });

  it("un errore delle API diventa un risultato con isError e il codice", async () => {
    const { c } = ctx({ "POST /zones/z1/parking": new ToolError("has-redirect", { target: "https://x.it" }) });
    const r = await call(c, "park_domain", { domain: "acme.it" });
    expect(r.result.isError).toBe(true);
    expect(json(r)).toEqual({ error: "has-redirect", params: { target: "https://x.it" } });
  });

  it("argomenti mancanti: errore senza chiamare le API", async () => {
    const { c, calls } = ctx({});
    const r = await call(c, "add_redirect", { domain: "acme.it" });
    expect(r.result.isError).toBe(true);
    expect(calls).toEqual([]);
  });
});

describe("mcp-auth", () => {
  it("accetta indirizzi di ritorno https o locali", () => {
    expect(loopbackOrHttps("https://claude.ai/api/mcp/auth_callback")).toBe(true);
    expect(loopbackOrHttps("http://localhost:33418/callback")).toBe(true);
    expect(loopbackOrHttps("http://127.0.0.1:5000/cb")).toBe(true);
    expect(loopbackOrHttps("http://evil.com/cb")).toBe(false);
    expect(loopbackOrHttps("javascript:alert(1)")).toBe(false);
    expect(loopbackOrHttps("https://x.it/cb#frag")).toBe(false);
  });

  it("verifica PKCE S256", async () => {
    // Example from RFC 7636, appendix B.
    expect(await pkceOk("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk", "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")).toBe(true);
    expect(await pkceOk("wrong", "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")).toBe(false);
  });
});
