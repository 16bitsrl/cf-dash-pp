import { Badge, Banner, Breadcrumbs, Button, Checkbox, DropdownMenu, Input, LayerCard, Select, Switch, Table, Tabs, useKumoToastManager } from "@cloudflare/kumo";
import { ClockCounterClockwiseIcon, GearSixIcon, InfoIcon, PlusIcon, SignpostIcon, TrashIcon, UploadSimpleIcon } from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import { NO_SITE, parkPage } from "../../worker/park/page";
import { siteUrl, type Asset, type Brand, type ParkPageDef, type ParkSettings } from "../../worker/park/publish";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Container, DeepLink, EmptyState, ErrorState, Loading, PageHeader, TableCard, UsageBadge } from "../components/ui";
import { useLang, useT, type Lang } from "../i18n";
import { api, setCached, useApi, type ApiError, type Mutation, type ParkInfo, type ZoneListItem } from "../lib/api";
import { dash, useFormat } from "../lib/format";
import { useAction, useMutation, useZones } from "../lib/hooks";
import { parkingPagesPath, usePageName, useParkPages } from "../lib/park";
import { navigate, useLocation, zonePath } from "../lib/router";
import { SearchBox, SyncButton, useFilter } from "./Domains";

type ParkVersion = { id: string; number: number; at: number; by: string | null };

const NEW_BRAND: Brand = { name: "", site: null, accent: "#f6821f", leadEn: null, leadIt: null, logo: null, logoHeight: null, icon: null };

const readFile = (file: File) =>
  new Promise<Asset>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve({ type: file.type, data: String(r.result).split(",")[1] });
    r.onerror = reject;
    r.readAsDataURL(file);
  });

const dataUrl = (a: Asset | null) => (a ? `data:${a.type};base64,${a.data}` : null);
const badSite = (b: Brand) => !!b.site?.trim() && !siteUrl(b.site);

const IMAGE_TYPES = ["image/png", "image/svg+xml", "image/jpeg", "image/webp"];

function ImageField({ label, value, onChange }: { label: string; value: Asset | null; onChange: (a: Asset | null) => void }) {
  const t = useT();
  const [over, setOver] = useState(false);
  const pick = async (file: File | undefined) => file && IMAGE_TYPES.includes(file.type) && onChange(await readFile(file));
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-sm font-medium">{label}</span>
      <div
        className={`-m-1 flex items-center gap-3 rounded-lg border border-dashed p-1 ${over ? "border-kumo-brand bg-kumo-tint" : "border-transparent"}`}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          pick(e.dataTransfer.files[0]);
        }}
      >
        <div className="flex h-12 w-28 items-center justify-center rounded-md border border-kumo-hairline bg-kumo-canvas p-1">{value ? <img src={dataUrl(value)!} alt="" className="max-h-full max-w-full object-contain" /> : <span className="text-xs text-kumo-subtle">{t.parking.dropImage}</span>}</div>
        <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-kumo-line px-2.5 py-1 text-sm hover:bg-kumo-tint">
          <UploadSimpleIcon size={14} /> {t.parking.upload}
          <input type="file" accept={IMAGE_TYPES.join(",")} className="sr-only" onChange={(e) => pick(e.target.files?.[0])} />
        </label>
        {value && (
          <Button size="sm" variant="ghost" onClick={() => onChange(null)}>
            {t.parking.removeImage}
          </Button>
        )}
      </div>
    </div>
  );
}

function PageSettings({ acc, info, onSaved, sample, parked, initialPage }: { acc: string; info: ParkInfo; onSaved: () => void; sample: string; parked: string[]; initialPage: string | null }) {
  const t = useT();
  const f = useFormat();
  const uiLang = useLang();
  const pageName = usePageName();
  const { run, busy } = useAction();
  const [s, setS] = useState<ParkSettings>(info.settings);
  const [sel, setSel] = useState(initialPage ?? info.settings.defaultPage);
  const [removing, setRemoving] = useState(false);
  const [host, setHost] = useState(sample);
  const [lang, setLang] = useState<Lang>(uiLang);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const versions = useApi<{ versions: ParkVersion[] }>(versionsOpen ? `/accounts/${acc}/park/versions` : null);
  const toast = useKumoToastManager();
  // Start over only when the pages were saved, not on every refresh: unsaved edits stay.
  useEffect(() => setS(info.settings), [info.updatedAt]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => setHost((h) => (h === "example.com" ? sample : h)), [sample]);
  const page = s.pages.find((p) => p.id === sel) ?? s.pages[0];
  const brand = page.brand;
  const setPage = (p: Partial<ParkPageDef>) => setS({ ...s, pages: s.pages.map((x) => (x.id === page.id ? { ...x, ...p } : x)) });
  const setBrand = (b: Partial<Brand>) => setPage({ brand: { ...(brand ?? NEW_BRAND), ...b } });
  const isDefault = page.id === s.defaultPage;
  // Domains are assigned from the list below, which saves on its own: always use the saved ones.
  const using = Object.values(info.settings.assign).filter((id) => id === page.id).length;
  const usedBy = parked.filter((d) => (info.settings.assign[d] ?? info.settings.defaultPage) === page.id);

  const preview = useMemo(() => {
    const b = brand && { ...brand, logo: dataUrl(brand.logo), icon: dataUrl(brand.icon) };
    return parkPage({ pages: { [page.id]: { brand: b, noneEn: page.noneEn ?? null, noneIt: page.noneIt ?? null } }, defaultPage: page.id, assign: {} }, { host: host || "example.com", lang });
  }, [page, brand, host, lang]);

  // Loads an earlier publication in the editor: nothing changes until it is published again.
  async function loadVersion(v: ParkVersion) {
    try {
      const { settings } = await api<{ settings: ParkSettings }>("GET", `/accounts/${acc}/park/versions/${v.id}`);
      setS({ ...settings, assign: s.assign });
      setSel(settings.defaultPage);
      toast.add({ title: t.parking.versionLoaded(v.number), description: t.parking.versionLoadedHint, variant: "success" });
    } catch (e) {
      toast.add({ title: t.failed, description: (e as ApiError).message, variant: "error" });
    }
  }

  function addPage() {
    const id = `p-${Math.random().toString(36).slice(2, 8)}`;
    setS({ ...s, pages: [...s.pages, { id, label: "", brand: NEW_BRAND, noneEn: null, noneIt: null }] });
    setSel(id);
  }

  return (
    <LayerCard>
      <LayerCard.Primary>
        <div className="mb-6 flex flex-wrap items-end gap-2">
          <Select
            className="w-72"
            label={t.parking.editing}
            value={page.id}
            onValueChange={(v) => setSel(String(v))}
            items={Object.fromEntries(s.pages.map((p) => [p.id, p.id === s.defaultPage ? `${pageName(p)} (${t.parking.default})` : pageName(p)]))}
          />
          <Button variant="secondary" icon={PlusIcon} onClick={addPage} disabled={s.pages.length >= 20}>
            {t.parking.newPage}
          </Button>
          {info.status.published && (
            <DropdownMenu onOpenChange={(o) => o && setVersionsOpen(true)}>
              <DropdownMenu.Trigger render={(p) => <Button {...p} variant="secondary" icon={ClockCounterClockwiseIcon}>{t.parking.versions}</Button>} />
              <DropdownMenu.Content align="start">
                {!versions.data ? (
                  <DropdownMenu.Item disabled>{t.common.loading}</DropdownMenu.Item>
                ) : versions.data.versions.length < 2 ? (
                  <DropdownMenu.Item disabled>{t.parking.noVersions}</DropdownMenu.Item>
                ) : (
                  versions.data.versions.slice(1).map((v) => (
                    <DropdownMenu.Item key={v.id} onClick={() => loadVersion(v)}>
                      {t.parking.version(v.number, f.ago(v.at), v.by ?? "")}
                    </DropdownMenu.Item>
                  ))
                )}
              </DropdownMenu.Content>
            </DropdownMenu>
          )}
        </div>
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
          <div className="flex flex-col gap-4">
            <Input label={t.parking.pageName} placeholder={pageName({ ...page, label: "" })} value={page.label} onChange={(e) => setPage({ label: e.target.value })} description={t.parking.pageNameHint} />
            <div className="flex flex-wrap items-center gap-3">
              {isDefault ? (
                <Badge variant="outline">{t.parking.isDefault}</Badge>
              ) : (
                <>
                  <Button size="sm" variant="secondary" onClick={() => setS({ ...s, defaultPage: page.id })}>
                    {t.parking.makeDefault}
                  </Button>
                  <Button size="sm" variant="ghost" icon={TrashIcon} onClick={() => setRemoving(true)}>
                    {t.parking.deletePage}
                  </Button>
                </>
              )}
            </div>
            {usedBy.length ? (
              <p className="text-sm">
                <span className="font-medium">{t.parking.usedBy}: </span>
                {usedBy.slice(0, 3).map((d, i) => (
                  <span key={d}>
                    {i > 0 && ", "}
                    <a href={zonePath(acc, d, "parking")} className="underline decoration-kumo-line underline-offset-4 hover:decoration-current">
                      {d}
                    </a>
                  </span>
                ))}
                {usedBy.length > 3 && t.parking.usedByMore(usedBy.length - 3)}
              </p>
            ) : (
              <p className="text-sm text-kumo-subtle">{info.settings.pages.some((p) => p.id === page.id) ? t.parking.usedByNone : t.parking.usedByNew}</p>
            )}
            <Switch label={t.parking.brand} checked={!!brand} onCheckedChange={(v) => setPage({ brand: v ? (info.settings.pages.find((p) => p.id === page.id)?.brand ?? NEW_BRAND) : null })} />
            {!brand ? (
              <p className="text-sm text-kumo-subtle">{t.parking.noBrand}</p>
            ) : (
              <>
                <div className="grid items-start gap-4 sm:grid-cols-2">
                  <Input label={t.parking.brandName} value={brand.name} onChange={(e) => setBrand({ name: e.target.value })} />
                  <Input
                    label={t.parking.brandSite}
                    placeholder="https://example.com"
                    value={brand.site ?? ""}
                    onChange={(e) => setBrand({ site: e.target.value || null })}
                    onBlur={() => brand.site && siteUrl(brand.site) && setBrand({ site: siteUrl(brand.site) })}
                    error={badSite(brand) ? t.parking.brandSiteInvalid : undefined}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <span className="text-sm font-medium">{t.parking.brandColor}</span>
                  <div className="flex items-center gap-2">
                    <input type="color" aria-label={t.parking.brandColor} value={brand.accent} onChange={(e) => setBrand({ accent: e.target.value })} className="h-9 w-12 cursor-pointer rounded-md border border-kumo-line bg-kumo-base" />
                    <Input aria-label={t.parking.brandColor} value={brand.accent} onChange={(e) => setBrand({ accent: e.target.value })} className="w-28 font-mono" />
                  </div>
                </div>
                <div className="grid items-start gap-4 sm:grid-cols-2">
                  <ImageField label={t.parking.brandLogo} value={brand.logo} onChange={(logo) => setBrand({ logo })} />
                  <ImageField label={t.parking.brandIcon} value={brand.icon} onChange={(icon) => setBrand({ icon })} />
                </div>
                <Input label={t.parking.leadEn} value={brand.leadEn ?? ""} onChange={(e) => setBrand({ leadEn: e.target.value || null })} description={t.parking.leadHint} />
                <Input label={t.parking.leadIt} value={brand.leadIt ?? ""} onChange={(e) => setBrand({ leadIt: e.target.value || null })} />
              </>
            )}
            <div className="grid items-start gap-4 sm:grid-cols-2">
              <Input label={t.parking.noneEn} placeholder={NO_SITE.en} value={page.noneEn ?? ""} onChange={(e) => setPage({ noneEn: e.target.value || null })} />
              <Input label={t.parking.noneIt} placeholder={NO_SITE.it} value={page.noneIt ?? ""} onChange={(e) => setPage({ noneIt: e.target.value || null })} />
            </div>
            <p className="-mt-2 text-sm text-kumo-subtle">{t.parking.noneHint}</p>
            <div className="flex flex-wrap items-center gap-3">
              <Button
                variant="primary"
                loading={busy}
                disabled={!info.canManage || s.pages.some((p) => p.brand && (!p.brand.name.trim() || badSite(p.brand)))}
                onClick={async () => {
                  if (await run("PUT", `/accounts/${acc}/park`, { ...s, assign: info.settings.assign }, t.parking.published)) onSaved();
                }}
              >
                {t.parking.publish}
              </Button>
              <span className="text-sm text-kumo-subtle">{info.publishedAt ? t.parking.publishedAt(f.ago(info.publishedAt), info.updatedBy ?? "") : t.parking.neverPublished}</span>
              {!info.canManage && <span className="text-sm text-kumo-subtle">{t.parking.onlyAdmins}</span>}
              {!info.canManage && <span className="text-sm text-kumo-subtle">{t.parking.onlyAdmins}</span>}
            </div>
          </div>
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-end gap-3">
              <Input label={t.parking.previewDomain} value={host} onChange={(e) => setHost(e.target.value)} className="w-56" />
              <Tabs
                tabs={[
                  { value: "en", label: "English" },
                  { value: "it", label: "Italiano" },
                ]}
                value={lang}
                onValueChange={(v) => setLang(v as Lang)}
              />
            </div>
            <div className="relative h-[420px] overflow-hidden rounded-lg border border-kumo-hairline bg-white">
              <iframe title={t.parking.preview} srcDoc={preview} sandbox="allow-scripts" className="pointer-events-none absolute top-0 left-0 h-[840px] w-[200%] origin-top-left scale-50 border-0" />
            </div>
          </div>
        </div>
      </LayerCard.Primary>
      <ConfirmDialog
        open={removing}
        onOpenChange={setRemoving}
        title={t.parking.deleteTitle(pageName(page))}
        description={t.parking.deleteDescription(using)}
        confirm={t.parking.deletePage}
        danger
        onConfirm={() => {
          setS({ ...s, pages: s.pages.filter((p) => p.id !== page.id) });
          setSel(s.defaultPage);
          setRemoving(false);
        }}
      />
    </LayerCard>
  );
}

const FILTERS = ["free", "parked", "all"] as const;
const isParked = (z: ZoneListItem) => z.cached?.usage === "parked" || z.cached?.usage === "parking-partial";

export function Parking({ acc }: { acc: string }) {
  const t = useT();
  const toast = useKumoToastManager();
  const { data, error, reload, syncing, syncAll } = useZones(acc);
  const { park, settings, pageOf, setPageOf, items: pageItems, busy: savingPage } = useParkPages(acc);
  const query = new URLSearchParams(useLocation().split("?")[1] ?? "");
  const initialPage = query.get("page");
  // The page editor opens from the button in the header, or from a link to one of its pages.
  const editing = query.has("pages") || !!initialPage;
  const { run, busy } = useMutation();
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>("free");
  const [q, setQ] = useState("");
  const [target, setTarget] = useState<ZoneListItem | null>(null);
  const [protectMail, setProtectMail] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulk, setBulk] = useState<"park" | "page" | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkPage, setBulkPage] = useState("");
  const all = useFilter(data?.zones, q);
  const zones = all.filter((z) => {
    const u = z.cached?.usage;
    if (filter === "parked") return u === "parked" || u === "parking-partial";
    if (filter === "free") return u === "empty" || u === "parking-partial";
    return true;
  });
  const picked = zones.filter((z) => selected.has(z.id));
  const toPark = picked.filter((z) => z.cached?.usage === "empty");
  const toRepage = picked.filter(isParked);
  const manyPages = !!settings && settings.pages.length > 1 && !!park.data?.canManage;
  const allSelected = zones.length > 0 && zones.every((z) => selected.has(z.id));
  const toggle = (id: string) => setSelected((s) => (s.has(id) ? new Set([...s].filter((x) => x !== id)) : new Set([...s, id])));

  // One domain at a time: the first one may also publish the parking page.
  async function parkSelected() {
    setBulkBusy(true);
    const failed: string[] = [];
    for (const z of toPark) {
      try {
        const res = await api<Mutation>("POST", `/zones/${z.id}/parking`, { enable: true, protectMail: protectMail && z.cached?.mail.mode !== "mail" });
        setCached(`/zones/${z.id}`, res.zone);
      } catch {
        failed.push(z.name);
      }
    }
    const ok = toPark.length - failed.length;
    if (ok) toast.add({ title: t.parking.doneSome(ok), variant: "success" });
    if (failed.length) toast.add({ title: t.failed, description: t.parking.notParked(failed.join(", ")), variant: "error" });
    setBulkBusy(false);
    setBulk(null);
    setSelected(new Set());
    reload();
    park.reload();
  }

  return (
    <>
      {editing ? (
        <PageHeader
          breadcrumbs={
            <Breadcrumbs size="sm">
              <Breadcrumbs.Link href={`/${acc}/parking`} icon={<SignpostIcon size={14} />}>
                {t.parking.title}
              </Breadcrumbs.Link>
              <Breadcrumbs.Separator />
              <Breadcrumbs.Current>{t.parking.pages}</Breadcrumbs.Current>
            </Breadcrumbs>
          }
          title={t.parking.pages}
          description={t.parking.pageDescription}
          actions={park.data?.status.published && <DeepLink href={dash.account(acc, "/workers/services/view/dash-plus-plus-park/production")} />}
        />
      ) : (
        <PageHeader
          title={t.parking.title}
          description={t.parking.description}
          actions={
            <>
              <SyncButton syncing={syncing} onClick={syncAll} />
              {park.error?.code !== "forbidden" && (
                <Button variant="secondary" icon={GearSixIcon} onClick={() => navigate(parkingPagesPath(acc))}>
                  {t.parking.pages}
                </Button>
              )}
            </>
          }
        />
      )}
      <Container className="flex flex-col gap-6 pt-6">
        {park.error?.code === "forbidden" && <Banner variant="secondary" icon={<InfoIcon weight="fill" />} description={t.parking.noAccess} />}
        {editing ? (
          park.data ? (
          <PageSettings
            key={initialPage ?? ""}
            acc={acc} info={park.data} onSaved={park.reload} sample={data?.zones.find((z) => z.cached?.usage === "parked")?.name ?? "example.com"}
            parked={(data?.zones ?? []).filter(isParked).map((z) => z.name)}
            initialPage={initialPage}
          />
          ) : park.error ? null : (
            <Loading />
          )
        ) : error && !data ? (
          <ErrorState error={error} onRetry={reload} />
        ) : !data ? (
          <Loading />
        ) : (
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-3">
              <Tabs tabs={FILTERS.map((v) => ({ value: v, label: t.parking.filters[v] }))} value={filter} onValueChange={(v) => setFilter(v as (typeof FILTERS)[number])} />
              <SearchBox value={q} onChange={setQ} />
              {picked.length > 0 && (
                <div className="flex items-center gap-3">
                  <span className="text-sm text-kumo-subtle">{t.domains.selected(picked.length)}</span>
                  {toPark.length > 0 && data.canPark && (
                    <Button
                      variant="secondary"
                      onClick={() => {
                        setProtectMail(true);
                        setBulk("park");
                      }}
                    >
                      {t.parking.parkSome(toPark.length)}
                    </Button>
                  )}
                  {manyPages && toRepage.length > 0 && (
                    <Button
                      variant="secondary"
                      onClick={() => {
                        setBulkPage(settings.defaultPage);
                        setBulk("page");
                      }}
                    >
                      {t.parking.changePage(toRepage.length)}
                    </Button>
                  )}
                </div>
              )}
            </div>
            <TableCard>
              <Table>
                <Table.Header>
                  <Table.Row>
                    <Table.CheckHead checked={allSelected} indeterminate={picked.length > 0 && !allSelected} onCheckedChange={() => setSelected(allSelected ? new Set() : new Set(zones.map((z) => z.id)))} aria-label={t.common.all} />
                    <Table.Head>{t.common.domain}</Table.Head>
                    <Table.Head>{t.domains.usage}</Table.Head>
                    {manyPages && <Table.Head>{t.parking.pageColumn}</Table.Head>}
                    <Table.Head className="w-48 text-right">
                      <span className="sr-only">{t.common.actions}</span>
                    </Table.Head>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {zones.map((z) => {
                    const parked = isParked(z);
                    return (
                      <Table.Row key={z.id} className="h-12">
                        <Table.CheckCell checked={selected.has(z.id)} onCheckedChange={() => toggle(z.id)} aria-label={z.name} />
                        <Table.Cell>
                          <a href={zonePath(acc, z.name, "parking")} className="font-medium underline decoration-kumo-line underline-offset-4">
                            {z.name}
                          </a>
                        </Table.Cell>
                        <Table.Cell>
                          <UsageBadge usage={z.cached?.usage} target={z.cached?.redirectTarget} />
                        </Table.Cell>
                        {manyPages && (
                          <Table.Cell>
                            {parked && (
                              <Select
                                size="sm"
                                aria-label={t.parking.pageColumn}
                                value={pageOf(z.name)}
                                onValueChange={(v) => setPageOf(z.name, String(v))}
                                items={pageItems}
                              />
                            )}
                          </Table.Cell>
                        )}
                        <Table.Cell className="text-right">
                          {z.cached?.usage === "empty" && data.canPark ? (
                            <Button
                              size="sm"
                              variant="secondary"
                              onClick={() => {
                                setProtectMail(z.cached?.mail.mode !== "mail");
                                setTarget(z);
                              }}
                            >
                              {t.parking.park}
                            </Button>
                          ) : z.cached?.usage === "parking-partial" ? (
                            <a href={zonePath(acc, z.name, "parking")}>
                              <Badge variant="warning">{t.parking.toComplete}</Badge>
                            </a>
                          ) : null}
                        </Table.Cell>
                      </Table.Row>
                    );
                  })}
                </Table.Body>
              </Table>
              {!zones.length && <EmptyState icon={<SignpostIcon size={32} className="text-kumo-inactive" />} title={filter === "free" ? t.parking.noneFree : t.domains.noneFound} description={filter === "free" ? t.parking.noneFreeHint : undefined} />}
            </TableCard>
          </div>
        )}
      </Container>

      <ConfirmDialog
        open={!!target}
        onOpenChange={(o) => !o && setTarget(null)}
        title={t.parking.parkTitle(target?.name ?? "")}
        description={target ? t.parking.parkDescription(target.name) : ""}
        confirm={t.parking.park}
        busy={busy}
        onConfirm={async () => {
          if (!target) return;
          if (await run(target.id, "POST", "/parking", { enable: true, protectMail }, t.parking.done(target.name))) {
            setTarget(null);
            reload();
            park.reload();
          }
        }}
      >
        <Checkbox checked={protectMail} disabled={target?.cached?.mail.mode === "mail"} onCheckedChange={(v) => setProtectMail(!!v)} label={target?.cached?.mail.mode === "mail" ? t.parking.protectMailNo : t.parking.protectMail} />
      </ConfirmDialog>

      <ConfirmDialog open={bulk === "park"} onOpenChange={(o) => !o && !bulkBusy && setBulk(null)} title={t.parking.parkSomeTitle(toPark.length)} description={t.parking.parkSomeDescription} confirm={t.parking.parkSomeTitle(toPark.length)} busy={bulkBusy} onConfirm={parkSelected}>
        <Checkbox checked={protectMail} onCheckedChange={(v) => setProtectMail(!!v)} label={t.parking.protectMailSome} />
      </ConfirmDialog>

      <ConfirmDialog
        open={bulk === "page"}
        onOpenChange={(o) => !o && setBulk(null)}
        title={t.parking.changePageTitle(toRepage.length)}
        confirm={t.common.save}
        busy={savingPage}
        onConfirm={async () => {
          if (await setPageOf(toRepage.map((z) => z.name), bulkPage)) {
            setBulk(null);
            setSelected(new Set());
          }
        }}
      >
        <Select label={t.parking.pageColumn} value={bulkPage} onValueChange={(v) => setBulkPage(String(v))} items={pageItems} />
      </ConfirmDialog>
    </>
  );
}
