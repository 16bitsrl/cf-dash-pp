import { Badge, Button, Dialog, DropdownMenu, Sidebar, useSidebar } from "@cloudflare/kumo";
import {
  ArrowBendUpRightIcon,
  ArrowSquareOutIcon,
  CaretUpDownIcon,
  CheckIcon,
  DeviceMobileIcon,
  ExportIcon,
  PlusSquareIcon,
  XIcon,
  GearSixIcon,
  PlugsConnectedIcon,
  ClockCounterClockwiseIcon,
  EnvelopeSimpleIcon,
  FoldersIcon,
  GlobeIcon,
  HouseIcon,
  ListIcon,
  SignOutIcon,
  SignpostIcon,
  TranslateIcon,
  UserCircleIcon,
} from "@phosphor-icons/react";
import { useEffect, useState, type ReactNode } from "react";
import { QuickSearch, QuickSearchButton, useQuickSearchShortcut } from "./QuickSearch";
import { LANGS, setLang, useLang, useT, type Lang } from "../i18n";
import type { Me } from "../lib/api";
import { dash } from "../lib/format";
import { useInstall } from "../lib/install";
import { navigate, PAGE_PATH, useLocation, type Route } from "../lib/router";

export function Shell({ me, route, children }: { me: Me; route: Route & { acc: string }; children: ReactNode }) {
  const t = useT();
  const lang = useLang();
  const [searching, setSearching] = useState(false);
  const install = useInstall();
  const [iosSteps, setIosSteps] = useState(false);
  useQuickSearchShortcut(setSearching);
  const account = me.accounts.find((a) => a.id === route.acc);
  const current = route.page === "zone" ? "domains" : route.page;
  const href = (page: string) => (page === "home" ? `/${route.acc}` : `/${route.acc}/${PAGE_PATH[page]}`);

  const nav = [
    { page: "home", label: t.nav.overview, icon: HouseIcon },
    { page: "domains", label: t.nav.domains, icon: GlobeIcon },
  ];
  const manage = [
    { page: "parking", label: t.nav.parking, icon: SignpostIcon },
    { page: "redirects", label: t.nav.redirects, icon: ArrowBendUpRightIcon },
    { page: "mail", label: t.nav.mail, icon: EnvelopeSimpleIcon },
    { page: "groups", label: t.nav.groups, icon: FoldersIcon },
    { page: "activity", label: t.nav.activity, icon: ClockCounterClockwiseIcon },
  ];

  async function signOut() {
    const res = await fetch("/auth/logout", { method: "POST" })
      .then((r) => r.json() as Promise<{ redirect: string }>)
      .catch(() => ({ redirect: "/" }));
    location.href = res.redirect;
  }

  return (
    <Sidebar.Provider defaultOpen className="h-dvh overflow-hidden [--sidebar-bg:var(--color-kumo-canvas)]">
      <Sidebar>
        <Sidebar.Header className="h-[57px] border-b border-kumo-hairline px-4">
          <div className="flex h-full items-center gap-3">
            <a href={`/${route.acc}`} aria-label="Dash++" className="shrink-0">
              <img src="/logo.svg" alt="" className="size-8" />
            </a>
            <DropdownMenu>
              <DropdownMenu.Trigger
                render={(p) => (
                  <button {...p} type="button" className="flex min-w-0 flex-1 cursor-pointer items-center justify-between gap-2 rounded-md px-2 py-1 text-left text-sm font-medium text-kumo-default hover:bg-kumo-tint">
                    <span className="truncate">{account?.name}</span>
                    <CaretUpDownIcon size={14} className="shrink-0 text-kumo-subtle" />
                  </button>
                )}
              />
              <DropdownMenu.Content sideOffset={6} className="min-w-56">
                {me.accounts.map((a) => (
                  <DropdownMenu.Item key={a.id} icon={a.id === route.acc ? CheckIcon : undefined} inset={a.id !== route.acc} onClick={() => navigate(`/${a.id}`)}>
                    {a.name}
                    {!a.enabled && (
                      <Badge variant="outline" className="ml-2">
                        {t.setup.statusOff}
                      </Badge>
                    )}
                  </DropdownMenu.Item>
                ))}
              </DropdownMenu.Content>
            </DropdownMenu>
          </div>
        </Sidebar.Header>
        <div className="px-3 pt-3">
          <QuickSearchButton onClick={() => setSearching(true)} />
        </div>
        <Sidebar.Content className="pt-3">
          <Sidebar.Group>
            <Sidebar.Menu>
              {nav.map((n) => (
                <Sidebar.MenuButton key={n.page} icon={n.icon} href={href(n.page)} active={current === n.page} tooltip={n.label}>
                  {n.label}
                </Sidebar.MenuButton>
              ))}
            </Sidebar.Menu>
          </Sidebar.Group>
          <Sidebar.Group>
            <Sidebar.GroupLabel>{t.nav.manage}</Sidebar.GroupLabel>
            <Sidebar.Menu>
              {manage.map((n) => (
                <Sidebar.MenuButton key={n.page} icon={n.icon} href={href(n.page)} active={current === n.page} tooltip={n.label}>
                  {n.label}
                </Sidebar.MenuButton>
              ))}
            </Sidebar.Menu>
          </Sidebar.Group>
          <Sidebar.Group>
            <Sidebar.GroupLabel>{t.nav.cloudflare}</Sidebar.GroupLabel>
            <Sidebar.Menu>
              <Sidebar.MenuButton icon={ArrowSquareOutIcon} href={dash.account(route.acc, "/home/domains")} target="_blank" tooltip={t.nav.dashboard}>
                {t.nav.dashboard}
              </Sidebar.MenuButton>
            </Sidebar.Menu>
          </Sidebar.Group>
        </Sidebar.Content>
        <Sidebar.Footer className="border-t border-kumo-hairline px-3 py-2">
          <Sidebar.Trigger />
        </Sidebar.Footer>
      </Sidebar>

      <div className="flex min-w-0 flex-1 flex-col overflow-y-auto">
        <header className="sticky top-0 z-10 flex h-[57px] shrink-0 items-center justify-between border-b border-kumo-hairline bg-kumo-canvas px-4 md:px-6">
          <div className="flex items-center gap-2">
            <MobileMenu />
            <a href={`/${route.acc}`} className="text-[15px] font-semibold tracking-tight text-kumo-default">
              Dash<span className="text-[#f6821f]">++</span>
            </a>
          </div>
          <DropdownMenu>
            <DropdownMenu.Trigger
              render={(p) => (
                <button {...p} type="button" aria-label={t.nav.account} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-sm text-kumo-default hover:bg-kumo-tint">
                  <span className="hidden text-kumo-subtle sm:inline">{me.email}</span>
                  <UserCircleIcon size={20} />
                </button>
              )}
            />
            <DropdownMenu.Content sideOffset={6} align="end" className="min-w-48">
              <DropdownMenu.Sub>
                <DropdownMenu.SubTrigger icon={TranslateIcon}>{t.nav.language}</DropdownMenu.SubTrigger>
                <DropdownMenu.SubContent>
                  {(Object.keys(LANGS) as Lang[]).map((l) => (
                    <DropdownMenu.Item key={l} icon={l === lang ? CheckIcon : undefined} inset={l !== lang} onClick={() => setLang(l)}>
                      {LANGS[l].label}
                    </DropdownMenu.Item>
                  ))}
                </DropdownMenu.SubContent>
              </DropdownMenu.Sub>
              {install.mode && (
                <DropdownMenu.Item icon={DeviceMobileIcon} onClick={() => (install.mode === "prompt" ? install.prompt() : setIosSteps(true))}>
                  {t.nav.install}
                </DropdownMenu.Item>
              )}
              <DropdownMenu.LinkItem href="/mcp" icon={PlugsConnectedIcon}>
                {t.mcp.menu}
              </DropdownMenu.LinkItem>
              {me.admin && (
                <DropdownMenu.LinkItem href="/setup" icon={GearSixIcon}>
                  {t.nav.setup}
                </DropdownMenu.LinkItem>
              )}
              <DropdownMenu.Item icon={SignOutIcon} onClick={signOut}>
                {t.nav.signOut}
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu>
        </header>
        <main className="flex-1 pb-16">{children}</main>
        <QuickSearch me={me} acc={route.acc} open={searching} setOpen={setSearching} />
        <IosInstall open={iosSteps} onOpenChange={setIosSteps} />
      </div>
    </Sidebar.Provider>
  );
}

/** On small screens the sidebar is a sheet: this opens it, and closes it once a page is picked. */
function MobileMenu() {
  const path = useLocation();
  const t = useT();
  const { isMobile, setOpenMobile } = useSidebar();
  useEffect(() => setOpenMobile(false), [path, setOpenMobile]);
  return isMobile ? <Button variant="ghost" size="sm" shape="square" icon={<ListIcon size={20} />} aria-label={t.nav.menu} onClick={() => setOpenMobile(true)} /> : null;
}

/** Safari on iPhone and iPad can't install by itself: the two steps, with the icons the user will see. */
function IosInstall({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const t = useT();
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog size="sm" className="p-6">
        <div className="mb-3 flex items-start justify-between gap-4">
          <Dialog.Title className="text-lg font-semibold">{t.nav.installTitle}</Dialog.Title>
          <Dialog.Close render={(p) => <Button {...p} variant="ghost" size="sm" shape="square" icon={XIcon} aria-label={t.common.close} />} />
        </div>
        <Dialog.Description className="text-sm text-kumo-subtle">{t.nav.installIos}</Dialog.Description>
        <ol className="mt-5 flex flex-col gap-4 text-sm">
          <li className="flex items-start gap-3">
            <ExportIcon size={22} className="shrink-0 text-kumo-link" />
            <span>{t.nav.installStep1}</span>
          </li>
          <li className="flex items-start gap-3">
            <PlusSquareIcon size={22} className="shrink-0 text-kumo-link" />
            <span>{t.nav.installStep2}</span>
          </li>
        </ol>
        <div className="mt-6 flex justify-end">
          <Dialog.Close render={(p) => <Button {...p} variant="primary">{t.common.close}</Button>} />
        </div>
      </Dialog>
    </Dialog.Root>
  );
}
