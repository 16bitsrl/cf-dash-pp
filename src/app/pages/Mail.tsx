import { Table, Tabs } from "@cloudflare/kumo";
import { EnvelopeSimpleIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { Container, EmptyState, ErrorState, LevelIcon, Loading, MailBadge, PageHeader, TableCard } from "../components/ui";
import { checkText, useT } from "../i18n";
import type { CachedZone } from "../lib/api";
import { shortName } from "../lib/format";
import { useZones } from "../lib/hooks";
import { zonePath } from "../lib/router";
import { SearchBox, SyncButton, useFilter } from "./Domains";

const score = (m: CachedZone["mail"] | undefined) => (m ? (m.errors ?? 0) * 100 + (m.warnings ?? 0) : -1);

export function Mail({ acc }: { acc: string }) {
  const t = useT();
  const { data, error, reload, syncing, syncAll } = useZones(acc);
  const [filter, setFilter] = useState("issues");
  const [q, setQ] = useState("");
  const all = useFilter(data?.zones, q);
  const zones = all
    .filter((z) => filter === "all" || (z.cached && ((z.cached.mail.errors ?? 0) > 0 || (z.cached.mail.warnings ?? 0) > 0)))
    .sort((a, b) => score(b.cached?.mail) - score(a.cached?.mail) || a.name.localeCompare(b.name));
  const count = all.filter((z) => (z.cached?.mail.errors ?? 0) + (z.cached?.mail.warnings ?? 0) > 0).length;

  return (
    <>
      <PageHeader title={t.mail.title} description={t.mail.description} actions={<SyncButton syncing={syncing} onClick={syncAll} />} />
      <Container className="pt-6">
        {error && !data ? (
          <ErrorState error={error} onRetry={reload} />
        ) : !data ? (
          <Loading />
        ) : (
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-3">
              <Tabs
                tabs={[
                  { value: "issues", label: t.mail.toFix(count) },
                  { value: "all", label: t.common.all },
                ]}
                value={filter}
                onValueChange={(v) => setFilter(String(v))}
              />
              <SearchBox value={q} onChange={setQ} />
            </div>
            <TableCard>
              <Table>
                <Table.Header>
                  <Table.Row>
                    <Table.Head>{t.common.domain}</Table.Head>
                    <Table.Head>{t.mail.state}</Table.Head>
                    <Table.Head>{t.mail.problems}</Table.Head>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {zones.map((z) => {
                    const checks = z.cached?.mail.checks ?? [];
                    return (
                      <Table.Row key={z.id}>
                        <Table.Cell>
                          <a href={zonePath(acc, z.name, "email")} className="font-medium underline decoration-kumo-line underline-offset-4">
                            {z.name}
                          </a>
                        </Table.Cell>
                        <Table.Cell>
                          <MailBadge mail={z.cached?.mail} />
                        </Table.Cell>
                        <Table.Cell>
                          <ul className="flex flex-col gap-1">
                            {checks.slice(0, 3).map((c, i) => (
                              <li key={i} className="flex items-center gap-2">
                                <LevelIcon level={c.level} size={16} />
                                <span>
                                  {c.name && <span className="font-mono text-xs text-kumo-subtle">{shortName(c.name, z.name)} · </span>}
                                  {checkText(t, c).title}
                                </span>
                              </li>
                            ))}
                            {checks.length > 3 && <li className="pl-6 text-kumo-subtle">{t.mail.more(checks.length - 3)}</li>}
                          </ul>
                        </Table.Cell>
                      </Table.Row>
                    );
                  })}
                </Table.Body>
              </Table>
              {!zones.length && <EmptyState icon={<EnvelopeSimpleIcon size={32} className="text-kumo-inactive" />} title={filter === "issues" ? t.mail.noProblems : t.domains.noneFound} />}
            </TableCard>
          </div>
        )}
      </Container>
    </>
  );
}
