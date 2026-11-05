import { Badge, Banner, Button, Checkbox, ClipboardText, DropdownMenu, Input, InputArea, LayerCard, Pagination, Select, Switch, Table, TagInput, Tooltip } from "@cloudflare/kumo";
import { ArrowSquareOutIcon, CaretDownIcon, CaretUpIcon, DotsThreeIcon, DownloadSimpleIcon, LockSimpleIcon, MagnifyingGlassIcon, PencilSimpleIcon, PlusIcon, TrashIcon, UploadSimpleIcon, WarningIcon } from "@phosphor-icons/react";
import { useMemo, useRef, useState, type ReactNode } from "react";
import { emptyInput, IMPORT_MAX_BYTES, inputFromRecord, parseZoneFile, previewImport, RECORD_TYPES, recordChanges, recordValue, relativeName, TTL_CHOICES, TYPE_SPECS, validateRecord, type Field, type FieldChange, type Invalid, type RecordInput } from "../../worker/lib/dns";
import { displayRecords, PARK_ADDRESS, type DisplayRecord, type Rec } from "../../worker/lib/zone-state";
import { errorText, useT } from "../i18n";
import type { Dict } from "../i18n/en";
import { useApi, type ZoneDetail } from "../lib/api";
import { dash } from "../lib/format";
import { useMutation } from "../lib/hooks";
import { ConfirmDialog } from "./ConfirmDialog";
import { EmptyState, TableCard } from "./ui";

type Mark = "worker" | "parking" | "dash";
const markOf = (r: DisplayRecord): Mark | null => (r.worker !== undefined ? "worker" : r.type === "A" && r.content === PARK_ADDRESS ? "parking" : r.comment === "Dash++" ? "dash" : null);
const editable = (r: DisplayRecord) => r.worker === undefined && !r.meta?.read_only;

type SortKey = "type" | "name" | "content" | "ttl";
const PER_PAGE = 50;

export function DnsPanel({ z }: { z: ZoneDetail }) {
  const t = useT();
  const zone = z.zone.name;
  const rows = useMemo(() => displayRecords(z.records, z.customDomains), [z.records, z.customDomains]);
  const [query, setQuery] = useState("");
  const [type, setType] = useState("all");
  const [proxy, setProxy] = useState("all");
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "type", dir: 1 });
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editor, setEditor] = useState<{ rec?: Rec } | null>(null);
  const [removing, setRemoving] = useState<Rec[] | null>(null);
  const [importing, setImporting] = useState(false);

  const types = [...new Set(rows.map((r) => r.type))].sort();
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = rows.filter(
      (r) =>
        (type === "all" || r.type === type) &&
        (proxy === "all" || (proxy === "proxied" ? !!r.proxied : TYPE_SPECS[r.type]?.proxiable && !r.proxied)) &&
        (!q || [r.type, r.name, recordValue(r), r.comment ?? "", ...(r.tags ?? []), r.worker ?? ""].some((v) => v.toLowerCase().includes(q))),
    );
    const val = (r: DisplayRecord): string | number => (sort.key === "ttl" ? (r.ttl ?? 1) : sort.key === "content" ? recordValue(r) : sort.key === "name" ? relativeName(zone, r.name) : r.type);
    return list.sort((a, b) => {
      const x = val(a);
      const y = val(b);
      return (typeof x === "number" ? x - (y as number) : x.localeCompare(y as string)) * sort.dir || a.name.localeCompare(b.name);
    });
  }, [rows, query, type, proxy, sort, zone]);
  const pages = Math.max(1, Math.ceil(shown.length / PER_PAGE));
  const current = Math.min(page, pages);
  const visible = shown.slice((current - 1) * PER_PAGE, current * PER_PAGE);
  const selectable = shown.filter(editable);
  const chosen = z.records.filter((r) => selected.has(r.id));
  const filtered = !!query || type !== "all" || proxy !== "all";

  const toggle = (id: string, on: boolean) => {
    const next = new Set(selected);
    if (on) next.add(id);
    else next.delete(id);
    setSelected(next);
  };
  const allOn = selectable.length > 0 && selectable.every((r) => selected.has(r.id));
  const someOn = selectable.some((r) => selected.has(r.id));
  const sortBy = (key: SortKey) => setSort((s) => ({ key, dir: s.key === key ? (-s.dir as 1 | -1) : 1 }));
  const reset = (f: () => void) => {
    f();
    setPage(1);
  };
  const exportUrl = `/api/zones/${z.zone.id}/records/export`;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="relative min-w-0 flex-1">
            <MagnifyingGlassIcon size={16} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-kumo-subtle" />
            <Input className="w-full pl-9" aria-label={t.common.search} placeholder={t.dns.search} value={query} onChange={(e) => reset(() => setQuery(e.target.value))} />
          </div>
          <div className="grid min-w-0 grid-cols-2 gap-2 sm:flex">
            <Select className="w-full min-w-0 sm:w-36" aria-label={t.dns.typeFilter} value={type} onValueChange={(v) => reset(() => setType(String(v)))} items={{ all: t.dns.allTypes, ...Object.fromEntries(types.map((x) => [x, x])) }} />
            <Select className="w-full min-w-0 sm:w-52" aria-label={t.records.proxy} value={proxy} onValueChange={(v) => reset(() => setProxy(String(v)))} items={t.dns.proxyFilter} />
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          {chosen.length ? (
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">{t.dns.selected(chosen.length)}</span>
              <Button size="sm" variant="destructive" icon={TrashIcon} onClick={() => setRemoving(chosen)}>
                {t.dns.deleteSelected}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
                {t.dns.clearSelection}
              </Button>
            </div>
          ) : (
            <span className="text-sm text-kumo-subtle tabular">{t.dns.count(shown.length, rows.length)}</span>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <DropdownMenu>
              <DropdownMenu.Trigger render={<Button variant="secondary" icon={DotsThreeIcon}>{t.dns.more}</Button>} />
              <DropdownMenu.Content sideOffset={6} align="end">
                <DropdownMenu.Item icon={UploadSimpleIcon} onClick={() => setImporting(true)}>
                  {t.dns.import}
                </DropdownMenu.Item>
                <DropdownMenu.Item icon={DownloadSimpleIcon} onClick={() => (window.location.href = exportUrl)}>
                  {t.dns.export}
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu>
            <Button variant="primary" icon={PlusIcon} onClick={() => setEditor({})}>
              {t.dns.add}
            </Button>
          </div>
        </div>
      </div>

      {!rows.length ? (
        <EmptyState title={t.dns.none} description={t.dns.noneHint} />
      ) : !shown.length ? (
        <div className="flex flex-col items-center gap-3">
          <EmptyState title={t.dns.noMatch} description={t.dns.noMatchHint} />
          <Button variant="secondary" size="sm" onClick={() => reset(() => (setQuery(""), setType("all"), setProxy("all")))}>
            {t.dns.clearFilters}
          </Button>
        </div>
      ) : (
        <>
          {/* Wide screens: the dashboard's table. */}
          <div className="hidden md:block">
            <TableCard>
              <Table layout="auto">
                <Table.Header>
                  <Table.Row>
                    <Table.Head className="w-10">
                      <Checkbox aria-label={t.dns.selectAll} checked={allOn} indeterminate={someOn && !allOn} disabled={!selectable.length} onCheckedChange={(v) => setSelected(v ? new Set(selectable.map((r) => r.id)) : new Set())} />
                    </Table.Head>
                    <SortHead label={t.records.type} k="type" sort={sort} onSort={sortBy} />
                    <SortHead label={t.records.name} k="name" sort={sort} onSort={sortBy} />
                    <SortHead label={t.records.content} k="content" sort={sort} onSort={sortBy} />
                    <Table.Head>{t.records.proxy}</Table.Head>
                    <SortHead label={t.records.ttl} k="ttl" sort={sort} onSort={sortBy} />
                    <Table.Head className="w-24">
                      <span className="sr-only">{t.common.actions}</span>
                    </Table.Head>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {visible.map((r) => (
                    <Table.Row key={r.key} variant={selected.has(r.id) && editable(r) ? "selected" : "default"}>
                      <Table.Cell>{editable(r) && <Checkbox aria-label={t.dns.select(r.name)} checked={selected.has(r.id)} onCheckedChange={(v) => toggle(r.id, !!v)} />}</Table.Cell>
                      <Table.Cell className="font-mono text-xs">{r.type}</Table.Cell>
                      <Table.Cell className="max-w-[220px] break-all">
                        <RecordName zone={zone} r={r} />
                      </Table.Cell>
                      <Table.Cell className="max-w-[440px]">
                        <RecordContent r={r} acc={z.zone.account.id} />
                      </Table.Cell>
                      <Table.Cell className="whitespace-nowrap">
                        <ProxyStatus r={r} />
                      </Table.Cell>
                      <Table.Cell className="whitespace-nowrap text-kumo-subtle">{ttlText(t, r.ttl ?? 1)}</Table.Cell>
                      <Table.Cell>
                        <RowActions r={r} onEdit={() => setEditor({ rec: r })} onDelete={() => setRemoving([r])} />
                      </Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table>
            </TableCard>
          </div>

          {/* Phones: one card per record. */}
          <div className="flex flex-col gap-2 md:hidden">
            {selectable.length > 0 && (
              <div className="px-1">
                <Checkbox label={t.dns.selectAll} checked={allOn} indeterminate={someOn && !allOn} onCheckedChange={(v) => setSelected(v ? new Set(selectable.map((r) => r.id)) : new Set())} />
              </div>
            )}
            {visible.map((r) => (
              <div key={r.key} className={`rounded-lg border bg-kumo-base p-3 ${selected.has(r.id) && editable(r) ? "border-kumo-brand" : "border-kumo-hairline"}`}>
                <div className="flex items-start gap-3">
                  {editable(r) && (
                    <div className="pt-0.5">
                      <Checkbox aria-label={t.dns.select(r.name)} checked={selected.has(r.id)} onCheckedChange={(v) => toggle(r.id, !!v)} />
                    </div>
                  )}
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <div className="flex items-baseline gap-2">
                      <span className="shrink-0 font-mono text-xs text-kumo-subtle">{r.type}</span>
                      <span className="min-w-0 font-medium break-all">
                        <RecordName zone={zone} r={r} />
                      </span>
                    </div>
                    <RecordContent r={r} acc={z.zone.account.id} />
                    <div className="flex flex-wrap items-center gap-x-3 text-xs text-kumo-subtle">
                      <ProxyStatus r={r} />
                      <span>TTL {ttlText(t, r.ttl ?? 1)}</span>
                    </div>
                  </div>
                  <RowActions r={r} onEdit={() => setEditor({ rec: r })} onDelete={() => setRemoving([r])} />
                </div>
              </div>
            ))}
          </div>

          {shown.length > PER_PAGE && <Pagination page={current} setPage={setPage} perPage={PER_PAGE} totalCount={shown.length} />}
        </>
      )}

      <DnsSettingsPanel z={z} />

      {editor && <RecordDialog z={z} rec={editor.rec} onClose={() => setEditor(null)} />}
      {removing && (
        <DeleteDialog
          z={z}
          records={removing}
          onClose={(done) => {
            if (done) setSelected(new Set());
            setRemoving(null);
          }}
        />
      )}
      {importing && <ImportDialog z={z} onClose={() => setImporting(false)} />}
    </div>
  );
}

function SortHead({ label, k, sort, onSort }: { label: string; k: SortKey; sort: { key: SortKey; dir: 1 | -1 }; onSort: (k: SortKey) => void }) {
  const t = useT();
  const Icon = sort.key === k ? (sort.dir === 1 ? CaretUpIcon : CaretDownIcon) : null;
  return (
    <Table.Head aria-sort={sort.key === k ? (sort.dir === 1 ? "ascending" : "descending") : undefined}>
      <button type="button" className="inline-flex items-center gap-1 hover:text-kumo-default" onClick={() => onSort(k)} aria-label={t.dns.sortBy(label)}>
        {label}
        {Icon && <Icon size={12} />}
      </button>
    </Table.Head>
  );
}

const ttlText = (t: Dict, s: number) => (s === 1 || (s % 60 === 0 && TTL_CHOICES.includes(s)) ? t.dns.ttl(s) : t.dns.ttlSeconds(s));

function ProxyStatus({ r }: { r: Rec }) {
  const t = useT();
  if (!TYPE_SPECS[r.type]?.proxiable) return null;
  return r.proxied ? (
    <Tooltip content={t.records.proxiedHint}>
      <span className="cursor-help text-[#f6821f]">{t.records.proxied}</span>
    </Tooltip>
  ) : (
    <span className="text-kumo-subtle">{t.records.dnsOnly}</span>
  );
}

/** The record's name; for addresses people visit (A, AAAA, CNAME, not wildcards) a link that opens it in a new tab. */
function RecordName({ zone, r }: { zone: string; r: DisplayRecord }) {
  const t = useT();
  const label = relativeName(zone, r.name);
  if (!["A", "AAAA", "CNAME"].includes(r.type) || r.name.includes("*")) return <>{label}</>;
  return (
    <a href={`https://${r.name}`} target="_blank" rel="noreferrer" title={t.common.openAddress(r.name)} className="group inline-flex items-baseline gap-1 hover:text-kumo-link hover:underline">
      {label}
      <ArrowSquareOutIcon size={12} className="shrink-0 translate-y-px text-kumo-subtle opacity-60 group-hover:opacity-100" />
    </a>
  );
}

function RecordContent({ r, acc }: { r: DisplayRecord; acc: string }) {
  const t = useT();
  const mark = markOf(r);
  if (r.worker !== undefined)
    return (
      <Tooltip content={t.records.workerHint(r.worker || t.records.someWorker)}>
        <span className="flex items-center gap-2">
          <Badge variant="outline">{t.dns.marks.worker}</Badge>
          <a className="font-medium text-kumo-link hover:underline" href={dash.account(acc, r.worker ? `/workers/services/view/${r.worker}/production` : "/workers-and-pages")} target="_blank" rel="noreferrer">
            {r.worker || t.records.someWorker}
          </a>
        </span>
      </Tooltip>
    );
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex min-w-0 items-start gap-2">
        <span className="min-w-0 font-mono text-[13px] break-all">{recordValue(r)}</span>
        {mark && (
          <Tooltip content={t.dns.markHints[mark as "parking" | "dash"]}>
            <span className="shrink-0">
              <Badge variant={mark === "parking" ? "purple" : "outline"}>{t.dns.marks[mark]}</Badge>
            </span>
          </Tooltip>
        )}
      </div>
      {(r.comment && r.comment !== "Dash++") || r.tags?.length ? (
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-kumo-subtle">
          {r.comment && r.comment !== "Dash++" && <span className="break-words">{r.comment}</span>}
          {r.tags?.map((tag) => (
            <Badge key={tag} variant="neutral">
              {tag}
            </Badge>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function RowActions({ r, onEdit, onDelete }: { r: DisplayRecord; onEdit: () => void; onDelete: () => void }) {
  const t = useT();
  if (!editable(r))
    return (
      <div className="flex justify-end">
        <Tooltip content={t.dns.readOnly}>
          <span className="inline-flex size-9 items-center justify-center text-kumo-subtle" aria-label={t.dns.readOnly}>
            <LockSimpleIcon size={16} />
          </span>
        </Tooltip>
      </div>
    );
  return (
    <div className="flex shrink-0 justify-end gap-1">
      <Button variant="ghost" shape="square" icon={PencilSimpleIcon} aria-label={t.dns.edit} onClick={onEdit} />
      <Button variant="ghost" shape="square" icon={TrashIcon} aria-label={t.dns.remove} onClick={onDelete} />
    </div>
  );
}

// --- Add and edit ---

/** Which part of the form an error belongs to. */
function errorField(e: Invalid) {
  if (e.code === "record-field-invalid") return String(e.params.field);
  if (["record-name-invalid", "record-srv-name"].includes(e.code)) return "name";
  if (["record-content-required", "record-ipv4-invalid", "record-ipv6-invalid", "record-hostname-invalid", "record-cname-self", "record-base64-invalid", "record-text-too-long"].includes(e.code)) return "content";
  if (e.code === "record-priority-invalid") return "priority";
  if (e.code === "record-comment-invalid") return "comment";
  if (e.code.startsWith("record-tag")) return "tags";
  return null;
}

function RecordDialog({ z, rec, onClose }: { z: ZoneDetail; rec?: Rec; onClose: () => void }) {
  const t = useT();
  const zone = z.zone.name;
  const { run, busy } = useMutation();
  const [form, setForm] = useState<RecordInput>(() => (rec ? inputFromRecord(zone, rec) : { ...emptyInput("A"), proxied: true }));
  const [error, setError] = useState<Invalid | null>(null);
  const [review, setReview] = useState<FieldChange[] | null>(null);
  const [unchanged, setUnchanged] = useState(false);
  const spec = TYPE_SPECS[form.type] ?? {};
  const set = (patch: Partial<RecordInput>) => {
    setForm({ ...form, ...patch });
    setError(null);
    setUnchanged(false);
  };
  const setType = (type: string) => {
    const fresh = emptyInput(type);
    set({ type, content: "", data: {}, priority: fresh.priority, proxied: !!TYPE_SPECS[type]?.proxiable, settings: {} });
  };

  // Records already on the same name: another one of the same type, or a CNAME that can't share it.
  const name = validateRecord(zone, { ...form, content: "x", data: {} });
  const fullName = "body" in name ? name.body.name : null;
  const others = fullName ? z.records.filter((r) => r.name.toLowerCase() === fullName && r.id !== rec?.id) : [];
  const clash = form.type === "CNAME" ? others.length > 0 : others.some((r) => r.type === "CNAME");
  const sameType = !rec && others.some((r) => r.type === form.type);

  const submit = async () => {
    const v = validateRecord(zone, form);
    if ("error" in v) return setError(v.error);
    if (!rec) {
      if (await run(z.zone.id, "POST", "/records", { record: form }, t.dns.added)) onClose();
      return;
    }
    if (!review) {
      const changes = recordChanges(rec, v.body);
      if (!changes.length) return setUnchanged(true);
      return setReview(changes);
    }
    if (await run(z.zone.id, "PATCH", `/records/${rec.id}`, { record: form, modifiedOn: rec.modified_on }, t.dns.updated)) onClose();
  };

  const errField = error && errorField(error);
  const errText = error ? errorText(t, error.code, error.params) : undefined;
  const fieldError = (key: string) => (errField === key ? errText : undefined);

  return (
    <ConfirmDialog
      open
      onOpenChange={(o) => !o && onClose()}
      size="lg"
      title={rec ? t.dns.editTitle(relativeName(zone, rec.name)) : t.dns.addTitle}
      confirm={!rec ? t.dns.create : review ? t.dns.save : t.dns.review}
      busy={busy}
      back={review ? { label: t.dns.back, onClick: () => setReview(null) } : undefined}
      onConfirm={submit}
    >
      {review ? (
        <ChangeReview type={form.type} changes={review} />
      ) : (
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <div className="grid grid-cols-1 items-start gap-4 sm:grid-cols-[9rem_minmax(0,1fr)]">
            <Select label={t.records.type} value={form.type} disabled={!!rec} onValueChange={(v) => setType(String(v))} items={Object.fromEntries(RECORD_TYPES.map((x) => [x, x]))} />
            <Input label={t.records.name} description={t.dns.nameHint(zone)} error={fieldError("name")} value={form.name} placeholder="@" autoCapitalize="none" autoCorrect="off" spellCheck={false} onChange={(e) => set({ name: e.target.value })} />
          </div>

          {spec.priority && <Input label={t.dns.fields.priority} inputMode="numeric" error={fieldError("priority")} value={String(form.priority ?? "")} onChange={(e) => set({ priority: e.target.value })} />}

          {spec.content &&
            (spec.content === "text" || spec.content === "base64" ? (
              <InputArea
                label={t.dns.contentByType[form.type] ?? t.dns.content[spec.content]}
                error={fieldError("content")}
                value={form.content}
                placeholder={t.dns.placeholders[form.type]}
                autoResize
                minRows={2}
                maxRows={8}
                spellCheck={false}
                onValueChange={(v) => set({ content: v })}
              />
            ) : (
              <Input
                label={t.dns.contentByType[form.type] ?? t.dns.content[spec.content]}
                error={fieldError("content")}
                value={form.content}
                placeholder={t.dns.placeholders[form.type]}
                inputMode={spec.content === "ipv4" ? "decimal" : "text"}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                onChange={(e) => set({ content: e.target.value })}
              />
            ))}

          {spec.data && (
            <div className="grid grid-cols-1 items-start gap-4 sm:grid-cols-2">
              {spec.data.map((f) => (
                <DataField key={f.key} f={f} value={String(form.data[f.key] ?? "")} error={fieldError(f.key)} onChange={(v) => set({ data: { ...form.data, [f.key]: v } })} />
              ))}
            </div>
          )}

          {spec.proxiable && (
            <div className="flex flex-col gap-1">
              <Switch label={t.dns.proxyLabel} checked={form.proxied} onCheckedChange={(v) => set({ proxied: !!v, ...(v && { ttl: 1 }) })} />
              <p className="text-sm text-kumo-subtle">{form.proxied ? t.dns.proxyOn : t.dns.proxyOff}</p>
            </div>
          )}

          <Select
            label={t.records.ttl}
            value={String(form.proxied ? 1 : form.ttl)}
            disabled={form.proxied}
            onValueChange={(v) => set({ ttl: Number(v) })}
            items={Object.fromEntries([...new Set([...TTL_CHOICES, form.ttl])].sort((a, b) => a - b).map((s) => [String(s), ttlText(t, s)]))}
          />
          {form.proxied && <p className="-mt-3 text-sm text-kumo-subtle">{t.dns.ttlProxied}</p>}

          <RecordSettings zone={zone} form={form} set={set} />

          <Input label={<Optional label={t.dns.fields.comment} />} description={t.dns.commentHint} error={fieldError("comment")} value={form.comment} onChange={(e) => set({ comment: e.target.value })} />
          <TagInput label={<Optional label={t.dns.fields.tags} />} description={t.dns.tagsHint} error={fieldError("tags")} placeholder={t.dns.tagsPlaceholder} value={form.tags} onValueChange={(v: string[]) => set({ tags: v })} />

          {sameType && fullName && !clash && <Banner variant="secondary" description={t.dns.sameName(form.type, relativeName(zone, fullName))} />}
          {clash && fullName && <Banner variant="alert" icon={<WarningIcon weight="fill" />} description={t.dns.cnameClash(relativeName(zone, fullName))} />}
          {error && !errField && <Banner variant="error" icon={<WarningIcon weight="fill" />} description={errText} />}
          {unchanged && <Banner variant="secondary" description={t.dns.noChanges} />}
          <button type="submit" hidden />
        </form>
      )}
    </ConfirmDialog>
  );
}

function Optional({ label }: { label: string }) {
  const t = useT();
  return (
    <>
      {label} <span className="font-normal text-kumo-subtle">{t.common.optional}</span>
    </>
  );
}

function DataField({ f, value, error, onChange }: { f: Field; value: string; error?: string; onChange: (v: string) => void }) {
  const t = useT();
  const label = t.dns.fields[f.key] ?? f.key;
  const cls = f.wide ? "sm:col-span-2" : "";
  if (f.kind === "choice")
    return (
      <div className={cls}>
        <Select className="w-full" label={label} value={value} placeholder="—" onValueChange={(v) => onChange(String(v))} items={Object.fromEntries(f.options!.map((o) => [o, t.dns.choices[o] ? `${t.dns.choices[o]} (${o})` : o]))} />
        {error && <p className="mt-1 text-sm text-kumo-danger">{error}</p>}
      </div>
    );
  return (
    <div className={cls}>
      <Input
        label={f.optional ? <Optional label={label} /> : label}
        error={error}
        value={value}
        inputMode={f.kind === "int" ? "numeric" : f.kind === "decimal" ? "decimal" : "text"}
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

function RecordSettings({ zone, form, set }: { zone: string; form: RecordInput; set: (p: Partial<RecordInput>) => void }) {
  const t = useT();
  const apex = ["", "@", zone].includes(form.name.trim().toLowerCase().replace(/\.$/, ""));
  const items: ReactNode[] = [];
  if (form.type === "CNAME" && !form.proxied && !apex)
    items.push(<Checkbox key="f" label={t.dns.fields.flatten_cname} labelTooltip={t.dns.flattenHint} checked={!!form.settings.flatten_cname} onCheckedChange={(v) => set({ settings: { ...form.settings, flatten_cname: !!v } })} />);
  if ((form.type === "A" || form.type === "AAAA") && form.proxied) {
    items.push(<Checkbox key="4" label={t.dns.fields.ipv4_only} labelTooltip={t.dns.ipv4OnlyHint} checked={!!form.settings.ipv4_only} onCheckedChange={(v) => set({ settings: { ...form.settings, ipv4_only: !!v, ...(v && { ipv6_only: false }) } })} />);
    items.push(<Checkbox key="6" label={t.dns.fields.ipv6_only} labelTooltip={t.dns.ipv6OnlyHint} checked={!!form.settings.ipv6_only} onCheckedChange={(v) => set({ settings: { ...form.settings, ipv6_only: !!v, ...(v && { ipv4_only: false }) } })} />);
  }
  if (!items.length) return null;
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-2 text-sm font-medium">{t.dns.settings}</legend>
      {items}
    </fieldset>
  );
}

/** A value in the review, readable: Auto, Proxied, On... */
function useShowValue() {
  const t = useT();
  return (field: string, v: string) => {
    if (v === "") return <span className="text-kumo-subtle italic">{t.dns.empty}</span>;
    if (field === "ttl") return ttlText(t, Number(v));
    if (field === "proxied") return v === "true" ? t.records.proxied : t.records.dnsOnly;
    if (["flatten_cname", "ipv4_only", "ipv6_only"].includes(field)) return v === "true" ? t.dns.on : t.dns.off;
    return <span className="font-mono text-[13px] break-all">{t.dns.choices[v] && field !== "content" ? `${t.dns.choices[v]} (${v})` : v}</span>;
  };
}

function ChangeReview({ type, changes }: { type: string; changes: FieldChange[] }) {
  const t = useT();
  const show = useShowValue();
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-kumo-subtle">{t.dns.reviewHint}</p>
      <ul className="flex flex-col divide-y divide-kumo-hairline rounded-lg border border-kumo-hairline">
        {changes.map((c) => (
          <li key={c.field} className="flex flex-col gap-1 px-3 py-2.5 text-sm">
            <span className="font-medium">{c.field === "content" ? (t.dns.contentByType[type] ?? t.dns.content[TYPE_SPECS[type]?.content ?? "text"]) : (t.dns.fields[c.field] ?? c.field)}</span>
            <span className="grid grid-cols-[3.5rem_minmax(0,1fr)] gap-x-2 gap-y-1">
              <span className="text-kumo-subtle">{t.dns.before}</span>
              <span className="text-kumo-danger line-through decoration-1">{show(c.field, c.before)}</span>
              <span className="text-kumo-subtle">{t.dns.after}</span>
              <span>{show(c.field, c.after)}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// --- Delete ---

function RecordList({ records, zone }: { records: { key: string; type: string; name: string; value: string; note?: ReactNode }[]; zone: string }) {
  return (
    <ul className="flex max-h-72 flex-col divide-y divide-kumo-hairline overflow-y-auto rounded-lg border border-kumo-hairline">
      {records.map((r) => (
        <li key={r.key} className="flex items-baseline gap-2 px-3 py-2 text-sm">
          <span className="w-14 shrink-0 font-mono text-xs text-kumo-subtle">{r.type}</span>
          <span className="flex min-w-0 flex-col">
            <span className="font-medium break-all">{relativeName(zone, r.name)}</span>
            <span className="font-mono text-xs break-all text-kumo-subtle">{r.value}</span>
            {r.note}
          </span>
        </li>
      ))}
    </ul>
  );
}

function DeleteDialog({ z, records, onClose }: { z: ZoneDetail; records: Rec[]; onClose: (done: boolean) => void }) {
  const t = useT();
  const { run, busy } = useMutation();
  const parking = records.some((r) => r.type === "A" && r.content === PARK_ADDRESS);
  return (
    <ConfirmDialog
      open
      onOpenChange={(o) => !o && onClose(false)}
      title={t.dns.deleteTitle(records.length)}
      description={t.dns.deleteHint}
      confirm={t.dns.deleteConfirm(records.length)}
      danger
      busy={busy}
      size="lg"
      onConfirm={async () => {
        if (await run(z.zone.id, "POST", "/records/delete", { records: records.map((r) => ({ id: r.id, modifiedOn: r.modified_on })) }, t.dns.deleted(records.length))) onClose(true);
      }}
    >
      <RecordList zone={z.zone.name} records={records.map((r) => ({ key: r.id, type: r.type, name: r.name, value: recordValue(r) }))} />
      {parking && <Banner variant="alert" icon={<WarningIcon weight="fill" />} description={t.dns.deleteParking} />}
    </ConfirmDialog>
  );
}

// --- Import ---

function ImportDialog({ z, onClose }: { z: ZoneDetail; onClose: () => void }) {
  const t = useT();
  const { run, busy } = useMutation();
  const [file, setFile] = useState("");
  const [proxied, setProxied] = useState(true);
  const picker = useRef<HTMLInputElement>(null);
  const zone = z.zone.name;
  const tooLarge = new TextEncoder().encode(file).length > IMPORT_MAX_BYTES;
  const parsed = useMemo(() => parseZoneFile(file, zone), [file, zone]);
  const preview = useMemo(() => previewImport(zone, z.records, parsed.records), [zone, z.records, parsed.records]);
  const item = (r: (typeof parsed.records)[number]) => ({ key: `${r.line}-${r.type}-${r.name}`, type: r.type, name: r.name, value: `${r.priority !== undefined ? `${r.priority} ` : ""}${r.content}` });

  return (
    <ConfirmDialog
      open
      onOpenChange={(o) => !o && onClose()}
      size="lg"
      title={t.dns.importTitle}
      description={t.dns.importHint}
      confirm={t.dns.importConfirm(preview.add.length)}
      disabled={!preview.add.length || tooLarge || parsed.errors.length > 0}
      busy={busy}
      onConfirm={async () => {
        if (await run(z.zone.id, "POST", "/records/import", { file, proxied }, t.dns.imported)) onClose();
      }}
    >
      <div className="flex flex-col gap-2">
        <input
          ref={picker}
          type="file"
          accept=".txt,.zone,.db,.bind,text/plain"
          hidden
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (f) setFile(await f.text());
          }}
        />
        <div>
          <Button variant="secondary" icon={UploadSimpleIcon} onClick={() => picker.current?.click()}>
            {t.dns.importFile}
          </Button>
        </div>
        <InputArea label={t.dns.importPaste} value={file} onValueChange={setFile} rows={5} spellCheck={false} className="font-mono text-xs" placeholder={`www.${zone}.  3600  IN  A  192.0.2.1`} />
      </div>
      <Checkbox label={t.dns.importProxied} checked={proxied} onCheckedChange={(v) => setProxied(!!v)} />
      {tooLarge && <Banner variant="error" icon={<WarningIcon weight="fill" />} description={t.dns.importTooLarge(IMPORT_MAX_BYTES / 1024)} />}
      {file.trim() && !tooLarge && (
        <div className="flex flex-col gap-3">
          {preview.add.length ? (
            <section className="flex flex-col gap-1.5">
              <h3 className="text-sm font-medium">{t.dns.importAdd(preview.add.length)}</h3>
              <RecordList zone={zone} records={preview.add.map(item)} />
            </section>
          ) : (
            <Banner variant="secondary" description={t.dns.importNothing} />
          )}
          {preview.conflicts.length > 0 && (
            <section className="flex flex-col gap-1.5">
              <h3 className="flex items-center gap-1.5 text-sm font-medium text-kumo-warning">
                <WarningIcon weight="fill" /> {t.dns.importConflicts(preview.conflicts.length)}
              </h3>
              <RecordList zone={zone} records={preview.conflicts.map((c) => ({ ...item(c.record), note: <span className="text-xs text-kumo-warning">{c.with.map((w) => `${w.type} ${recordValue(w)}`).join(", ")}</span> }))} />
            </section>
          )}
          {preview.same.length > 0 && <p className="text-sm text-kumo-subtle">{t.dns.importSame(preview.same.length)}</p>}
          {parsed.errors.length > 0 && (
            <div className="flex flex-col gap-1">
              <Banner variant="error" icon={<WarningIcon weight="fill" />} description={t.dns.importUnreadable(parsed.errors.length)} />
              <ul className="max-h-24 overflow-y-auto font-mono text-xs text-kumo-subtle">
                {parsed.errors.map((e) => (
                  <li key={e.line} className="break-all">
                    {e.line}: {e.text}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </ConfirmDialog>
  );
}

// --- DNS settings: nameservers, DNSSEC, CNAME flattening ---

type Settings = {
  nameServers: string[];
  plan: string | null;
  dnssec: (Record<string, string | number> & { status: string }) | null;
  dnssecError: string | null;
  flattenAllCnames: boolean | null;
  settingsError: string | null;
};

function Unavailable({ error }: { error: string | null }) {
  const t = useT();
  return <p className="text-sm text-kumo-subtle">{error === "forbidden" ? t.dns.notAllowed : t.dns.cantRead}</p>;
}

function SettingCard({ title, hint, aside, children }: { title: string; hint?: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <LayerCard>
      <LayerCard.Secondary className="flex items-center justify-between gap-2">
        <span>{title}</span>
        {aside}
      </LayerCard.Secondary>
      <LayerCard.Primary className="flex flex-col gap-3">
        {hint && <p className="text-sm text-kumo-subtle">{hint}</p>}
        {children}
      </LayerCard.Primary>
    </LayerCard>
  );
}

const DNSSEC_BADGE: Record<string, "success" | "warning" | "neutral" | "error"> = { active: "success", pending: "warning", "pending-disabled": "warning", disabled: "neutral", error: "error" };

function DnsSettingsPanel({ z }: { z: ZoneDetail }) {
  const t = useT();
  const q = useApi<Settings>(`/zones/${z.zone.id}/dns-settings`);
  const { run, busy } = useMutation();
  const [ask, setAsk] = useState<"dnssec-on" | "dnssec-off" | "flatten-on" | "flatten-off" | null>(null);
  const s = q.data;
  const nameServers = s?.nameServers.length ? s.nameServers : z.zone.nameServers;
  const d = s?.dnssec;
  const confirm = async () => {
    const ok =
      ask === "dnssec-on" || ask === "dnssec-off"
        ? await run(z.zone.id, "PATCH", "/dnssec", { enable: ask === "dnssec-on" }, ask === "dnssec-on" ? t.dns.dnssecOn : t.dns.dnssecOff)
        : await run(z.zone.id, "PATCH", "/dns-settings", { flattenAllCnames: ask === "flatten-on" }, t.dns.flattenChanged);
    await q.reload();
    if (ok) setAsk(null);
  };
  const dialog = {
    "dnssec-on": { title: t.dns.dnssecEnableTitle, text: t.dns.dnssecEnableText, confirm: t.dns.dnssecEnable, danger: false },
    "dnssec-off": { title: t.dns.dnssecDisableTitle, text: t.dns.dnssecDisableText, confirm: t.dns.dnssecDisable, danger: true },
    "flatten-on": { title: t.dns.flattenAllOn, text: t.dns.flattenAllOnText, confirm: t.common.save, danger: false },
    "flatten-off": { title: t.dns.flattenAllOff, text: t.dns.flattenAllOffText, confirm: t.common.save, danger: false },
  };

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-base font-semibold">{t.dns.settingsTitle}</h2>
      <div className="grid items-start gap-4 lg:grid-cols-3">
        <SettingCard title={t.dns.nameservers} hint={t.dns.nameserversHint}>
          <div className="flex flex-col gap-2">
            {nameServers.map((n) => (
              <ClipboardText key={n} text={n} />
            ))}
          </div>
        </SettingCard>

        <SettingCard title={t.dns.dnssec} hint={t.dns.dnssecHint} aside={d && <Badge variant={DNSSEC_BADGE[d.status] ?? "neutral"}>{t.dns.dnssecStatus[d.status] ?? d.status}</Badge>}>
          {!s ? null : !d ? (
            <Unavailable error={s.dnssecError} />
          ) : (
            <>
              {d.ds && (
                <div className="flex flex-col gap-2">
                  {d.status === "pending" && <p className="text-sm">{t.dns.dnssecPending}</p>}
                  <span className="text-xs font-medium text-kumo-subtle">{t.dns.dsRecord}</span>
                  <ClipboardText text={String(d.ds)} />
                  <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
                    {["key_tag", "algorithm", "digest_type", "digest"].filter((k) => d[k] !== undefined).map((k) => (
                      <div key={k} className="contents">
                        <dt className="text-kumo-subtle">{t.dns.dsFields[k]}</dt>
                        <dd className="font-mono text-[13px] break-all">{String(d[k])}</dd>
                      </div>
                    ))}
                  </dl>
                </div>
              )}
              <div>
                {d.status === "disabled" ? (
                  <Button variant="secondary" onClick={() => setAsk("dnssec-on")}>
                    {t.dns.dnssecEnable}
                  </Button>
                ) : (
                  d.status !== "pending-disabled" && (
                    <Button variant="secondary" onClick={() => setAsk("dnssec-off")}>
                      {t.dns.dnssecDisable}
                    </Button>
                  )
                )}
              </div>
            </>
          )}
        </SettingCard>

        <SettingCard title={t.dns.flattening} hint={t.dns.flattenAllHint}>
          {!s ? null : s.flattenAllCnames === null ? (
            <Unavailable error={s.settingsError} />
          ) : (
            <Switch label={t.dns.flattenAll} checked={s.flattenAllCnames} onCheckedChange={(v) => setAsk(v ? "flatten-on" : "flatten-off")} />
          )}
        </SettingCard>
      </div>

      {ask && <ConfirmDialog open onOpenChange={(o) => !o && setAsk(null)} title={dialog[ask].title} description={dialog[ask].text} confirm={dialog[ask].confirm} danger={dialog[ask].danger} busy={busy} onConfirm={confirm} />}
    </section>
  );
}
