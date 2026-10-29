import type { ParkPageDef, ParkSettings } from "../../worker/park/publish";
import { useT } from "../i18n";
import { setCached, useApi, type ParkInfo } from "./api";
import { useAction } from "./hooks";

/** How a page is called in Dash++: its own name, else the brand, else "anonymous". */
export function usePageName() {
  const t = useT();
  return (p: ParkPageDef) => p.label.trim() || p.brand?.name.trim() || (p.brand ? t.parking.untitledPage : t.parking.neutralPage);
}

/** The parking pages of the account and which one each domain uses. Changing a domain's page publishes right away. */
export function useParkPages(acc: string, enabled = true) {
  const t = useT();
  const path = `/accounts/${acc}/park`;
  const park = useApi<ParkInfo>(enabled ? path : null);
  const action = useAction();
  const pageName = usePageName();
  const settings = park.data?.settings;
  const pageOf = (domain: string) => (settings && settings.assign[domain]) || settings?.defaultPage || "";
  const items = settings ? Object.fromEntries(settings.pages.map((p) => [p.id, p.id === settings.defaultPage ? `${pageName(p)} (${t.parking.default})` : pageName(p)])) : {};

  async function setPageOf(domains: string | string[], id: string) {
    if (!settings) return false;
    const assign = { ...settings.assign };
    for (const domain of [domains].flat()) {
      if (id === settings.defaultPage) delete assign[domain];
      else assign[domain] = id;
    }
    const next: ParkSettings = { ...settings, assign };
    setCached(path, { ...park.data, settings: next });
    const ok = !!(await action.run("PUT", path, next, t.parking.published));
    if (!ok) park.reload();
    return ok;
  }

  return { park, settings, pageName, pageOf, setPageOf, items, busy: action.busy };
}

export const parkingPagePath = (acc: string, page?: string) => `/${acc}/parking${page ? `?page=${encodeURIComponent(page)}` : ""}`;
