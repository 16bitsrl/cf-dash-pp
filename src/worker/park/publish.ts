// Publishes the parking page as a Worker made only of static assets, one per account
// (Workers routes can only point to Workers of the same account).
// Requests are served from Cloudflare's asset storage: the Worker code never runs.

import type { CfApi } from "../lib/cf";
import { PARK_WORKER } from "../lib/zone-state";
import { parkPage, type ParkBrand, type ParkConfig } from "./page";
const COMPAT_DATE = "2026-10-28";

export type Brand = Omit<ParkBrand, "logo" | "icon"> & { logo: Asset | null; icon: Asset | null };

/**
 * One of the account's parking pages. `brand: null` is the anonymous page.
 * `noneEn`/`noneIt` replace "No website yet." (null: the standard line; missing in pages saved before).
 */
export type ParkPageDef = { id: string; label: string; brand: Brand | null; noneEn?: string | null; noneIt?: string | null };

export type ParkSettings = {
  pages: ParkPageDef[];
  defaultPage: string;
  /** Domain → page, only for domains that do not use the default page. */
  assign: Record<string, string>;
};

/** Settings saved before there could be more than one page. */
export type LegacyParkSettings = { brand: Brand | null; scope: "all" | "listed"; include: string[]; exclude: string[] };

const NEUTRAL: ParkPageDef = { id: "neutral", label: "", brand: null, noneEn: null, noneIt: null };

export function fromLegacy(l: LegacyParkSettings): ParkSettings {
  if (!l.brand) return { pages: [NEUTRAL], defaultPage: NEUTRAL.id, assign: {} };
  const pages = [NEUTRAL, { id: "brand", label: l.brand.name, brand: l.brand, noneEn: null, noneIt: null }];
  if (l.scope === "all") return { pages, defaultPage: "brand", assign: Object.fromEntries(l.exclude.map((d) => [d, NEUTRAL.id])) };
  return { pages, defaultPage: NEUTRAL.id, assign: Object.fromEntries(l.include.map((d) => [d, "brand"])) };
}

/** The brand's web address, with https:// added when missing; null when it isn't a web address. */
export function siteUrl(input: string): string | null {
  const s = input.trim();
  if (!s || /\s/.test(s)) return null;
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:(?!\d)/i.test(s) ? s : `https://${s}`);
    const host = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/i.test(u.hostname);
    return (u.protocol === "https:" || u.protocol === "http:") && host && !u.username && !u.password ? u.href : null;
  } catch {
    return null;
  }
}

function cleanBrand(b: Brand): Brand {
  return {
    name: String(b.name ?? "").slice(0, 80),
    site: b.site ? siteUrl(String(b.site)) : null,
    accent: /^#[0-9a-f]{6}$/i.test(b.accent) ? b.accent : "#3a3b44",
    leadEn: b.leadEn?.slice(0, 160) || null,
    leadIt: b.leadIt?.slice(0, 160) || null,
    logoHeight: b.logoHeight && /^\d+(\.\d+)?rem$/.test(b.logoHeight) ? b.logoHeight : null,
    logo: b.logo?.data && b.logo.data.length < 400_000 ? b.logo : null,
    icon: b.icon?.data && b.icon.data.length < 100_000 ? b.icon : null,
  };
}

/** Validates settings coming from the browser: always at least one page, a default that exists, no dangling assignments. */
export function cleanParkSettings(s: ParkSettings): ParkSettings {
  const pages: ParkPageDef[] = [];
  for (const p of (s.pages ?? []).slice(0, 20)) {
    const id = String(p.id ?? "");
    if (!/^[a-z0-9-]{1,40}$/.test(id) || pages.some((x) => x.id === id)) continue;
    const line = (v: unknown) => String(v ?? "").trim().slice(0, 160) || null;
    pages.push({ id, label: String(p.label ?? "").slice(0, 60), brand: p.brand ? cleanBrand(p.brand) : null, noneEn: line(p.noneEn), noneIt: line(p.noneIt) });
  }
  if (!pages.length) pages.push(NEUTRAL);
  const defaultPage = pages.some((p) => p.id === s.defaultPage) ? s.defaultPage : pages[0].id;
  const assign: Record<string, string> = {};
  for (const [d, id] of Object.entries(s.assign ?? {})) if (id !== defaultPage && pages.some((p) => p.id === id)) assign[d.toLowerCase()] = id;
  return { pages, defaultPage, assign };
}

export type Asset = { type: string; data: string }; // data is base64

const EXT: Record<string, string> = { "image/png": "png", "image/svg+xml": "svg", "image/jpeg": "jpg", "image/webp": "webp", "image/x-icon": "ico" };

const toB64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));

async function hash(b64: string, ext: string) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(b64 + ext));
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

type File = { path: string; type: string; b64: string };

/** Files of the parking site for these settings. Logo names contain their hash, so they can be cached forever. */
export async function parkFiles(s: ParkSettings): Promise<{ files: File[]; config: ParkConfig }> {
  const files: File[] = [];
  const asset = async (a: Asset | null, name: string) => {
    if (!a) return null;
    const ext = EXT[a.type] ?? "bin";
    const path = `/.park/${name}-${(await hash(a.data, ext)).slice(0, 10)}.${ext}`;
    if (!files.some((f) => f.path === path)) files.push({ path, type: a.type, b64: a.data });
    return path;
  };
  const pages: ParkConfig["pages"] = {};
  for (const p of s.pages)
    pages[p.id] = { brand: p.brand && { ...p.brand, logo: await asset(p.brand.logo, "logo"), icon: await asset(p.brand.icon, "icon") }, noneEn: p.noneEn ?? null, noneIt: p.noneIt ?? null };
  const config: ParkConfig = { pages, defaultPage: s.defaultPage, assign: s.assign };
  files.push(
    { path: "/index.html", type: "text/html; charset=utf-8", b64: toB64(parkPage(config)) },
    { path: "/robots.txt", type: "text/plain; charset=utf-8", b64: toB64("User-agent: *\nDisallow: /\n") },
  );
  return { files, config };
}

const HEADERS = `/*
  X-Robots-Tag: noindex
  Cache-Control: public, max-age=300, stale-while-revalidate=86400
/.park/*
  Cache-Control: public, max-age=31536000, immutable
`;

const WORKER_JS = `export default { fetch(request, env) { return env.ASSETS.fetch(request); } };`;

// The settings travel with the Worker, in a module that is never served: every Dash++ that
// manages the account (the shared panel or the account's own install) reads the same ones.
const SETTINGS_MODULE = "settings.json";

export type PublishedSettings = { settings: ParkSettings; updatedAt: number | null; updatedBy: string | null };

export function settingsModule(s: ParkSettings, meta: { updatedAt: number; updatedBy: string }) {
  return JSON.stringify({ settings: s, ...meta });
}

/** The settings in the Worker's content as Cloudflare returns it, null if it has none. */
export async function readSettingsModule(content: Response): Promise<PublishedSettings | null> {
  const part = (await content.formData()).get(SETTINGS_MODULE);
  if (!part || typeof part === "string") return null;
  const v = JSON.parse(await part.text()) as PublishedSettings;
  return { settings: cleanParkSettings(v.settings), updatedAt: v.updatedAt ?? null, updatedBy: v.updatedBy ?? null };
}

/** The settings published in the account, null if the parking Worker is missing or older than them. */
export async function readPublishedSettings(api: CfApi, accountId: string) {
  const res = await api.fetch(`/accounts/${accountId}/workers/scripts/${PARK_WORKER}/content/v2`);
  return res ? readSettingsModule(res) : null;
}

export async function publishParking(api: CfApi, accountId: string, s: ParkSettings, meta: { updatedAt: number; updatedBy: string }) {
  const { files } = await parkFiles(s);
  const withHash = await Promise.all(files.map(async (f) => ({ ...f, hash: await hash(f.b64, f.path.split(".").pop() ?? "") })));
  const manifest = Object.fromEntries(withHash.map((f) => [f.path, { hash: f.hash, size: Math.floor((f.b64.length * 3) / 4) - (f.b64.endsWith("==") ? 2 : f.b64.endsWith("=") ? 1 : 0) }]));

  const session = await api.req<{ jwt: string; buckets?: string[][] }>("POST", `/accounts/${accountId}/workers/scripts/${PARK_WORKER}/assets-upload-session`, { manifest });
  let completion = session.jwt;
  for (const bucket of session.buckets ?? []) {
    const form = new FormData();
    for (const h of bucket) {
      const f = withHash.find((x) => x.hash === h)!;
      form.append(h, new Blob([f.b64], { type: f.type }), h);
    }
    const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/assets/upload?base64=true`, {
      method: "POST",
      headers: { authorization: `Bearer ${session.jwt}` },
      body: form,
    });
    const json = (await res.json()) as { success: boolean; result?: { jwt?: string }; errors?: { message: string }[] };
    if (!json.success) throw new Error(json.errors?.map((e) => e.message).join("; ") || `asset upload ${res.status}`);
    if (json.result?.jwt) completion = json.result.jwt;
  }

  const metadata = {
    main_module: "worker.js",
    compatibility_date: COMPAT_DATE,
    bindings: [{ name: "ASSETS", type: "assets" }],
    assets: { jwt: completion, config: { not_found_handling: "single-page-application", html_handling: "auto-trailing-slash", _headers: HEADERS } },
    observability: { enabled: false },
  };
  const form = new FormData();
  form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
  form.append("worker.js", new Blob([WORKER_JS], { type: "application/javascript+module" }), "worker.js");
  form.append(SETTINGS_MODULE, new Blob([settingsModule(s, meta)], { type: "text/plain" }), SETTINGS_MODULE);
  await api.form("PUT", `/accounts/${accountId}/workers/scripts/${PARK_WORKER}`, form);
  // Reachable only through the routes of parked domains.
  await api.req("POST", `/accounts/${accountId}/workers/scripts/${PARK_WORKER}/subdomain`, { enabled: false, previews_enabled: false }).catch(() => {});
}

/** The settings saved in one version of the parking Worker (as returned with its modules), null if it has none. */
export function settingsFromVersion(v: { modules?: { name: string; content_base64: string }[] }): ParkSettings | null {
  const m = v.modules?.find((x) => x.name === SETTINGS_MODULE);
  if (!m) return null;
  const json = new TextDecoder().decode(Uint8Array.from(atob(m.content_base64), (c) => c.charCodeAt(0)));
  return cleanParkSettings((JSON.parse(json) as PublishedSettings).settings);
}
