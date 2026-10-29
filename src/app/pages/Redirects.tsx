import { Button, Select, Table } from "@cloudflare/kumo";
import { ArrowBendUpRightIcon, PlusIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Container, EmptyState, ErrorState, Loading, PageHeader, TableCard } from "../components/ui";
import { useT } from "../i18n";
import { useZones } from "../lib/hooks";
import { navigate, zonePath } from "../lib/router";
import { SearchBox, SyncButton, useFilter } from "./Domains";

export function Redirects({ acc }: { acc: string }) {
  const t = useT();
  const { data, error, reload, syncing, syncAll } = useZones(acc);
  const [q, setQ] = useState("");
  const [picking, setPicking] = useState(false);
  const [pick, setPick] = useState("");
  const all = useFilter(data?.zones, q);
  const zones = all.filter((z) => z.cached?.usage === "redirect" || (z.cached?.redirects ?? 0) > 0);
  const eligible = (data?.zones ?? []).filter((z) => z.cached?.usage === "empty" || z.cached?.usage === "site");

  return (
    <>
      <PageHeader
        title={t.redirects.title}
        description={t.redirects.description}
        actions={
          <>
            <SyncButton syncing={syncing} onClick={syncAll} />
            <Button variant="primary" icon={PlusIcon} onClick={() => setPicking(true)} disabled={!eligible.length}>
              {t.redirects.new}
            </Button>
          </>
        }
      />
      <Container className="pt-6">
        {error && !data ? (
          <ErrorState error={error} onRetry={reload} />
        ) : !data ? (
          <Loading />
        ) : (
          <div className="flex flex-col gap-4">
            <SearchBox value={q} onChange={setQ} />
            <TableCard>
              <Table>
                <Table.Header>
                  <Table.Row>
                    <Table.Head>{t.common.domain}</Table.Head>
                    <Table.Head>{t.redirects.target}</Table.Head>
                    <Table.Head>{t.redirects.rules}</Table.Head>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {zones.map((z) => (
                    <Table.Row key={z.id}>
                      <Table.Cell>
                        <a href={zonePath(acc, z.name, "redirects")} className="font-medium underline decoration-kumo-line underline-offset-4">
                          {z.name}
                        </a>
                      </Table.Cell>
                      <Table.Cell>{z.cached?.redirectTarget ?? <span className="text-kumo-subtle">{t.redirects.someAddresses}</span>}</Table.Cell>
                      <Table.Cell className="text-kumo-subtle tabular">{z.cached?.redirects}</Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table>
              {!zones.length && <EmptyState icon={<ArrowBendUpRightIcon size={32} className="text-kumo-inactive" />} title={t.redirects.noneAll} />}
            </TableCard>
          </div>
        )}
      </Container>

      <ConfirmDialog open={picking} onOpenChange={setPicking} title={t.redirects.new} description={t.redirects.pickDomain} confirm={t.redirects.continue} onConfirm={() => pick && navigate(zonePath(acc, pick, "redirects"))}>
        <Select label={t.common.domain} placeholder={t.redirects.pickPlaceholder} value={pick} onValueChange={(v) => setPick(String(v))} items={Object.fromEntries(eligible.map((z) => [z.name, z.name]))} />
      </ConfirmDialog>
    </>
  );
}
