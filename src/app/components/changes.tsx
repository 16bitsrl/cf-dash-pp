import { Badge, Table } from "@cloudflare/kumo";
import { ClockCounterClockwiseIcon } from "@phosphor-icons/react";
import type { Rec } from "../../worker/lib/zone-state";
import { useT } from "../i18n";
import type { Change } from "../lib/api";
import { shortName, useFormat } from "../lib/format";
import { zonePath } from "../lib/router";
import { EmptyState, TableCard } from "./ui";

const KIND = { added: "green", removed: "red", changed: "blue" } as const;

export function ChangeList({ changes, acc, withZone }: { changes: Change[]; acc: string; withZone?: boolean }) {
  const t = useT();
  const f = useFormat();
  const show = (r: Rec | null) => (r ? `${r.content}${r.priority !== undefined ? ` (${t.history.priority(r.priority)})` : ""}${r.proxied ? ` · ${t.history.proxied}` : ""}` : "");
  if (!changes.length)
    return (
      <TableCard>
        <EmptyState icon={<ClockCounterClockwiseIcon size={32} className="text-kumo-inactive" />} title={t.history.none} description={t.history.noneHint} />
      </TableCard>
    );
  return (
    <TableCard>
      <Table layout="auto">
        <Table.Header>
          <Table.Row>
            <Table.Head>{t.history.when}</Table.Head>
            {withZone && <Table.Head>{t.common.domain}</Table.Head>}
            <Table.Head>{t.history.change}</Table.Head>
            <Table.Head>{t.history.record}</Table.Head>
            <Table.Head>{t.history.value}</Table.Head>
            <Table.Head>{t.history.by}</Table.Head>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {changes.map((c) => {
            const before = c.before ? (JSON.parse(c.before) as Rec) : null;
            const after = c.after ? (JSON.parse(c.after) as Rec) : null;
            return (
              <Table.Row key={c.id}>
                <Table.Cell className="whitespace-nowrap text-kumo-subtle" title={f.dateTime(c.detected_at)}>
                  {f.ago(c.detected_at)}
                </Table.Cell>
                {withZone && (
                  <Table.Cell>
                    <a className="font-medium underline decoration-kumo-line underline-offset-4" href={zonePath(acc, c.zone_name, "history")}>
                      {c.zone_name}
                    </a>
                  </Table.Cell>
                )}
                <Table.Cell>
                  <Badge variant={KIND[c.kind]}>{t.history.kind[c.kind]}</Badge>
                </Table.Cell>
                <Table.Cell className="whitespace-nowrap">
                  <span className="font-mono text-xs text-kumo-subtle">{c.record_type}</span> {shortName(c.record_name, c.zone_name)}
                </Table.Cell>
                <Table.Cell className="max-w-[420px]">
                  {c.kind === "changed" ? (
                    <div className="flex flex-col gap-0.5">
                      <span className="truncate text-kumo-subtle line-through" title={show(before)}>
                        {show(before)}
                      </span>
                      <span className="truncate" title={show(after)}>
                        {show(after)}
                      </span>
                    </div>
                  ) : (
                    <span className={`block truncate ${c.kind === "removed" ? "text-kumo-subtle line-through" : ""}`} title={show(after ?? before)}>
                      {show(after ?? before)}
                    </span>
                  )}
                </Table.Cell>
                <Table.Cell className="whitespace-nowrap">{c.source === "dash" ? <span>Dash++ · {c.actor}</span> : <span className="text-kumo-subtle">{t.history.outside}</span>}</Table.Cell>
              </Table.Row>
            );
          })}
        </Table.Body>
      </Table>
    </TableCard>
  );
}
