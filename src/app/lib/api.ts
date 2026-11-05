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
  // No network (or the phone lost it): a clear message, not the browser's technical one.
  const res = await fetch(`/api${path}`, {
    method,
    headers: { "x-dash-plus-plus": "1", ...(code && { "x-setup-code": code }), ...(body !== undefined && { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).catch(() => {
    throw new ApiError(0, "offline");
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

export const getCached = <T,>(path: string) => cache.get(path) as T | undefined;

// Reads started by a hover, used by the page that opens next instead of reading again.
const ahead = new Map<string, { at: number; p: Promise<unknown> }>();

/** Reads a path ahead of time, for instance when the pointer rests on a link. */
export function prefetch(path: string) {
  const a = ahead.get(path);
  if (a && Date.now() - a.at < 15_000) return;
  const p = api("GET", path).then((v) => setCached(path, v));
  p.catch(() => ahead.delete(path));
  ahead.set(path, { at: Date.now(), p });
}

/** The hover read of this path, if recent. */
function takeAhead(path: string) {
  const a = ahead.get(path);
  return a && Date.now() - a.at < 15_000 ? a.p : null;
}

export function useApi<T>(path: string | null) {
  const [data, setData] = useState<T | undefined>(() => (path ? (cache.get(path) as T) : undefined));
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!path) return;
    setLoading(true);
    try {
      setCached(path, await api<T>("GET", path));
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
    const a = takeAhead(path);
    if (a) a.catch(() => load());
    else load();
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
  mail: { mode: MailReport["mode"] | null; provider: string | null; errors: number | null; warnings: number | null; checks: Pick<Check, "id" | "level" | "params" | "name">[] };
  lastChangeAt: number | null;
  records: number | null;
};

export type Usage = "parked" | "parking-partial" | "redirect" | "site" | "empty" | "unknown";

export type ZoneListItem = { id: string; name: string; status: string; paused: boolean; plan: string | null; cached: CachedZone | null };
export type ParkStatus = { published: boolean; legacy: string[] } | null;
export type ZoneList = { park: ParkStatus; canPark: boolean; zones: ZoneListItem[] };
export type ParkInfo = { status: NonNullable<ParkStatus>; settings: ParkSettings; publishedAt: number | null; updatedAt: number | null; updatedBy: string | null; canManage: boolean };
export type Group = { id: string; name: string; zones: string[]; access?: { email: string; pending: boolean }[] };
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
  canPark: boolean;
  changes: Change[];
};

export type Mutation = { done: Done[]; zone: ZoneDetail };
