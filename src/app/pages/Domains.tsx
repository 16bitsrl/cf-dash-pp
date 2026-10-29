import { Badge, Button, DropdownMenu, Input, Select, Table } from "@cloudflare/kumo";
import { ArrowClockwiseIcon, ArrowSquareOutIcon, DotsThreeIcon, FoldersIcon, GlobeIcon, MagnifyingGlassIcon } from "@phosphor-icons/react";
import { useMemo, useState } from "react";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Container, DashPill, EmptyState, ErrorState, Loading, MailBadge, PageHeader, TableCard, UsageBadge, ZoneStatus } from "../components/ui";
import { useT } from "../i18n";
import { useApi, type Group, type ZoneListItem } from "../lib/api";
import { dash, useFormat } from "../lib/format";
import { useAction, useZones } from "../lib/hooks";
import { zonePath } from "../lib/router";

export function SyncButton({ syncing, onClick }: { syncing: boolean; onClick: () => void }) {
  const t = useT();
  return (
    <Button variant="secondary" icon={ArrowClockwiseIcon} loading={syncing} onClick={onClick}>
      {t.common.refresh}
    </Button>
  );
}

export function useFilter(zones: ZoneListItem[] | undefined, q: string) {
  return useMemo(() => {
    const s = q.trim().toLowerCase();
    return (zones ?? []).filter((z) => !s || z.name.includes(s));
  }, [zones, q]);
}

export function SearchBox({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  const t = useT();
  return (
    <div className="relative flex-1">
      <MagnifyingGlassIcon size={16} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-kumo-subtle" />
      <Input aria-label={t.common.search} className="w-full pl-9" placeholder={placeholder ?? t.common.searchDomains} value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

export function Domains({ acc }: { acc: string }) {
  const t = useT();
  const f = useFormat();
  const { data, error, reload, syncing, syncAll } = useZones(acc);
  const groups = useApi<{ groups: Group[] }>(`/accounts/${acc}/groups`);
  const { run, busy } = useAction();
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [picking, setPicking] = useState(false);
  const [groupId, setGroupId] = useState("");
  const zones = useFilter(data?.zones, q);
  const groupsOf = (id: string) => (groups.data?.groups ?? []).filter((g) => g.zones.includes(id));
  const allSelected = zones.length > 0 && zones.every((z) => selected.has(z.id));
  const toggle = (id: string) => setSelected((s) => (s.has(id) ? new Set([...s].filter((x) => x !== id)) : new Set([...s, id])));

  async function addToGroup() {
    const g = groups.data?.groups.find((x) => x.id === groupId);
    if (!g) return;
    const res = await run("PUT", `/accounts/${acc}/groups/${g.id}`, { name: g.name, zones: [...new Set([...g.zones, ...selected])] }, t.groups.saved);
    if (res) {
      setPicking(false);
      setSelected(new Set());
      groups.reload();
    }
  }

  return (
    <>
      <PageHeader title={t.domains.title} pill={<DashPill href={dash.account(acc, "/domains/overview")} />} description={t.domains.description} actions={<SyncButton syncing={syncing} onClick={syncAll} />} />
      <Container className="pt-6">
        {error && !data ? (
          <ErrorState error={error} onRetry={reload} />
        ) : !data ? (
          <Loading />
        ) : (
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-3">
              <SearchBox value={q} onChange={setQ} />
              {selected.size > 0 && groups.data && (
                <div className="flex items-center gap-3">
                  <span className="text-sm text-kumo-subtle">{t.domains.selected(selected.size)}</span>
                  <Button variant="secondary" icon={FoldersIcon} onClick={() => setPicking(true)} disabled={!groups.data.groups.length}>
                    {t.domains.addToGroup}
                  </Button>
                </div>
              )}
            </div>
            <TableCard>
              <Table layout="auto">
                <Table.Header>
                  <Table.Row>
                    {groups.data && <Table.CheckHead checked={allSelected} indeterminate={selected.size > 0 && !allSelected} onCheckedChange={() => setSelected(allSelected ? new Set() : new Set(zones.map((z) => z.id)))} aria-label={t.common.all} />}
                    <Table.Head>{t.common.domain}</Table.Head>
                    <Table.Head>{t.domains.status}</Table.Head>
                    <Table.Head>{t.domains.usage}</Table.Head>
                    <Table.Head>{t.domains.mail}</Table.Head>
                    {groups.data && <Table.Head>{t.domains.groups}</Table.Head>}
                    <Table.Head>{t.domains.lastChange}</Table.Head>
                    <Table.Head className="w-10">
                      <span className="sr-only">{t.common.actions}</span>
                    </Table.Head>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {zones.map((z) => (
                    <Table.Row key={z.id}>
                      {groups.data && <Table.CheckCell checked={selected.has(z.id)} onCheckedChange={() => toggle(z.id)} aria-label={z.name} />}
                      <Table.Cell>
                        <a href={zonePath(acc, z.name)} className="font-medium text-kumo-default underline decoration-kumo-line underline-offset-4 hover:decoration-kumo-default">
                          {z.name}
                        </a>
                      </Table.Cell>
                      <Table.Cell>
                        <ZoneStatus status={z.status} paused={z.paused} />
                      </Table.Cell>
                      <Table.Cell>
                        <UsageBadge usage={z.cached?.usage} target={z.cached?.redirectTarget} />
                      </Table.Cell>
                      <Table.Cell>
                        <a href={zonePath(acc, z.name, "email")}>
                          <MailBadge mail={z.cached?.mail} />
                        </a>
                      </Table.Cell>
                      {groups.data && (
                        <Table.Cell>
                          <div className="flex flex-wrap gap-1">
                            {groupsOf(z.id).map((g) => (
                              <Badge key={g.id} variant="outline">
                                {g.name}
                              </Badge>
                            ))}
                          </div>
                        </Table.Cell>
                      )}
                      <Table.Cell className="whitespace-nowrap text-kumo-subtle">{f.ago(z.cached?.lastChangeAt)}</Table.Cell>
                      <Table.Cell>
                        <DropdownMenu>
                          <DropdownMenu.Trigger render={(p) => <Button {...p} variant="ghost" size="sm" shape="square" icon={DotsThreeIcon} aria-label={`${t.common.actions}: ${z.name}`} />} />
                          <DropdownMenu.Content align="end">
                            <DropdownMenu.LinkItem href={zonePath(acc, z.name)}>{t.domains.openHere}</DropdownMenu.LinkItem>
                            <DropdownMenu.LinkItem href={dash.zone(acc, z.name, "/dns/records")} target="_blank" icon={ArrowSquareOutIcon}>
                              {t.domains.dnsInCloudflare}
                            </DropdownMenu.LinkItem>
                          </DropdownMenu.Content>
                        </DropdownMenu>
                      </Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table>
              {!zones.length && <EmptyState icon={<GlobeIcon size={32} className="text-kumo-inactive" />} title={q ? t.domains.noneFound : t.domains.noneInAccount} />}
            </TableCard>
            {syncing && <p className="text-sm text-kumo-subtle">{t.common.syncing}</p>}
          </div>
        )}
      </Container>

      <ConfirmDialog open={picking} onOpenChange={setPicking} title={t.domains.addToGroup} description={t.domains.selected(selected.size)} confirm={t.common.save} busy={busy} onConfirm={addToGroup}>
        <Select label={t.groups.pick} placeholder={t.groups.pick} value={groupId} onValueChange={(v) => setGroupId(String(v))} items={Object.fromEntries((groups.data?.groups ?? []).map((g) => [g.id, g.name]))} />
      </ConfirmDialog>
    </>
  );
}
