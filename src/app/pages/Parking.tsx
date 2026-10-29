import { Badge, Banner, Button, Checkbox, Input, LayerCard, Select, Switch, Table, Tabs } from "@cloudflare/kumo";
import { InfoIcon, PlusIcon, SignpostIcon, TrashIcon, UploadSimpleIcon } from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import { NO_SITE, parkPage } from "../../worker/park/page";
import type { Asset, Brand, ParkPageDef, ParkSettings } from "../../worker/park/publish";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Container, DeepLink, EmptyState, ErrorState, Loading, PageHeader, TableCard, UsageBadge } from "../components/ui";
import { useLang, useT, type Lang } from "../i18n";
import type { ParkInfo, ZoneListItem } from "../lib/api";
import { dash, useFormat } from "../lib/format";
import { useAction, useMutation, useZones } from "../lib/hooks";
import { usePageName, useParkPages } from "../lib/park";
import { useLocation, zonePath } from "../lib/router";
import { SearchBox, SyncButton, useFilter } from "./Domains";

const NEW_BRAND: Brand = { name: "", site: null, accent: "#f6821f", leadEn: null, leadIt: null, logo: null, logoHeight: null, icon: null };

const readFile = (file: File) =>
  new Promise<Asset>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve({ type: file.type, data: String(r.result).split(",")[1] });
    r.onerror = reject;
    r.readAsDataURL(file);
  });

const dataUrl = (a: Asset | null) => (a ? `data:${a.type};base64,${a.data}` : null);

function ImageField({ label, value, onChange }: { label: string; value: Asset | null; onChange: (a: Asset | null) => void }) {
  const t = useT();
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-sm font-medium">{label}</span>
      <div className="flex items-center gap-3">
        <div className="flex h-12 w-28 items-center justify-center rounded-md border border-kumo-hairline bg-kumo-canvas p-1">{value && <img src={dataUrl(value)!} alt="" className="max-h-full max-w-full object-contain" />}</div>
        <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-kumo-line px-2.5 py-1 text-sm hover:bg-kumo-tint">
          <UploadSimpleIcon size={14} /> {t.parking.upload}
          <input type="file" accept="image/png,image/svg+xml,image/jpeg,image/webp" className="sr-only" onChange={async (e) => e.target.files?.[0] && onChange(await readFile(e.target.files[0]))} />
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

  function addPage() {
    const id = `p-${Math.random().toString(36).slice(2, 8)}`;
    setS({ ...s, pages: [...s.pages, { id, label: "", brand: NEW_BRAND, noneEn: null, noneIt: null }] });
    setSel(id);
  }

  return (
    <LayerCard>
      <LayerCard.Secondary className="flex items-center justify-between gap-2">
        <span>{t.parking.pages}</span>
        {info.status.published && <DeepLink href={dash.account(acc, "/workers/services/view/dash-plus-plus-park/production")} />}
      </LayerCard.Secondary>
      <LayerCard.Primary>
        <p className="mb-4 text-sm text-kumo-subtle">{t.parking.pageDescription}</p>
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
                <div className="grid gap-4 sm:grid-cols-2">
                  <Input label={t.parking.brandName} value={brand.name} onChange={(e) => setBrand({ name: e.target.value })} />
                  <Input label={t.parking.brandSite} placeholder="https://example.com" value={brand.site ?? ""} onChange={(e) => setBrand({ site: e.target.value || null })} />
                </div>
                <div className="flex flex-col gap-1.5">
                  <span className="text-sm font-medium">{t.parking.brandColor}</span>
                  <div className="flex items-center gap-2">
                    <input type="color" aria-label={t.parking.brandColor} value={brand.accent} onChange={(e) => setBrand({ accent: e.target.value })} className="h-9 w-12 cursor-pointer rounded-md border border-kumo-line bg-kumo-base" />
                    <Input aria-label={t.parking.brandColor} value={brand.accent} onChange={(e) => setBrand({ accent: e.target.value })} className="w-28 font-mono" />
                  </div>
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <ImageField label={t.parking.brandLogo} value={brand.logo} onChange={(logo) => setBrand({ logo })} />
                  <ImageField label={t.parking.brandIcon} value={brand.icon} onChange={(icon) => setBrand({ icon })} />
                </div>
                <Input label={t.parking.leadEn} value={brand.leadEn ?? ""} onChange={(e) => setBrand({ leadEn: e.target.value || null })} description={t.parking.leadHint} />
                <Input label={t.parking.leadIt} value={brand.leadIt ?? ""} onChange={(e) => setBrand({ leadIt: e.target.value || null })} />
              </>
            )}
            <div className="grid gap-4 sm:grid-cols-2">
              <Input label={t.parking.noneEn} placeholder={NO_SITE.en} value={page.noneEn ?? ""} onChange={(e) => setPage({ noneEn: e.target.value || null })} />
              <Input label={t.parking.noneIt} placeholder={NO_SITE.it} value={page.noneIt ?? ""} onChange={(e) => setPage({ noneIt: e.target.value || null })} />
            </div>
            <p className="-mt-2 text-sm text-kumo-subtle">{t.parking.noneHint}</p>
            <div className="flex flex-wrap items-center gap-3">
              <Button
                variant="primary"
                loading={busy}
                disabled={s.pages.some((p) => p.brand && !p.brand.name.trim())}
                onClick={async () => {
                  if (await run("PUT", `/accounts/${acc}/park`, { ...s, assign: info.settings.assign }, t.parking.published)) onSaved();
                }}
              >
                {t.parking.publish}
              </Button>
              <span className="text-sm text-kumo-subtle">{info.publishedAt ? t.parking.publishedAt(f.ago(info.publishedAt), info.updatedBy ?? "") : t.parking.neverPublished}</span>
            </div>
          </div>
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-end gap-3">
              <Input label={t.parking.previewDomain} value={host} onChange={(e) => setHost(e.target.value)} className="w-56" />
              <Tabs
                size="sm"
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

export function Parking({ acc }: { acc: string }) {
  const t = useT();
  const { data, error, reload, syncing, syncAll } = useZones(acc);
  const { park, settings, pageOf, setPageOf, items: pageItems } = useParkPages(acc);
  const initialPage = new URLSearchParams(useLocation().split("?")[1] ?? "").get("page");
  const { run, busy } = useMutation();
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>("free");
  const [q, setQ] = useState("");
  const [target, setTarget] = useState<ZoneListItem | null>(null);
  const [protectMail, setProtectMail] = useState(true);
  const all = useFilter(data?.zones, q);
  const zones = all.filter((z) => {
    const u = z.cached?.usage;
    if (filter === "parked") return u === "parked" || u === "parking-partial";
    if (filter === "free") return u === "empty" || u === "parking-partial";
    return true;
  });

  return (
    <>
      <PageHeader title={t.parking.title} description={t.parking.description} actions={<SyncButton syncing={syncing} onClick={syncAll} />} />
      <Container className="flex flex-col gap-6 pt-6">
        {park.error?.code === "forbidden" && <Banner variant="secondary" icon={<InfoIcon weight="fill" />} description={t.parking.noAccess} />}
        {park.data && (
          <PageSettings
            key={initialPage ?? ""}
            acc={acc} info={park.data} onSaved={park.reload} sample={data?.zones.find((z) => z.cached?.usage === "parked")?.name ?? "example.com"}
            parked={(data?.zones ?? []).filter((z) => z.cached?.usage === "parked" || z.cached?.usage === "parking-partial").map((z) => z.name)}
            initialPage={initialPage}
          />
        )}

        {error && !data ? (
          <ErrorState error={error} onRetry={reload} />
        ) : !data ? (
          <Loading />
        ) : (
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-3">
              <Tabs tabs={FILTERS.map((v) => ({ value: v, label: t.parking.filters[v] }))} value={filter} onValueChange={(v) => setFilter(v as (typeof FILTERS)[number])} />
              <SearchBox value={q} onChange={setQ} />
            </div>
            <TableCard>
              <Table>
                <Table.Header>
                  <Table.Row>
                    <Table.Head>{t.common.domain}</Table.Head>
                    <Table.Head>{t.domains.usage}</Table.Head>
                    {settings && settings.pages.length > 1 && <Table.Head>{t.parking.pageColumn}</Table.Head>}
                    <Table.Head className="w-48 text-right">
                      <span className="sr-only">{t.common.actions}</span>
                    </Table.Head>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {zones.map((z) => {
                    const parked = z.cached?.usage === "parked" || z.cached?.usage === "parking-partial";
                    return (
                      <Table.Row key={z.id}>
                        <Table.Cell>
                          <a href={zonePath(acc, z.name, "parking")} className="font-medium underline decoration-kumo-line underline-offset-4">
                            {z.name}
                          </a>
                        </Table.Cell>
                        <Table.Cell>
                          <UsageBadge usage={z.cached?.usage} target={z.cached?.redirectTarget} />
                        </Table.Cell>
                        {settings && settings.pages.length > 1 && (
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
                          {z.cached?.usage === "empty" && park.data ? (
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
    </>
  );
}
