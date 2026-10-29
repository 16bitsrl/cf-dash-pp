import { Badge, Button, Checkbox, Input, LayerCard } from "@cloudflare/kumo";
import { FoldersIcon, PencilSimpleIcon, PlusIcon, TrashIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Container, DeepLink, EmptyState, ErrorState, Loading, PageHeader } from "../components/ui";
import { useT } from "../i18n";
import { useApi, type Group } from "../lib/api";
import { dash } from "../lib/format";
import { useAction, useZones } from "../lib/hooks";
import { zonePath } from "../lib/router";

type Draft = { id?: string; name: string; zones: Set<string> };

export function Groups({ acc }: { acc: string }) {
  const t = useT();
  const zones = useZones(acc);
  const q = useApi<{ groups: Group[] }>(`/accounts/${acc}/groups`);
  const { run, busy } = useAction();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [remove, setRemove] = useState<Group | null>(null);
  const [filter, setFilter] = useState("");
  const nameOf = new Map((zones.data?.zones ?? []).map((z) => [z.id, z.name]));
  const visible = (zones.data?.zones ?? []).filter((z) => !filter || z.name.includes(filter.toLowerCase()));

  async function save() {
    if (!draft) return;
    const body = { name: draft.name, zones: [...draft.zones] };
    const res = draft.id ? await run("PUT", `/accounts/${acc}/groups/${draft.id}`, body, t.groups.saved) : await run("POST", `/accounts/${acc}/groups`, body, t.groups.created);
    if (res) {
      setDraft(null);
      q.reload();
    }
  }

  return (
    <>
      <PageHeader
        title={t.groups.title}
        description={t.groups.description}
        actions={
          <>
            <DeepLink href={dash.account(acc, "/members")} label={t.groups.assign} />
            <Button variant="primary" icon={PlusIcon} onClick={() => setDraft({ name: "", zones: new Set() })}>
              {t.groups.new}
            </Button>
          </>
        }
      />
      <Container className="pt-6">
        {q.error && !q.data ? (
          <ErrorState error={q.error} onRetry={q.reload} />
        ) : !q.data || !zones.data ? (
          <Loading />
        ) : !q.data.groups.length ? (
          <EmptyState icon={<FoldersIcon size={32} className="text-kumo-inactive" />} title={t.groups.none} description={t.groups.noneHint} />
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {q.data.groups.map((g) => (
              <LayerCard key={g.id}>
                <LayerCard.Secondary className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-2">
                    {g.name}
                    <span className="text-kumo-subtle">· {t.groups.count(g.zones.length)}</span>
                  </span>
                  <span className="flex gap-1">
                    <Button variant="ghost" size="sm" shape="square" icon={PencilSimpleIcon} aria-label={t.common.edit} onClick={() => setDraft({ id: g.id, name: g.name, zones: new Set(g.zones) })} />
                    <Button variant="ghost" size="sm" shape="square" icon={TrashIcon} aria-label={t.common.delete} onClick={() => setRemove(g)} />
                  </span>
                </LayerCard.Secondary>
                <LayerCard.Primary>
                  <div className="flex flex-wrap gap-1.5">
                    {g.zones.map((id) => (
                      <a key={id} href={nameOf.has(id) ? zonePath(acc, nameOf.get(id)!) : undefined}>
                        <Badge variant="outline">{nameOf.get(id) ?? id.slice(0, 8)}</Badge>
                      </a>
                    ))}
                  </div>
                </LayerCard.Primary>
              </LayerCard>
            ))}
          </div>
        )}
      </Container>

      <ConfirmDialog
        open={!!draft}
        onOpenChange={(o) => !o && setDraft(null)}
        title={draft?.id ? t.groups.editTitle : t.groups.new}
        size="lg"
        confirm={t.common.save}
        busy={busy}
        onConfirm={save}
      >
        {draft && (
          <>
            <Input label={t.groups.name} placeholder={t.groups.namePlaceholder} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm font-medium">
                {t.groups.members} <span className="text-kumo-subtle">· {t.groups.count(draft.zones.size)}</span>
              </span>
              <Input size="sm" aria-label={t.groups.filter} placeholder={t.groups.filter} value={filter} onChange={(e) => setFilter(e.target.value)} className="w-56" />
            </div>
            <div className="grid max-h-80 grid-cols-1 gap-2 overflow-y-auto rounded-lg border border-kumo-hairline p-3 sm:grid-cols-2">
              {visible.map((z) => (
                <Checkbox
                  key={z.id}
                  checked={draft.zones.has(z.id)}
                  onCheckedChange={(v) => {
                    const next = new Set(draft.zones);
                    if (v) next.add(z.id);
                    else next.delete(z.id);
                    setDraft({ ...draft, zones: next });
                  }}
                  label={z.name}
                />
              ))}
            </div>
          </>
        )}
      </ConfirmDialog>

      <ConfirmDialog
        open={!!remove}
        onOpenChange={(o) => !o && setRemove(null)}
        title={remove ? t.groups.deleteTitle(remove.name) : ""}
        description={t.groups.deleteDescription}
        confirm={t.common.delete}
        danger
        busy={busy}
        onConfirm={async () => {
          if (remove && (await run("DELETE", `/accounts/${acc}/groups/${remove.id}?name=${encodeURIComponent(remove.name)}`, undefined, t.groups.deleted))) {
            setRemove(null);
            q.reload();
          }
        }}
      />
    </>
  );
}
