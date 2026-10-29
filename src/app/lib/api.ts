import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { Check, MailReport } from "../../worker/lib/mail";
import type { ParkSettings } from "../../worker/park/publish";
import type { Parking, Rec, Redirect, Route } from "../../worker/lib/zone-state";
import { currentDict, errorText } from "../i18n";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    public params: Record<string, string | number> = {},
  ) {
    super(code);
  }
  /** The message in the current language. */
  override get message() {
    return errorText(currentDict(), this.code, this.params);
  }
}

// "You need to sign in" state: the app shows the sign-in screen.
let loginNeeded = false;
const loginListeners = new Set<() => void>();
const setLogin = (v: boolean) => {
  loginNeeded = v;
  loginListeners.forEach((l) => l());
};
export const useLoginNeeded = () =>
  useSyncExternalStore(
    (l) => (loginListeners.add(l), () => loginListeners.delete(l)),
    () => loginNeeded,
  );

// Install code typed on the setup page, kept for this tab until signing in works.
export const SETUP_CODE = "dpp:setup-code";

export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const code = sessionStorage.getItem(SETUP_CODE);
  const res = await fetch(`/api${path}`, {
    method,
    headers: { "x-dash-plus-plus": "1", ...(code && { "x-setup-code": code }), ...(body !== undefined && { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as { error?: string; params?: Record<string, string | number> };
  if (res.status === 401 && json.error === "login") {
    setLogin(true);
    throw new ApiError(401, "login");
  }
  if (!res.ok) throw new ApiError(res.status, json.error ?? "unexpected", json.params);
  return json as T;
}

// Minimal cache: shows the last data right away while reading it again.
const cache = new Map<string, unknown>();
const subs = new Map<string, Set<() => void>>();

export function setCached(path: string, value: unknown) {
  cache.set(path, value);
  subs.get(path)?.forEach((f) => f());
}

export function useApi<T>(path: string | null) {
  const [data, setData] = useState<T | undefined>(() => (path ? (cache.get(path) as T) : undefined));
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!path) return;
    setLoading(true);
    try {
      const v = await api<T>("GET", path);
      setCached(path, v);
      setError(null);
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    if (!path) return;
    setData(cache.get(path) as T);
    const f = () => setData(cache.get(path) as T);
    if (!subs.has(path)) subs.set(path, new Set());
    subs.get(path)!.add(f);
    load();
    return () => void subs.get(path)?.delete(f);
  }, [path, load]);

  return { data, error, loading, reload: load };
}

// Response types.

export type Me = {
  email: string;
  admin: boolean;
  // enabled false only for superadmins, who see every account of theirs to enable it.
  accounts: { id: string; name: string; enabled: boolean; syncToken: boolean }[];
  background: { enabled: boolean; lastSync: { started_at: number; finished_at: number | null; zones: number | null; changes: number | null; error: string | null } | null };
};

export type CachedZone = {
  syncedAt: number | null;
  usage: Usage | null;
  parking: Parking["state"] | null;
  redirectTarget: string | null;
  redirects: number | null;
  mail: { mode: MailReport["mode"] | null; provider: string | null; errors: number | null; warnings: number | null; checks: Pick<Check, "id" | "level" | "params">[] };
  lastChangeAt: number | null;
  records: number | null;
};

export type Usage = "parked" | "parking-partial" | "redirect" | "site" | "empty" | "unknown";

export type ZoneListItem = { id: string; name: string; status: string; paused: boolean; plan: string | null; cached: CachedZone | null };
export type ParkStatus = { published: boolean; legacy: string[] } | null;
export type ZoneList = { park: ParkStatus; zones: ZoneListItem[] };
export type ParkInfo = { status: NonNullable<ParkStatus>; settings: ParkSettings; publishedAt: number | null; updatedAt: number | null; updatedBy: string | null };
export type Group = { id: string; name: string; zones: string[] };
export type Done = { op: string; name?: string; value?: string };

export type Change = {
  id: number;
  zone_id: string;
  zone_name: string;
  detected_at: number;
  kind: "added" | "removed" | "changed";
  record_type: string;
  record_name: string;
  before: string | null;
  after: string | null;
  source: "external" | "dash";
  actor: string | null;
};

export type Audit = { id: number; at: number; actor: string; zone_id: string | null; zone_name: string | null; action: string; detail: string };

export type ZoneDetail = {
  zone: { id: string; name: string; status: string; account: { id: string; name: string }; nameServers: string[]; plan: string | null };
  records: Rec[];
  routes: Route[];
  routesError: string | null;
  servedBy: { host: string; worker: string; kind: "route" | "custom-domain" }[];
  customDomains: { hostname: string; service: string }[];
  rulesetError: string | null;
  parking: Parking;
  redirects: Redirect[];
  usage: Usage;
  mail: MailReport;
  park: ParkStatus;
  changes: Change[];
};

export type Mutation = { done: Done[]; zone: ZoneDetail };
