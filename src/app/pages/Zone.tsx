import { Breadcrumbs, Button, LayerCard, Tabs } from "@cloudflare/kumo";
import { ArrowClockwiseIcon, CaretRightIcon, GlobeIcon } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { ChangeList } from "../components/changes";
import { DnsPanel } from "../components/dns";
import { MailPanel, ParkingPanel, RedirectsPanel } from "../components/panels";
import { Container, DashPill, SitePill, ErrorState, LevelIcon, Loading, MailBadge, PageHeader, UsageBadge, ZoneStatus } from "../components/ui";
import { checkText, useT } from "../i18n";
import { useApi, type ZoneDetail } from "../lib/api";
import { dash, shortName, useFormat } from "../lib/format";
import { useZones } from "../lib/hooks";
import { navigate, zonePath, type ZoneTab } from "../lib/router";

const TABS: ZoneTab[] = ["overview", "parking", "redirects", "email", "dns", "history"];

export function ZonePage({ acc, zoneName, tab }: { acc: string; zoneName: string; tab: string }) {
  const t = useT();
  const zones = useZones(acc);
  const item = zones.data?.zones.find((z) => z.name === zoneName);
  const q = useApi<ZoneDetail>(item ? `/zones/${item.id}` : null);
  const z = q.data;
  const active = (TABS.includes(tab as ZoneTab) ? tab : "overview") as ZoneTab;
  const labels: Record<ZoneTab, string> = { overview: t.zone.tabs.overview, parking: t.zone.tabs.parking, redirects: t.zone.tabs.redirects, email: t.zone.tabs.mail, dns: t.zone.tabs.dns, history: t.zone.tabs.history };

  return (
    <>
      <PageHeader
        breadcrumbs={
          <Breadcrumbs size="sm">
            <Breadcrumbs.Link href={`/${acc}/domains`} icon={<GlobeIcon size={14} />}>
              {t.nav.domains}
            </Breadcrumbs.Link>
            <Breadcrumbs.Separator />
            <Breadcrumbs.Current>{zoneName}</Breadcrumbs.Current>
          </Breadcrumbs>
        }
        title={zoneName}
        pill={
          <span className="flex flex-wrap items-center gap-1.5">
            <DashPill href={dash.zone(acc, zoneName)} />
            <SitePill host={zoneName} />
          </span>
        }
        description={item ? <ZoneStatus status={item.status} paused={item.paused} /> : undefined}
        actions={
          <Button variant="secondary" icon={ArrowClockwiseIcon} loading={q.loading} onClick={q.reload} disabled={!item}>
            {t.common.reload}
          </Button>
        }
      >
        <Tabs className="mt-6 -mb-px" variant="underline" tabs={TABS.map((v) => ({ value: v, label: labels[v] }))} value={active} onValueChange={(v) => navigate(zonePath(acc, zoneName, v as ZoneTab))} />
      </PageHeader>
      <Container className="pt-6">
        {zones.data && !item ? (
          <ErrorState error={new Error(t.zone.notInAccount)} />
        ) : q.error && !z ? (
          <ErrorState error={q.error} onRetry={q.reload} />
        ) : !z ? (
          <Loading label={t.zone.reading} />
        ) : (
          <>
            {active === "overview" && <Overview z={z} acc={acc} />}
            {active === "parking" && <ParkingPanel z={z} />}
            {active === "redirects" && <RedirectsPanel z={z} />}
            {active === "email" && <MailPanel z={z} />}
            {active === "dns" && <DnsPanel z={z} />}
            {active === "history" && <ChangeList changes={z.changes} acc={acc} />}
          </>
        )}
      </Container>
    </>
  );
}

function Row({ label, href, detail, children }: { label: string; href?: string; detail?: ReactNode; children: ReactNode }) {
  const body = (
    <>
      <span className="w-28 shrink-0 text-sm leading-6 text-kumo-subtle">{label}</span>
      <span className="flex min-h-6 min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1">
        {children}
        {detail && <span className="text-sm text-kumo-subtle">{detail}</span>}
      </span>
      {href && <CaretRightIcon size={14} className="mt-[5px] shrink-0 text-kumo-subtle" />}
    </>
  );
  const cls = "flex items-start gap-3 px-4 py-3";
  return <li>{href ? <a href={href} className={`${cls} hover:bg-kumo-tint`}>{body}</a> : <div className={cls}>{body}</div>}</li>;
}

const AREAS = ["mx", "spf", "dkim", "dmarc"] as const;
type Answer = { key: string; label: string; redirect?: ZoneDetail["redirects"][number]; worker?: string; record?: ZoneDetail["records"][number] };
const RANK = { error: 3, warning: 2, info: 1, ok: 0 } as const;

function Overview({ z, acc }: { z: ZoneDetail; acc: string }) {
  const t = useT();
  const f = useFormat();
  const name = z.zone.name;
  const allChecks = [z.mail, ...z.mail.subdomains].flatMap((m) => m.checks);
  const issues = allChecks.filter((c) => c.level === "error" || c.level === "warning");
  const redirect = z.redirects.find((r) => r.enabled && r.hosts.includes(name));
  // Where the domain and www point, for a domain that serves something of its own.
  // What answers on the domain and on www: a redirect first, then a Worker, then the records.
  const answers = z.usage === "site" || z.usage === "redirect" ? [name, `www.${name}`].flatMap((host): Answer[] => {
    const label = host === name ? "@" : "www";
    const r = z.redirects.find((x) => x.enabled && !x.path && x.hosts.includes(host));
    if (r) return [{ key: host, label, redirect: r }];
    const w = z.servedBy.find((x) => x.host === host);
    if (w) return [{ key: host, label, worker: w.worker }];
    return z.records.filter((x) => ["A", "AAAA", "CNAME"].includes(x.type) && x.name === host && !x.meta?.origin_worker_id).map((x) => ({ key: x.id, label, record: x }));
  }) : [];
  const shown = new Set(answers.flatMap((a) => (a.redirect ? [a.redirect.id] : [])));
  const otherRedirects = z.redirects.filter((x) => x.enabled && !shown.has(x.id)).length;
  const types = Object.entries(z.records.reduce<Record<string, number>>((m, r) => ((m[r.type] = (m[r.type] ?? 0) + 1), m), {})).sort((x, y) => y[1] - x[1]);
  const area = (a: (typeof AREAS)[number]) => allChecks.filter((c) => c.area === a).reduce<keyof typeof RANK>((w, c) => (RANK[c.level] > RANK[w] ? c.level : w), "ok");
  return (
    <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      <LayerCard>
        <LayerCard.Secondary>{t.zone.summary}</LayerCard.Secondary>
        <LayerCard.Primary className="p-0">
          <ul className="divide-y divide-kumo-hairline">
            <Row label={t.zone.usage} href={zonePath(acc, name, z.usage === "redirect" || otherRedirects ? "redirects" : z.usage === "site" ? "dns" : "parking")} detail={otherRedirects > 0 && t.zone.otherRedirects(otherRedirects)}>
              <span className="flex min-w-0 flex-col gap-1">
                <UsageBadge usage={z.usage} target={answers.length ? null : redirect?.target} />
                {answers.map((a) => (
                  <span key={a.key} className="flex min-w-0 items-center gap-2 text-[13px] text-kumo-subtle">
                    <span className="w-8 shrink-0">{a.label}</span>
                    {a.redirect ? (
                      <span className="truncate">
                        → {a.redirect.target.replace(/^https?:\/\//, "")} <span className="tabular">({a.redirect.status})</span>
                      </span>
                    ) : a.worker ? (
                      <span className="truncate">{t.usage.worker(a.worker)}</span>
                    ) : (
                      <>
                        <span className="truncate font-mono">
                          {a.record!.type} {a.record!.content}
                        </span>
                        {a.record!.proxied && <span className="shrink-0 text-xs text-[#f6821f]">{t.records.proxied}</span>}
                      </>
                    )}
                  </span>
                ))}
              </span>
            </Row>
            <Row label={t.zone.mail} href={zonePath(acc, name, "email")} detail={z.mail.total.errors + z.mail.total.warnings > 0 && z.mail.provider?.name}>
              <MailBadge mail={{ mode: z.mail.mode, provider: z.mail.provider?.name ?? null, errors: z.mail.total.errors, warnings: z.mail.total.warnings, checks: [] }} />
              {z.mail.mode !== "none" && (
                <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  {AREAS.map((a) => (
                    <span key={a} className="inline-flex items-center gap-1 text-xs text-kumo-subtle">
                      <LevelIcon level={area(a)} size={14} />
                      {a.toUpperCase()}
                    </span>
                  ))}
                </span>
              )}
            </Row>
            <Row label={t.zone.records} href={zonePath(acc, name, "dns")} detail={z.changes[0] && t.zone.lastChange(f.ago(z.changes[0].detected_at))}>
              <span className="text-sm font-medium tabular">{t.zone.recordCount(z.records.length)}</span>
              {types.length > 0 && <span className="text-xs text-kumo-subtle tabular">{types.map(([type, c]) => `${c} ${type}`).join(" · ")}</span>}
            </Row>
            <Row label={t.zone.nameservers} detail={z.zone.plan && t.zone.plan(z.zone.plan)}>
              <span className="flex flex-col font-mono text-[13px] xl:flex-row xl:gap-3">
                {z.zone.nameServers.map((n) => (
                  <span key={n}>{n}</span>
                ))}
              </span>
            </Row>
          </ul>
        </LayerCard.Primary>
      </LayerCard>

      <div className="flex flex-col gap-6">
        {issues.length > 0 && (
          <LayerCard>
            <LayerCard.Secondary>{t.zone.todo}</LayerCard.Secondary>
            <LayerCard.Primary>
              <ul className="flex flex-col gap-3">
                {issues.map((c, i) => (
                  <li key={i} className="flex items-start gap-3">
                    <LevelIcon level={c.level} />
                    <a href={zonePath(acc, name, "email")} className="text-sm hover:underline">
                      {c.name && <span className="font-mono text-xs text-kumo-subtle">{shortName(c.name, name)} · </span>}
                      {checkText(t, c).title}
                    </a>
                  </li>
                ))}
              </ul>
            </LayerCard.Primary>
          </LayerCard>
        )}
        <LayerCard>
          <LayerCard.Secondary>{t.zone.lastChanges}</LayerCard.Secondary>
          <LayerCard.Primary>
            {z.changes.length ? (
              <ul className="flex flex-col gap-1 text-sm">
                {z.changes.slice(0, 5).map((c) => (
                  <li key={c.id} className="flex justify-between gap-4">
                    <span className="truncate">
                      {t.history.kind[c.kind]} {c.record_type} {c.record_name}
                    </span>
                    <span className="shrink-0 text-kumo-subtle">{f.ago(c.detected_at)}</span>
                  </li>
                ))}
                {z.changes.length > 5 && (
                  <li>
                    <a className="text-kumo-link hover:underline" href={zonePath(acc, name, "history")}>
                      {t.zone.allChanges(z.changes.length)}
                    </a>
                  </li>
                )}
              </ul>
            ) : (
              <p className="text-sm text-kumo-subtle">{t.zone.noChanges}</p>
            )}
          </LayerCard.Primary>
        </LayerCard>
      </div>
    </div>
  );
}
