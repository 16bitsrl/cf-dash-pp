import { useEffect, useSyncExternalStore } from "react";

// Minimal router on the History API. Internal <a href="/..."> links are intercepted by a
// single listener, so links rendered by Kumo components work too.

const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function navigate(to: string, replace = false) {
  if (to === location.pathname + location.search) return;
  history[replace ? "replaceState" : "pushState"](null, "", to);
  emit();
  if (!replace) window.scrollTo(0, 0);
}

export function useLocation() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => location.pathname + location.search,
  );
}

export function useLinkInterception() {
  useEffect(() => {
    const onPop = () => emit();
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element).closest?.("a");
      if (!a || a.target || a.hasAttribute("download") || a.dataset.external !== undefined) return;
      const url = new URL(a.href, location.href);
      if (url.origin !== location.origin || url.pathname.startsWith("/auth/") || url.pathname.startsWith("/cdn-cgi/")) return;
      e.preventDefault();
      navigate(url.pathname + url.search);
    };
    window.addEventListener("popstate", onPop);
    document.addEventListener("click", onClick);
    return () => {
      window.removeEventListener("popstate", onPop);
      document.removeEventListener("click", onClick);
    };
  }, []);
}

export type Route =
  | { page: "root" }
  | { page: "home"; acc: string }
  | { page: "domains" | "parking" | "redirects" | "mail" | "activity" | "groups"; acc: string }
  | { page: "zone"; acc: string; zone: string; tab: string }
  | { page: "notfound" };

const PAGES: Record<string, Route["page"]> = { domains: "domains", parking: "parking", redirects: "redirects", email: "mail", activity: "activity", groups: "groups" };
export const PAGE_PATH = Object.fromEntries(Object.entries(PAGES).map(([k, v]) => [v, k])) as Record<string, string>;

export function parseRoute(path: string): Route {
  const parts = path.split("?")[0].split("/").filter(Boolean).map(decodeURIComponent);
  if (!parts.length) return { page: "root" };
  const [acc, second, third] = parts;
  if (!/^[0-9a-f]{32}$/.test(acc)) return { page: "notfound" };
  if (!second) return { page: "home", acc };
  if (second.includes(".")) return { page: "zone", acc, zone: second, tab: third ?? "overview" };
  const page = PAGES[second];
  return page ? ({ page, acc } as Route) : { page: "notfound" };
}

export type ZoneTab = "overview" | "parking" | "redirects" | "email" | "dns" | "history";
export const zonePath = (acc: string, zone: string, tab?: ZoneTab) => `/${acc}/${zone}${tab && tab !== "overview" ? `/${tab}` : ""}`;
