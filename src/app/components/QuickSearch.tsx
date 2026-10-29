import { CommandPalette } from "@cloudflare/kumo";
import {
  ArrowBendUpRightIcon,
  ArrowSquareOutIcon,
  BuildingsIcon,
  ClockCounterClockwiseIcon,
  EnvelopeSimpleIcon,
  FoldersIcon,
  GearSixIcon,
  GlobeIcon,
  HouseIcon,
  ListBulletsIcon,
  MagnifyingGlassIcon,
  SignpostIcon,
} from "@phosphor-icons/react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useT } from "../i18n";
import { useApi, type Me, type ZoneList } from "../lib/api";
import { dash } from "../lib/format";
import { navigate, zonePath } from "../lib/router";
import { UsageBadge } from "./ui";

type Item = { id: string; title: string; hint?: ReactNode; icon: ReactNode; href: string; external?: boolean; keywords?: string };
type Group = { id: string; label: string; items: Item[] };

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
export const shortcutLabel = isMac ? "⌘K" : "Ctrl K";

/** Opens on ⌘K / Ctrl+K, like the Cloudflare dashboard. */
export function useQuickSearchShortcut(setOpen: (f: (o: boolean) => boolean) => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setOpen]);
}

export function QuickSearchButton({ onClick }: { onClick: () => void }) {
  const t = useT();
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full cursor-pointer items-center gap-2 rounded-lg border border-kumo-line bg-kumo-base px-3 py-2 text-left text-sm text-kumo-subtle shadow-xs hover:bg-kumo-tint"
    >
      <MagnifyingGlassIcon size={16} className="shrink-0" />
      <span className="flex-1 truncate">{t.search.button}</span>
      <kbd className="font-sans text-xs text-kumo-subtle">{shortcutLabel}</kbd>
    </button>
  );
}

export function QuickSearch({ me, acc, open, setOpen }: { me: Me; acc: string; open: boolean; setOpen: (o: boolean) => void }) {
  const t = useT();
  const zones = useApi<ZoneList>(`/accounts/${acc}/zones`);
  const [q, setQ] = useState("");
  useEffect(() => {
    if (!open) setQ("");
  }, [open]);

  const groups = useMemo<Group[]>(() => {
    const s = q.trim().toLowerCase();
    const match = (i: Item) => !s || `${i.title} ${i.keywords ?? ""}`.toLowerCase().includes(s);
    const pages: Item[] = [
      { id: "p-home", title: t.nav.overview, icon: <HouseIcon />, href: `/${acc}` },
      { id: "p-domains", title: t.nav.domains, icon: <GlobeIcon />, href: `/${acc}/domains` },
      { id: "p-parking", title: t.nav.parking, icon: <SignpostIcon />, href: `/${acc}/parking` },
      { id: "p-redirects", title: t.nav.redirects, icon: <ArrowBendUpRightIcon />, href: `/${acc}/redirects` },
      { id: "p-mail", title: t.nav.mail, icon: <EnvelopeSimpleIcon />, href: `/${acc}/email`, keywords: "mx spf dkim dmarc" },
      { id: "p-groups", title: t.nav.groups, icon: <FoldersIcon />, href: `/${acc}/groups` },
      { id: "p-activity", title: t.nav.activity, icon: <ClockCounterClockwiseIcon />, href: `/${acc}/activity` },
      ...(me.admin ? [{ id: "p-setup", title: t.nav.setup, icon: <GearSixIcon />, href: "/setup" }] : []),
    ];
    const allZones = zones.data?.zones ?? [];
    const found = allZones.filter((z) => !s || z.name.includes(s));
    const domains: Item[] = found.slice(0, 20).map((z) => ({ id: `z-${z.id}`, title: z.name, icon: <GlobeIcon />, hint: <UsageBadge usage={z.cached?.usage} />, href: zonePath(acc, z.name) }));
    // With a precise search, also the sections of those domains and their Cloudflare page.
    const sections: Item[] =
      s && found.length <= 3
        ? found.flatMap((z) => [
            { id: `s-${z.id}-email`, title: `${z.name} › ${t.zone.tabs.mail}`, icon: <EnvelopeSimpleIcon />, href: zonePath(acc, z.name, "email") },
            { id: `s-${z.id}-parking`, title: `${z.name} › ${t.zone.tabs.parking}`, icon: <SignpostIcon />, href: zonePath(acc, z.name, "parking") },
            { id: `s-${z.id}-redirects`, title: `${z.name} › ${t.zone.tabs.redirects}`, icon: <ArrowBendUpRightIcon />, href: zonePath(acc, z.name, "redirects") },
            { id: `s-${z.id}-dns`, title: `${z.name} › ${t.zone.tabs.dns}`, icon: <ListBulletsIcon />, href: zonePath(acc, z.name, "dns") },
            { id: `s-${z.id}-history`, title: `${z.name} › ${t.zone.tabs.history}`, icon: <ClockCounterClockwiseIcon />, href: zonePath(acc, z.name, "history") },
            { id: `s-${z.id}-cf`, title: `${z.name} › ${t.common.openInCloudflare}`, icon: <ArrowSquareOutIcon />, href: dash.zone(acc, z.name), external: true },
          ])
        : [];
    const accounts: Item[] = me.accounts.filter((a) => a.id !== acc).map((a) => ({ id: `a-${a.id}`, title: a.name, icon: <BuildingsIcon />, href: `/${a.id}` }));
    return [
      { id: "domains", label: t.search.domains, items: domains },
      { id: "sections", label: t.search.sections, items: sections },
      { id: "pages", label: t.search.pages, items: pages.filter(match) },
      { id: "accounts", label: t.search.accounts, items: accounts.filter(match) },
    ].filter((g) => g.items.length);
  }, [q, zones.data, me, acc, t]);

  const go = (item: Item, newTab = false) => {
    setOpen(false);
    if (item.external || newTab) window.open(item.href, "_blank", "noopener");
    else navigate(item.href);
  };

  return (
    <CommandPalette.Root
      open={open}
      onOpenChange={setOpen}
      items={groups}
      value={q}
      onValueChange={setQ}
      itemToStringValue={(g: Group) => g.label}
      getSelectableItems={(gs: Group[]) => gs.flatMap((g) => g.items)}
      onSelect={(item: Item, opts?: { newTab?: boolean }) => go(item, opts?.newTab)}
    >
      <CommandPalette.Input placeholder={t.search.placeholder} />
      <CommandPalette.List>
        {!zones.data ? (
          <CommandPalette.Loading />
        ) : (
          <>
            <CommandPalette.Results>
              {(group: Group) => (
                <CommandPalette.Group key={group.id} items={group.items}>
                  <CommandPalette.GroupLabel>{group.label}</CommandPalette.GroupLabel>
                  <CommandPalette.Items>
                    {(item: Item) => (
                      <CommandPalette.Item key={item.id} value={item} onClick={() => go(item)}>
                        <span className="flex w-full items-center gap-3">
                          <span className="text-kumo-subtle">{item.icon}</span>
                          <span className="flex-1 truncate">{item.title}</span>
                          {item.hint}
                          {item.external && <ArrowSquareOutIcon size={14} className="text-kumo-subtle" />}
                        </span>
                      </CommandPalette.Item>
                    )}
                  </CommandPalette.Items>
                </CommandPalette.Group>
              )}
            </CommandPalette.Results>
            <CommandPalette.Empty>{t.search.empty}</CommandPalette.Empty>
          </>
        )}
      </CommandPalette.List>
      <CommandPalette.Footer>
        <span className="flex items-center gap-2">
          <kbd className="rounded border border-kumo-hairline bg-kumo-base px-1.5 py-0.5 text-[10px]">↑↓</kbd>
          <span>{t.search.navigate}</span>
        </span>
        <span className="flex items-center gap-2">
          <kbd className="rounded border border-kumo-hairline bg-kumo-base px-1.5 py-0.5 text-[10px]">↵</kbd>
          <span>{t.search.select}</span>
        </span>
        <span className="flex items-center gap-2">
          <kbd className="rounded border border-kumo-hairline bg-kumo-base px-1.5 py-0.5 text-[10px]">{isMac ? "⌘↵" : "Ctrl ↵"}</kbd>
          <span>{t.search.newTab}</span>
        </span>
      </CommandPalette.Footer>
    </CommandPalette.Root>
  );
}
