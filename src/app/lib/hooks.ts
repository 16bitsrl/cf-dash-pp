import { useKumoToastManager } from "@cloudflare/kumo";
import { useCallback, useEffect, useRef, useState } from "react";
import { doneText, useT } from "../i18n";
import { api, ApiError, getCached, prefetch, setCached, useApi, type Done, type Mutation, type ZoneList } from "./api";
import { parseRoute } from "./router";

/** Domains of the account. If some were never read, reads them right away with the user's token. */
export function useZones(acc: string) {
  const q = useApi<ZoneList>(`/accounts/${acc}/zones`);
  const [syncing, setSyncing] = useState(false);
  const tried = useRef<string | null>(null);

  const sync = useCallback(
    async (missing: boolean) => {
      setSyncing(true);
      try {
        await api("POST", `/accounts/${acc}/sync`, { missing });
        await q.reload();
      } finally {
        setSyncing(false);
      }
    },
    [acc, q.reload],
  );

  useEffect(() => {
    if (!q.data || tried.current === acc) return;
    if (q.data.zones.some((z) => !z.cached)) {
      tried.current = acc;
      sync(true).catch(() => {});
    }
  }, [q.data, acc, sync]);

  return { ...q, syncing, syncAll: () => sync(false) };
}

/** Runs a request that changes something, with a toast for the outcome. */
export function useAction() {
  const t = useT();
  const toast = useKumoToastManager();
  const [busy, setBusy] = useState(false);
  const run = useCallback(
    async <R extends { done?: Done[] }>(method: string, path: string, body: unknown, success: string | ((res: R) => string)): Promise<R | null> => {
      setBusy(true);
      try {
        const res = await api<R>(method, path, body);
        const done = res.done;
        toast.add({ title: typeof success === "function" ? success(res) : success, description: done ? (done.length ? done.map((d) => doneText(t, d)).join(" · ") : t.doneNothing) : undefined, variant: "success" });
        return res;
      } catch (e) {
        toast.add({ title: t.failed, description: (e as ApiError).message, variant: "error" });
        return null;
      } finally {
        setBusy(false);
      }
    },
    [toast, t],
  );
  return { run, busy };
}

/** A change on a zone: also refreshes the zone shown on the page. */
export function useMutation() {
  const { run, busy } = useAction();
  return {
    busy,
    run: useCallback(
      async (zoneId: string, method: string, path: string, body: unknown, success: string) => {
        const res = await run<Mutation>(method, `/zones/${zoneId}${path}`, body, success);
        if (res) setCached(`/zones/${zoneId}`, res.zone);
        return res;
      },
      [run],
    ),
  };
}

/** Reads a domain ahead of time when the pointer rests on a link to it, so its page opens right away. */
export function useZonePrefetch() {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onOver = (e: PointerEvent) => {
      clearTimeout(timer);
      const a = (e.target as Element).closest?.("a");
      if (!a) return;
      const url = new URL(a.href, location.href);
      const r = parseRoute(url.pathname);
      if (url.origin !== location.origin || r.page !== "zone" || location.pathname.startsWith(`/${r.acc}/${r.zone}`)) return;
      const id = getCached<ZoneList>(`/accounts/${r.acc}/zones`)?.zones.find((z) => z.name === r.zone)?.id;
      if (id) timer = setTimeout(() => prefetch(`/zones/${id}`), 100);
    };
    const onOut = () => clearTimeout(timer);
    document.addEventListener("pointerover", onOver);
    document.addEventListener("pointerout", onOut);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("pointerover", onOver);
      document.removeEventListener("pointerout", onOut);
    };
  }, []);
}
