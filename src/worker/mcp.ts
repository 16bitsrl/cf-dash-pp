// MCP server (Streamable HTTP, stateless, JSON responses). Every tool calls the same /api the
// panel uses, with the caller's token, so permissions, enabled accounts and the action log are
// the same as in the panel.

export class ToolError extends Error {
  constructor(
    public code: string,
    public params: Record<string, unknown> = {},
  ) {
    super(code);
  }
}

export type McpCtx = {
  call: <T = any>(method: string, path: string, body?: unknown) => Promise<T>;
  /** The zone id of a domain the caller can see. */
  zone: (domain: string) => Promise<string>;
};

type Args = Record<string, unknown>;
type Prop = { type: string; description: string; enum?: readonly (string | number)[]; items?: { type: string } };
type Tool = {
  name: string;
  description: string;
  props: Record<string, Prop>;
  required?: string[];
  write?: boolean;
  destructive?: boolean;
  run: (a: Args, c: McpCtx) => Promise<unknown>;
};

const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];

const str = (description: string, e?: readonly string[]): Prop => ({ type: "string", description, ...(e && { enum: e }) });
const bool = (description: string): Prop => ({ type: "boolean", description });
const account = str("Account id or name, from list_accounts.");
const domain = str("Domain name, such as example.com.");
const subdomain = str("Subdomain the mail records belong to, such as send.example.com. Optional: the domain itself when missing.");

async function accountId(c: McpCtx, a: unknown) {
  const q = String(a ?? "").trim().toLowerCase();
  const me = await c.call<{ accounts: { id: string; name: string }[] }>("GET", "/me");
  const hit = me.accounts.find((x) => x.id === q) ?? me.accounts.find((x) => x.name.toLowerCase() === q);
  if (!hit) throw new ToolError("account-not-found", { account: String(a ?? ""), available: me.accounts.map((x) => x.name) });
  return hit.id;
}

const zoneOf = (c: McpCtx, a: Args) => c.zone(String(a.domain).trim().toLowerCase());

/** The domain as the panel shows it, without what only the panel needs. */
function slimZone(z: Record<string, unknown> & { changes?: unknown[] }) {
  const { park: _park, routes: _routes, ...rest } = z;
  return { ...rest, changes: (z.changes ?? []).slice(0, 20) };
}

const mutation = async (c: McpCtx, method: string, path: string, body?: unknown) => {
  const r = await c.call<{ done: unknown[]; zone: Record<string, unknown> & { changes?: unknown[] } }>(method, path, body);
  return { done: r.done, zone: slimZone(r.zone) };
};

const redirectProps: Record<string, Prop> = {
  domain,
  target: str("Where to send visitors: a full URL starting with https:// or http://."),
  status: { type: "number", description: "HTTP status. Default 301.", enum: [301, 302, 307, 308] },
  host: str("Host to redirect, such as example.com or shop.example.com. Default: the domain."),
  path: str("Only this path, such as /old. Default: every path."),
  path_prefix: bool("With path: also everything under it."),
  preserve_path: bool("Append the requested path to the target."),
  preserve_query: bool("Keep the query string."),
  include_www: bool("Also redirect www. Default true."),
};
const redirectBody = (a: Args) => ({
  host: a.host,
  path: a.path,
  pathPrefix: a.path_prefix,
  target: a.target,
  status: a.status,
  preservePath: a.preserve_path,
  preserveQuery: a.preserve_query,
  includeWww: a.include_www,
});

const TOOLS: Tool[] = [
  {
    name: "list_accounts",
    description: "Cloudflare accounts you can use in Dash++.",
    props: {},
    run: async (_a, c) => {
      const me = await c.call<{ email: string; accounts: { id: string; name: string }[] }>("GET", "/me");
      return { email: me.email, accounts: me.accounts.map((x) => ({ id: x.id, name: x.name })) };
    },
  },
  {
    name: "list_domains",
    description: "Domains of an account with what each one does (parked, redirect, site, empty), its redirect target and the state of its mail setup. The state comes from the last check; get_domain reads it again.",
    props: { account },
    required: ["account"],
    run: async (a, c) => {
      const acc = await accountId(c, a.account);
      type Row = { id: string; name: string; status: string; paused: boolean; cached: { usage: string | null; parking: string | null; redirectTarget: string | null; mail: { mode: string; provider: string | null; errors: number; warnings: number }; lastChangeAt: number | null } | null };
      const r = await c.call<{ zones: Row[] }>("GET", `/accounts/${acc}/zones`);
      return {
        domains: r.zones.map((z) => ({
          name: z.name,
          status: z.paused ? "paused" : z.status,
          usage: z.cached?.usage ?? null,
          parking: z.cached?.parking ?? null,
          redirectTarget: z.cached?.redirectTarget ?? null,
          mail: z.cached ? { mode: z.cached.mail.mode, provider: z.cached.mail.provider, errors: z.cached.mail.errors, warnings: z.cached.mail.warnings } : null,
          lastChangeAt: z.cached?.lastChangeAt ? new Date(z.cached.lastChangeAt).toISOString() : null,
        })),
      };
    },
  },
  {
    name: "get_domain",
    description: "Reads a domain from Cloudflare now: DNS records, parking, redirect rules (with their ids), Workers serving it, mail checks (each with an optional fix id for fix_mail; subdomains with mail records of their own have their own report, and their checks carry the subdomain name) and the latest record changes.",
    props: { domain },
    required: ["domain"],
    run: async (a, c) => slimZone(await c.call("GET", `/zones/${await zoneOf(c, a)}`)),
  },
  {
    name: "park_domain",
    description: "Parks a domain: points it and www to the account's parking page. Fails if the domain already serves a site, a Worker or a redirect.",
    props: { domain, protect_mail: bool("If the domain has no mail, also publish records that stop others sending mail as it. Default true.") },
    required: ["domain"],
    write: true,
    run: async (a, c) => mutation(c, "POST", `/zones/${await zoneOf(c, a)}/parking`, { enable: true, protectMail: a.protect_mail !== false }),
  },
  {
    name: "unpark_domain",
    description: "Stops parking a domain.",
    props: { domain, remove_records: bool("Also delete the parking DNS records of the domain and www. Default false.") },
    required: ["domain"],
    write: true,
    destructive: true,
    run: async (a, c) => mutation(c, "POST", `/zones/${await zoneOf(c, a)}/parking`, { enable: false, removeRecords: !!a.remove_records }),
  },
  {
    name: "add_redirect",
    description: "Redirects a domain (or a host or path of it) to another address. Adds the DNS records it needs.",
    props: redirectProps,
    required: ["domain", "target"],
    write: true,
    run: async (a, c) => mutation(c, "POST", `/zones/${await zoneOf(c, a)}/redirects`, redirectBody(a)),
  },
  {
    name: "update_redirect",
    description: "Changes a redirect rule. Rule ids are in get_domain.",
    props: { ...redirectProps, rule_id: str("Id of the redirect rule.") },
    required: ["domain", "rule_id", "target"],
    write: true,
    run: async (a, c) => mutation(c, "PUT", `/zones/${await zoneOf(c, a)}/redirects/${encodeURIComponent(String(a.rule_id))}`, redirectBody(a)),
  },
  {
    name: "delete_redirect",
    description: "Deletes a redirect rule. Rule ids are in get_domain.",
    props: { domain, rule_id: str("Id of the redirect rule."), remove_records: bool("Also delete the DNS records that only served the redirect. Default false.") },
    required: ["domain", "rule_id"],
    write: true,
    destructive: true,
    run: async (a, c) => mutation(c, "DELETE", `/zones/${await zoneOf(c, a)}/redirects/${encodeURIComponent(String(a.rule_id))}${a.remove_records ? "?records=1" : ""}`),
  },
  {
    name: "set_mail_provider",
    description: "Sets the MX records for a mail provider, replacing the current ones. 'none' removes them and says the domain receives no mail.",
    props: { domain, provider: str("Mail provider.", ["google", "microsoft", "qboxmail", "forwardemail", "none"]), update_spf: bool("Also update SPF to match. Default true."), subdomain },
    required: ["domain", "provider"],
    write: true,
    destructive: true,
    run: async (a, c) => mutation(c, "POST", `/zones/${await zoneOf(c, a)}/mail/mx`, { preset: a.provider, updateSpf: a.update_spf !== false, name: a.subdomain }),
  },
  {
    name: "set_spf",
    description: "Sets the SPF record of the domain (or of one of its subdomains), replacing the current one.",
    props: { domain, value: str("Full SPF value, such as 'v=spf1 include:_spf.google.com ~all'."), subdomain },
    required: ["domain", "value"],
    write: true,
    run: async (a, c) => mutation(c, "PUT", `/zones/${await zoneOf(c, a)}/mail/spf`, { value: a.value, name: a.subdomain }),
  },
  {
    name: "set_dmarc",
    description: "Sets the DMARC record of the domain (or of one of its subdomains), replacing the current one.",
    props: { domain, policy: str("DMARC policy.", ["none", "quarantine", "reject"]), report_to: str("Address that receives the reports (rua), such as mailto:dmarc@example.com. Optional."), subdomain },
    required: ["domain", "policy"],
    write: true,
    run: async (a, c) => mutation(c, "PUT", `/zones/${await zoneOf(c, a)}/mail/dmarc`, { policy: a.policy, rua: a.report_to, name: a.subdomain }),
  },
  {
    name: "fix_mail",
    description: "Applies the fix suggested by a mail check of get_domain.",
    props: {
      domain,
      fix: str("Fix id from the check.", ["protect-no-mail", "add-dmarc", "add-spf", "add-spf-include", "google-mx"]),
      policy: str("For add-dmarc.", ["none", "quarantine", "reject"]),
      report_to: str("For add-dmarc: rua address. Optional."),
      include: str("For add-spf-include: the include to add."),
      subdomain,
    },
    required: ["domain", "fix"],
    write: true,
    run: async (a, c) => mutation(c, "POST", `/zones/${await zoneOf(c, a)}/mail-fix`, { fix: a.fix, policy: a.policy, rua: a.report_to, include: a.include, name: a.subdomain }),
  },
  {
    name: "get_parking_pages",
    description: "Parking pages of an account (anonymous or branded), the default one and which domains use another one.",
    props: { account },
    required: ["account"],
    run: async (a, c) => {
      const r = await c.call<{ status: unknown; settings: unknown; publishedAt: number | null }>("GET", `/accounts/${await accountId(c, a.account)}/park`);
      return { status: r.status, settings: r.settings, publishedAt: r.publishedAt ? new Date(r.publishedAt).toISOString() : null };
    },
  },
  {
    name: "set_parking_page",
    description: "Chooses which parking page some parked domains show, and publishes it right away. Page ids are in get_parking_pages.",
    props: { account, domains: { type: "array", items: { type: "string" }, description: "Domain names." }, page: str("Page id.") },
    required: ["account", "domains", "page"],
    write: true,
    run: async (a, c) => {
      const acc = await accountId(c, a.account);
      const { settings } = await c.call<{ settings: { pages: { id: string }[]; defaultPage: string; assign: Record<string, string> } }>("GET", `/accounts/${acc}/park`);
      const page = String(a.page);
      if (!settings.pages.some((p) => p.id === page)) throw new ToolError("page-not-found", { page, available: settings.pages.map((p) => p.id) });
      const assign = { ...settings.assign };
      for (const d of [a.domains].flat().map((x) => String(x).trim().toLowerCase())) {
        if (page === settings.defaultPage) delete assign[d];
        else assign[d] = page;
      }
      await c.call("PUT", `/accounts/${acc}/park`, { ...settings, assign });
      return { ok: true, assign };
    },
  },
  {
    name: "list_domain_groups",
    description: "Domain groups of an account (the resource groups used to give members access to some domains).",
    props: { account },
    required: ["account"],
    run: async (a, c) => c.call("GET", `/accounts/${await accountId(c, a.account)}/groups`),
  },
  {
    name: "get_activity",
    description: "Recent record changes in an account (made in Dash++ or elsewhere) and the actions done in Dash++.",
    props: { account, limit: { type: "number", description: "How many of each, newest first. Default 50." } },
    required: ["account"],
    run: async (a, c) => {
      const r = await c.call<{ changes: unknown[]; audit: unknown[] }>("GET", `/accounts/${await accountId(c, a.account)}/activity`);
      const n = Math.max(1, Math.min(500, Number(a.limit) || 50));
      return { changes: r.changes.slice(0, n), actions: r.audit.slice(0, n) };
    },
  },
  {
    name: "refresh_account",
    description: "Reads every domain of an account from Cloudflare again, so list_domains is up to date.",
    props: { account },
    required: ["account"],
    run: async (a, c) => c.call("POST", `/accounts/${await accountId(c, a.account)}/sync`, {}),
  },
];

const listed = TOOLS.map((t) => ({
  name: t.name,
  description: t.description,
  inputSchema: { type: "object", properties: t.props, ...(t.required && { required: t.required }) },
  annotations: { readOnlyHint: !t.write, destructiveHint: !!t.destructive, idempotentHint: !t.write || undefined, openWorldHint: false },
}));

type Rpc = { jsonrpc: "2.0"; id?: string | number | null; method: string; params?: Record<string, any> };

const text = (v: unknown, isError = false) => ({ content: [{ type: "text", text: JSON.stringify(v, null, 1) }], ...(isError && { isError: true }) });

/** One JSON-RPC message; null for notifications. */
export async function handleRpc(msg: Rpc, c: McpCtx): Promise<object | null> {
  if (msg.id === undefined || msg.id === null) return null;
  const ok = (result: unknown) => ({ jsonrpc: "2.0", id: msg.id, result });
  const fail = (code: number, message: string) => ({ jsonrpc: "2.0", id: msg.id, error: { code, message } });
  switch (msg.method) {
    case "initialize": {
      const asked = msg.params?.protocolVersion;
      return ok({
        protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
        capabilities: { tools: {} },
        serverInfo: { name: "dash-plus-plus", title: "Dash++", version: "1.0.0" },
        instructions: "Dash++ manages parking, redirects and mail records of Cloudflare domains, with the signed-in user's permissions. Changes are real and immediate.",
      });
    }
    case "ping":
      return ok({});
    case "tools/list":
      return ok({ tools: listed });
    case "tools/call": {
      const tool = TOOLS.find((t) => t.name === msg.params?.name);
      if (!tool) return fail(-32602, `Unknown tool: ${msg.params?.name}`);
      const args: Args = msg.params?.arguments ?? {};
      const missing = (tool.required ?? []).filter((k) => args[k] === undefined || args[k] === null || args[k] === "");
      if (missing.length) return ok(text({ error: "missing-arguments", params: { missing } }, true));
      try {
        return ok(text(await tool.run(args, c)));
      } catch (e) {
        if (e instanceof ToolError) return ok(text({ error: e.code, params: e.params }, true));
        throw e;
      }
    }
    default:
      return fail(-32601, `Method not found: ${msg.method}`);
  }
}
