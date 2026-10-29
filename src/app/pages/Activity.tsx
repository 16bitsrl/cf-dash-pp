import { Table, Tabs } from "@cloudflare/kumo";
import { useState } from "react";
import { ChangeList } from "../components/changes";
import { Container, EmptyState, ErrorState, Loading, PageHeader, TableCard } from "../components/ui";
import { doneText, useT } from "../i18n";
import { useApi, type Audit, type Change, type Done } from "../lib/api";
import { useFormat } from "../lib/format";
import { zonePath } from "../lib/router";

export function Activity({ acc }: { acc: string }) {
  const t = useT();
  const f = useFormat();
  const q = useApi<{ changes: Change[]; audit: Audit[] }>(`/accounts/${acc}/activity`);
  const [tab, setTab] = useState("changes");
  const details = (a: Audit) => {
    try {
      const done = JSON.parse(a.detail ?? "[]") as (Done | string)[];
      return done.map((d) => (typeof d === "string" ? d : doneText(t, d))).join(" · ") || t.activity.nothing;
    } catch {
      return "";
    }
  };
  return (
    <>
      <PageHeader title={t.activity.title} description={t.activity.description} />
      <Container className="pt-6">
        {q.error && !q.data ? (
          <ErrorState error={q.error} onRetry={q.reload} />
        ) : !q.data ? (
          <Loading />
        ) : (
          <div className="flex flex-col gap-4">
            <Tabs
              tabs={[
                { value: "changes", label: t.activity.changes },
                { value: "audit", label: t.activity.actions },
              ]}
              value={tab}
              onValueChange={(v) => setTab(String(v))}
            />
            {tab === "changes" ? (
              <ChangeList changes={q.data.changes} acc={acc} withZone />
            ) : (
              <TableCard>
                <Table>
                  <Table.Header>
                    <Table.Row>
                      <Table.Head>{t.history.when}</Table.Head>
                      <Table.Head>{t.common.domain}</Table.Head>
                      <Table.Head>{t.activity.action}</Table.Head>
                      <Table.Head>{t.activity.details}</Table.Head>
                      <Table.Head>{t.activity.who}</Table.Head>
                    </Table.Row>
                  </Table.Header>
                  <Table.Body>
                    {q.data.audit.map((a) => (
                      <Table.Row key={a.id}>
                        <Table.Cell className="whitespace-nowrap text-kumo-subtle" title={f.dateTime(a.at)}>
                          {f.ago(a.at)}
                        </Table.Cell>
                        <Table.Cell>
                          {a.zone_name ? (
                            <a className="font-medium underline decoration-kumo-line underline-offset-4" href={zonePath(acc, a.zone_name)}>
                              {a.zone_name}
                            </a>
                          ) : (
                            <span className="text-kumo-subtle">—</span>
                          )}
                        </Table.Cell>
                        <Table.Cell>{t.activity.names[a.action] ?? a.action}</Table.Cell>
                        <Table.Cell className="text-kumo-subtle">{details(a)}</Table.Cell>
                        <Table.Cell>{a.actor}</Table.Cell>
                      </Table.Row>
                    ))}
                  </Table.Body>
                </Table>
                {!q.data.audit.length && <EmptyState title={t.activity.none} description={t.activity.noneHint} />}
              </TableCard>
            )}
          </div>
        )}
      </Container>
    </>
  );
}
