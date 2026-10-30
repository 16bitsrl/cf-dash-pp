import { Banner, LayerCard } from "@cloudflare/kumo";
import { BackgroundToken } from "../components/Background";
import { ArrowRightIcon, CheckCircleIcon, InfoIcon } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { Container, ErrorState, LevelIcon, Loading, PageHeader } from "../components/ui";
import { checkText, useT } from "../i18n";
import { useApi, type Change, type Me } from "../lib/api";
import { shortName, useFormat } from "../lib/format";
import { useAction, useZones } from "../lib/hooks";
import { zonePath, type ZoneTab } from "../lib/router";
import { SyncButton } from "./Domains";

function Stat({ label, value, href, hint }: { label: string; value: ReactNode; href: string; hint?: string }) {
  return (
    <a href={href} className="block bg-kumo-base px-4 py-3 hover:bg-kumo-tint sm:px-5 sm:py-4">
      <div className="text-sm text-kumo-subtle">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular sm:text-3xl">{value}</div>
      {hint && <div className="mt-0.5 text-xs text-kumo-subtle sm:text-sm">{hint}</div>}
    </a>
  );
}

function ListCard({ title, href, children }: { title: string; href: string; children: ReactNode }) {
  const t = useT();
  return (
    <LayerCard>
      <LayerCard.Secondary className="flex items-center justify-between">
        <span>{title}</span>
        <a href={href} aria-label={t.home.goTo(title)} className="text-kumo-subtle hover:text-kumo-default">
          <ArrowRightIcon size={16} />
        </a>
      </LayerCard.Secondary>
      <LayerCard.Primary className="p-0">{children}</LayerCard.Primary>
    </LayerCard>
  );
}

export function Home({ me, acc, onMeChange }: { me: Me; acc: string; onMeChange: () => void }) {
  const t = useT();
  const { run, busy } = useAction();
  const f = useFormat();
  const { data, error, reload, syncing, syncAll } = useZones(acc);
  const activity = useApi<{ changes: Change[] }>(`/accounts/${acc}/activity`);
  const account = me.accounts.find((a) => a.id === acc);
  const zones = data?.zones ?? [];
  const by = (u: string) => zones.filter((z) => z.cached?.usage === u).length;
  const mailIssues = zones.filter((z) => (z.cached?.mail.errors ?? 0) + (z.cached?.mail.warnings ?? 0) > 0);
  const todo: { zone: string; level: "error" | "warning"; title: string; tab: ZoneTab }[] = [
    ...zones.filter((z) => z.cached?.usage === "parking-partial").map((z) => ({ zone: z.name, level: "warning" as const, title: t.usage["parking-partial"], tab: "parking" as const })),
    ...mailIssues.flatMap((z) => z.cached!.mail.checks.slice(0, 1).map((c) => ({ zone: z.name, level: c.level as "error" | "warning", title: `${c.name ? `${shortName(c.name, z.name)} · ` : ""}${checkText(t, c).title}`, tab: "email" as const }))),
  ].sort((a, b) => (a.level === "error" ? -1 : 0) - (b.level === "error" ? -1 : 0));
  const recent = (activity.data?.changes ?? []).slice(0, 8);

  return (
    <>
      <PageHeader title={t.home.title} description={t.home.description(account?.name ?? "")} actions={<SyncButton syncing={syncing} onClick={syncAll} />} />
      <Container className="flex flex-col gap-6 pt-6">
        {account && !account.enabled ? (
          <Banner
            variant="alert"
            icon={<InfoIcon weight="fill" />}
            title={t.home.notEnabled}
            description={t.home.notEnabledHint}
            action={
              <Banner.Action disabled={busy} onClick={async () => (await run("POST", `/accounts/${acc}/tenant`, {}, t.home.enabled)) && onMeChange()}>
                {t.home.enable}
              </Banner.Action>
            }
          />
        ) : (
          account &&
          !account.syncToken &&
          !me.background.enabled && (
            <LayerCard>
              <LayerCard.Secondary>{t.home.noBackground}</LayerCard.Secondary>
              <LayerCard.Primary className="flex flex-col gap-4">
                <p className="text-sm text-kumo-subtle">{t.home.noBackgroundHint}</p>
                <BackgroundToken acc={acc} onSaved={onMeChange} />
              </LayerCard.Primary>
            </LayerCard>
          )
        )}
        {error && !data ? (
          <ErrorState error={error} onRetry={reload} />
        ) : !data ? (
          <Loading />
        ) : (
          <>
            <LayerCard className="overflow-hidden p-0">
              <div className="grid grid-cols-2 gap-px bg-kumo-hairline lg:grid-cols-4">
                <Stat label={t.home.domains} value={zones.length} href={`/${acc}/domains`} hint={t.home.withSite(by("site"))} />
                <Stat label={t.home.parked} value={by("parked")} href={`/${acc}/parking`} hint={t.home.empty(by("empty"))} />
                <Stat label={t.home.redirects} value={by("redirect")} href={`/${acc}/redirects`} hint={t.home.redirectsHint} />
                <Stat label={t.home.mail} value={mailIssues.length} href={`/${acc}/email`} hint={t.home.mailHint(mailIssues.length)} />
              </div>
            </LayerCard>
            <div className="grid gap-4 lg:grid-cols-2">
              <ListCard title={t.home.todo} href={`/${acc}/email`}>
                {todo.length ? (
                  <ul className="divide-y divide-kumo-hairline">
                    {todo.slice(0, 8).map((x, i) => (
                      <li key={i}>
                        <a href={zonePath(acc, x.zone, x.tab)} className="flex items-center gap-3 px-4 py-3 hover:bg-kumo-tint">
                          <LevelIcon level={x.level} />
                          <span className="min-w-0 flex-1">
                            <span className="block text-sm font-medium">{x.zone}</span>
                            <span className="block truncate text-sm text-kumo-subtle">{x.title}</span>
                          </span>
                        </a>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <div className="flex items-center gap-2 px-4 py-6 text-sm text-kumo-subtle">
                    <CheckCircleIcon size={18} weight="fill" className="text-kumo-success" /> {t.home.nothingTodo}
                  </div>
                )}
              </ListCard>
              <ListCard title={t.home.recent} href={`/${acc}/activity`}>
                {recent.length ? (
                  <ul className="divide-y divide-kumo-hairline">
                    {recent.map((c) => (
                      <li key={c.id}>
                        <a href={zonePath(acc, c.zone_name, "history")} className="flex items-center gap-3 px-4 py-3 hover:bg-kumo-tint">
                          <span className="min-w-0 flex-1">
                            <span className="block text-sm font-medium">{c.zone_name}</span>
                            <span className="block truncate text-sm text-kumo-subtle">
                              {t.history.kind[c.kind]} {c.record_type} {c.record_name} · {c.source === "dash" ? `Dash++, ${c.actor}` : t.history.outside}
                            </span>
                          </span>
                          <span className="shrink-0 text-sm text-kumo-subtle">{f.ago(c.detected_at)}</span>
                        </a>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <div className="px-4 py-6 text-sm text-kumo-subtle">{t.home.noRecent}</div>
                )}
              </ListCard>
            </div>
          </>
        )}
      </Container>
    </>
  );
}
