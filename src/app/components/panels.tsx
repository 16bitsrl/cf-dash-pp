import { Badge, Banner, Button, Checkbox, Collapsible, Input, LayerCard, Select, Table, Tooltip } from "@cloudflare/kumo";
import { CaretRightIcon, CheckCircleIcon, CircleIcon, InfoIcon, PencilSimpleIcon, PlusIcon, TrashIcon, WarningIcon } from "@phosphor-icons/react";
import { useState, type ReactNode } from "react";
import type { Area, Check, FixId, NameReport } from "../../worker/lib/mail";
import { displayRecords, type Redirect, type RedirectInput } from "../../worker/lib/zone-state";
import { mxPreset, proposeSpf, type MxPreset } from "../../worker/lib/senders";
import { checkText, errorText, useT } from "../i18n";
import type { ZoneDetail } from "../lib/api";
import { dash, shortName } from "../lib/format";
import { useMutation } from "../lib/hooks";
import { parkingPagePath, useParkPages } from "../lib/park";
import { ConfirmDialog } from "./ConfirmDialog";
import { DeepLink, LevelIcon, TableCard } from "./ui";

function Card({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <LayerCard>
      <LayerCard.Secondary className="flex items-center justify-between gap-2">
        <span>{title}</span>
        {aside && <div className="flex items-center gap-2">{aside}</div>}
      </LayerCard.Secondary>
      <LayerCard.Primary>{children}</LayerCard.Primary>
    </LayerCard>
  );
}

// --- Parking ---

const PARK_VARIANT = { parked: "purple", partial: "warning", off: "neutral" } as const;

export function ParkingPanel({ z }: { z: ZoneDetail }) {
  const t = useT();
  const { run, busy } = useMutation();
  const [dialog, setDialog] = useState<"enable" | "disable" | null>(null);
  const [protectMail, setProtectMail] = useState(z.mail.mode === "none");
  const [removeRecords, setRemoveRecords] = useState(true);
  const name = z.zone.name;
  const acc = z.zone.account.id;
  const p = z.parking;
  const pages = useParkPages(acc, !!z.park && p.state !== "off");

  const items = [
    { key: "record @", label: t.parking.itemRecord(name) },
    { key: "record www", label: t.parking.itemRecord(`www.${name}`) },
    { key: "route @", label: t.parking.itemRoute(name) },
    { key: "route www", label: t.parking.itemRoute(`www.${name}`) },
  ];
  const blocked = z.servedBy.length ? t.parking.blockedWorker(z.servedBy.map((x) => x.worker).filter((w, i, a) => a.indexOf(w) === i).join(", ")) : z.usage === "site" ? t.parking.blockedSite : z.usage === "redirect" ? t.parking.blockedRedirect : null;

  return (
    <Card
      title={t.parking.card}
      aside={
        <>
          <Badge variant={PARK_VARIANT[p.state]}>{t.parking.state[p.state]}</Badge>
          <DeepLink href={dash.zone(acc, name, "/workers")} />
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="text-sm text-kumo-subtle">{t.parking.explain}</p>
        {p.state !== "off" && (
          <ul className="flex flex-col gap-2 text-sm">
            {items.map((i) => {
              const ok = !p.missing.includes(i.key);
              return (
                <li key={i.key} className="flex items-center gap-2">
                  {ok ? <CheckCircleIcon size={18} weight="fill" className="text-kumo-success" /> : <CircleIcon size={18} className="text-kumo-warning" />}
                  <span className={ok ? "" : "text-kumo-warning"}>{i.label}</span>
                </li>
              );
            })}
          </ul>
        )}
        {p.state !== "off" && z.park && pages.settings && pages.park.data?.canManage && (
          <div className="flex flex-wrap items-end gap-3">
            <Select className="w-72" label={t.parking.pageColumn} value={pages.pageOf(name)} onValueChange={(v) => pages.setPageOf(name, String(v))} items={pages.items} disabled={pages.busy} />
            <a href={parkingPagePath(acc, pages.pageOf(name))} className="pb-2 text-sm text-kumo-link hover:underline">
              {t.parking.editPage}
            </a>
          </div>
        )}
        {z.routesError && <Banner variant="alert" icon={<WarningIcon weight="fill" />} description={errorText(t, z.routesError)} />}
        {!z.canPark && p.state !== "parked" && <Banner variant="secondary" icon={<InfoIcon weight="fill" />} description={t.parking.notReady} />}
        {p.state === "off" && blocked && <Banner variant="secondary" icon={<InfoIcon weight="fill" />} description={blocked} />}
        <div className="flex flex-wrap gap-2">
          {p.state !== "parked" && (
            <Button variant="primary" disabled={!z.canPark || (p.state === "off" && !!blocked)} onClick={() => setDialog("enable")}>
              {p.state === "partial" ? t.parking.complete : t.parking.park}
            </Button>
          )}
          {p.state !== "off" && (
            <Button variant="secondary-destructive" onClick={() => setDialog("disable")}>
              {t.parking.unpark}
            </Button>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={dialog === "enable"}
        onOpenChange={(o) => !o && setDialog(null)}
        title={t.parking.parkTitle(name)}
        description={t.parking.parkDescription(name)}
        confirm={t.parking.park}
        busy={busy}
        onConfirm={async () => {
          if (await run(z.zone.id, "POST", "/parking", { enable: true, protectMail }, t.parking.done(name))) setDialog(null);
        }}
      >
        <Checkbox checked={protectMail} disabled={z.mail.mode === "mail"} onCheckedChange={(v) => setProtectMail(!!v)} label={z.mail.mode === "mail" ? t.parking.protectMailNo : t.parking.protectMail} />
      </ConfirmDialog>

      <ConfirmDialog
        open={dialog === "disable"}
        onOpenChange={(o) => !o && setDialog(null)}
        title={t.parking.unparkTitle(name)}
        description={t.parking.unparkDescription}
        confirm={t.parking.unpark}
        danger
        busy={busy}
        onConfirm={async () => {
          if (await run(z.zone.id, "POST", "/parking", { enable: false, removeRecords }, t.parking.removed)) setDialog(null);
        }}
      >
        <Checkbox checked={removeRecords} onCheckedChange={(v) => setRemoveRecords(!!v)} label={t.parking.removeRecords(name)} />
      </ConfirmDialog>
    </Card>
  );
}

// --- Redirects ---

type Form = { host: string; path: string; pathPrefix: boolean; target: string; status: string; preservePath: boolean; preserveQuery: boolean; includeWww: boolean };
const emptyForm: Form = { host: "", path: "", pathPrefix: false, target: "https://", status: "301", preservePath: false, preserveQuery: false, includeWww: true };
const toInput = (f: Form): RedirectInput => ({ ...f, host: f.host.trim() || undefined, path: f.path.trim() || null, status: Number(f.status) as RedirectInput["status"] });
const formOf = (r: Redirect, zone: string): Form => ({
  host: r.hosts[0] && r.hosts[0] !== zone && r.hosts[0] !== `www.${zone}` ? r.hosts[0] : "",
  path: r.path ?? "",
  pathPrefix: r.pathPrefix,
  target: r.target,
  status: String(r.status),
  preservePath: r.preservePath,
  preserveQuery: r.preserveQuery,
  includeWww: r.hosts.includes(`www.${zone}`),
});

/** Where a redirect starts from, as people read it: "blog.example.com/old*". */
export const redirectSource = (r: Pick<Redirect, "hosts" | "path" | "pathPrefix">) => `${r.hosts.join(", ")}${r.path ? `${r.path}${r.pathPrefix ? "…" : ""}` : ""}`;

function RedirectFields({ name, form, setForm }: { name: string; form: Form; setForm: (f: Form) => void }) {
  const t = useT();
  const apex = !form.host.trim() || form.host.trim().toLowerCase() === name;
  const from = `${apex ? name : form.host.trim().includes(".") ? form.host.trim() : `${form.host.trim()}.${name}`}${form.path.trim()}`;
  return (
    <div className="flex flex-col gap-4">
      <div className="grid items-end gap-4 sm:grid-cols-2">
        <Input label={t.redirects.host} value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value })} placeholder={name} labelTooltip={t.redirects.hostHint(name)} />
        <Input label={<>{t.redirects.path} <span className="font-normal text-kumo-subtle">{t.common.optional}</span></>} value={form.path} onChange={(e) => setForm({ ...form, path: e.target.value })} placeholder="/promo" labelTooltip={t.redirects.pathHint} />
      </div>
      <div className="grid items-end gap-4 sm:grid-cols-[1fr_220px]">
        <Input label={t.redirects.target} value={form.target} onChange={(e) => setForm({ ...form, target: e.target.value })} placeholder="https://example.com" />
        <Select className="w-full" label={t.redirects.type} labelTooltip={t.redirects.typeHint} value={form.status} onValueChange={(v) => setForm({ ...form, status: String(v) })} items={t.redirects.status} />
      </div>
      <p className="-mt-2 text-sm text-kumo-subtle">{t.redirects.targetHint(from)}</p>
      <div className="flex flex-col gap-2">
        {apex && <Checkbox checked={form.includeWww} onCheckedChange={(v) => setForm({ ...form, includeWww: !!v })} label={t.redirects.includeWww(name)} />}
        {form.path.trim() && <Checkbox checked={form.pathPrefix} onCheckedChange={(v) => setForm({ ...form, pathPrefix: !!v })} label={t.redirects.pathPrefix(form.path.trim())} />}
        <Checkbox checked={form.preservePath} onCheckedChange={(v) => setForm({ ...form, preservePath: !!v })} label={t.redirects.preservePath(name)} />
        <Checkbox checked={form.preserveQuery} onCheckedChange={(v) => setForm({ ...form, preserveQuery: !!v })} label={t.redirects.preserveQuery} />
      </div>
    </div>
  );
}

const validTarget = (s: string) => /^https?:\/\/[^/]+\.[^/]+/.test(s);

export function RedirectsPanel({ z }: { z: ZoneDetail }) {
  const t = useT();
  const { run, busy } = useMutation();
  const [form, setForm] = useState<Form>(emptyForm);
  const [editing, setEditing] = useState<{ rule: Redirect; form: Form } | null>(null);
  const [remove, setRemove] = useState<Redirect | null>(null);
  const [removeRecords, setRemoveRecords] = useState(true);
  const name = z.zone.name;

  return (
    <div className="flex flex-col gap-6">
      <Card title={t.redirects.active} aside={<DeepLink href={dash.zone(z.zone.account.id, name, "/rules/redirect-rules")} />}>
        {z.rulesetError ? (
          <Banner variant="alert" icon={<WarningIcon weight="fill" />} description={errorText(t, z.rulesetError)} />
        ) : !z.redirects.length ? (
          <p className="text-sm text-kumo-subtle">{t.redirects.none}</p>
        ) : (
          <TableCard>
            <Table>
              <Table.Header>
                <Table.Row>
                  <Table.Head>{t.redirects.from}</Table.Head>
                  <Table.Head>{t.redirects.to}</Table.Head>
                  <Table.Head>{t.redirects.type}</Table.Head>
                  <Table.Head className="w-20">
                    <span className="sr-only">{t.common.actions}</span>
                  </Table.Head>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {z.redirects.map((r) => (
                  <Table.Row key={r.id}>
                    <Table.Cell>{r.hosts.length ? redirectSource(r) : <span className="text-kumo-subtle">{r.description || t.redirects.custom}</span>}</Table.Cell>
                    <Table.Cell>
                      {r.target}
                      {r.preservePath && <span className="text-kumo-subtle">/…</span>}
                      {!r.enabled && (
                        <Badge variant="neutral" className="ml-2">
                          {t.redirects.disabled}
                        </Badge>
                      )}
                    </Table.Cell>
                    <Table.Cell className="text-kumo-subtle">{t.redirects.status[String(r.status)] ?? r.status}</Table.Cell>
                    <Table.Cell>
                      <div className="flex justify-end gap-1">
                        {r.hosts.length > 0 && (
                          <Button
                            variant="ghost"
                            size="sm"
                            shape="square"
                            icon={PencilSimpleIcon}
                            aria-label={t.redirects.edit}
                            onClick={() => setEditing({ rule: r, form: formOf(r, name) })}
                          />
                        )}
                        <Button variant="ghost" size="sm" shape="square" icon={TrashIcon} aria-label={t.redirects.deleteTitle} onClick={() => setRemove(r)} />
                      </div>
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table>
          </TableCard>
        )}
      </Card>

      {!z.rulesetError && (
        <Card title={t.redirects.new}>
          {z.parking.state !== "off" && <p className="mb-4 text-sm text-kumo-subtle">{t.redirects.parkedHint}</p>}
          {
            <form
              className="flex flex-col gap-4"
              onSubmit={async (e) => {
                e.preventDefault();
                if (await run(z.zone.id, "POST", "/redirects", toInput(form), t.redirects.added)) setForm(emptyForm);
              }}
            >
              <RedirectFields name={name} form={form} setForm={setForm} />
              {z.usage === "site" && !form.host.trim() && !form.path.trim() && <Banner variant="alert" icon={<WarningIcon weight="fill" />} description={t.redirects.siteWarning} />}
              <div>
                <Button type="submit" variant="primary" icon={PlusIcon} loading={busy} disabled={!validTarget(form.target)}>
                  {t.redirects.add}
                </Button>
              </div>
            </form>
          }
        </Card>
      )}

      <ConfirmDialog
        open={!!editing}
        onOpenChange={(o) => !o && setEditing(null)}
        title={t.redirects.edit}
        size="lg"
        confirm={t.common.save}
        busy={busy}
        onConfirm={async () => {
          if (editing && validTarget(editing.form.target) && (await run(z.zone.id, "PUT", `/redirects/${editing.rule.id}`, toInput(editing.form), t.redirects.updated))) setEditing(null);
        }}
      >
        {editing && <RedirectFields name={name} form={editing.form} setForm={(f) => setEditing({ ...editing, form: f })} />}
      </ConfirmDialog>

      <ConfirmDialog
        open={!!remove}
        onOpenChange={(o) => !o && setRemove(null)}
        title={t.redirects.deleteTitle}
        description={remove && t.redirects.deleteDescription(remove.hosts.length ? redirectSource(remove) : remove.description, remove.target)}
        confirm={t.common.delete}
        danger
        busy={busy}
        onConfirm={async () => {
          if (remove && (await run(z.zone.id, "DELETE", `/redirects/${remove.id}?records=${removeRecords ? 1 : 0}`, undefined, t.redirects.deleted))) setRemove(null);
        }}
      >
        {remove && remove.hosts.length > 0 && <Checkbox checked={removeRecords} onCheckedChange={(v) => setRemoveRecords(!!v)} label={t.parking.removeRecords(name)} />}
      </ConfirmDialog>
    </div>
  );
}

// --- Email ---

// Checks whose detail is the record itself, shown as code.
const RECORD_VALUE = new Set(["mx-ok", "spf-ok", "dmarc-ok"]);

const AREAS: Area[] = ["mx", "spf", "dkim", "dmarc", "other"];

type Editor = { kind: "mx"; preset: MxPreset; updateSpf: boolean } | { kind: "spf"; value: string } | { kind: "dmarc"; policy: string; rua: string };

function Yes({ ok }: { ok: boolean }) {
  return ok ? <CheckCircleIcon size={18} weight="fill" className="text-kumo-success" /> : <CircleIcon size={18} className="text-kumo-inactive" />;
}

export function MailPanel({ z }: { z: ZoneDetail }) {
  const t = useT();
  const subs = z.mail.subdomains;
  return (
    <div className="flex flex-col gap-6">
      <MailSection z={z} m={z.mail} />
      {subs.length > 0 && (
        <section className="flex flex-col gap-3">
          <div>
            <h2 className="text-base font-semibold">{t.mail.subdomains}</h2>
            <p className="mt-1 text-sm text-kumo-subtle">{t.mail.subdomainsHint}</p>
          </div>
          {subs.map((s) => (
            <SubdomainMail key={s.name} z={z} m={s} />
          ))}
        </section>
      )}
    </div>
  );
}

function Score({ m }: { m: NameReport }) {
  const t = useT();
  return (
    <div className="flex flex-wrap items-center gap-2">
      {m.score.errors > 0 && <Badge variant="error">{t.mail.errors(m.score.errors)}</Badge>}
      {m.score.warnings > 0 && <Badge variant="warning">{t.mail.warnings(m.score.warnings)}</Badge>}
      {!m.score.errors && !m.score.warnings && <Badge variant="success">{t.mail.allGood}</Badge>}
    </div>
  );
}

function headline(t: ReturnType<typeof useT>, m: NameReport, sub: boolean) {
  if (m.mode === "protected") return t.mail.headlineProtected;
  if (m.mode === "none") return sub && m.records.spf.length ? t.mail.headlineSendsOnly : t.mail.headlineNone;
  if (m.provider?.pec) return t.mail.headlinePec(m.provider.name);
  return m.provider ? t.mail.headlineProvider(m.provider.name) : t.mail.headlineOwn;
}

function SubdomainMail({ z, m }: { z: ZoneDetail; m: NameReport }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <LayerCard>
      <Collapsible.Root open={open} onOpenChange={setOpen}>
        <Collapsible.Trigger className="flex w-full cursor-pointer flex-wrap items-center justify-between gap-3 px-4 py-3 text-left">
          <span className="flex min-w-0 items-center gap-3">
            <CaretRightIcon size={14} className={`shrink-0 text-kumo-subtle transition-transform ${open ? "rotate-90" : ""}`} />
            <span className="min-w-0">
              <span className="block truncate font-mono text-sm font-medium">{m.name}</span>
              <span className="block text-sm text-kumo-subtle">{headline(t, m, true)}</span>
            </span>
          </span>
          <Score m={m} />
        </Collapsible.Trigger>
        <Collapsible.Panel>
          <div className="border-t border-kumo-hairline p-4">
            <MailSection z={z} m={m} sub />
          </div>
        </Collapsible.Panel>
      </Collapsible.Root>
    </LayerCard>
  );
}

// On a subdomain the boxes are plain sections, since the whole thing is already inside a card.
function Plain({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <h3 className="mb-2 text-sm font-semibold">{title}</h3>
      {children}
    </div>
  );
}

function MailSection({ z, m, sub = false }: { z: ZoneDetail; m: NameReport; sub?: boolean }) {
  const t = useT();
  const { run, busy } = useMutation();
  const [fix, setFix] = useState<FixId | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [policy, setPolicy] = useState("none");
  const [rua, setRua] = useState("");
  const name = m.name;
  const acc = z.zone.account.id;
  const Box = sub ? Plain : Card;
  // Requests for a subdomain say which one; without a name they go to the apex.
  const target = sub ? { name } : {};
  const spfValue = m.provider?.spf ? `v=spf1 include:${m.provider.spf} ~all` : "v=spf1 mx ~all";
  const dmarcManagement = dash.zone(acc, z.zone.name, "/email/dmarc-management");
  const dmarcTags = m.records.dmarc[0] ? Object.fromEntries(m.records.dmarc[0].split(";").map((x) => x.trim().split("=").map((y) => y.trim()))) : {};
  // Without its own DMARC a subdomain follows the apex: start from that, not from "none".
  const inherited = m.checks.find((c) => c.id === "dmarc-inherited")?.params?.policy;
  const currentPolicy = ["none", "quarantine", "reject"].includes(dmarcTags.p) ? dmarcTags.p : String(inherited ?? "none");

  // SPF proposal: what's there, plus the services that sign or receive but are missing.
  const missingIncludes = m.senders.filter((s) => !s.spf && s.include && s.needsSpf && (s.dkim || s.receives)).map((s) => s.include!);
  const openSpf = (extra: string[] = []) => setEditor({ kind: "spf", value: proposeSpf(m.records.spf, [...missingIncludes, ...extra]) });
  const presetOf = (): MxPreset => (m.provider && ["google", "microsoft", "qboxmail", "forwardemail"].includes(m.provider.id) ? (m.provider.id as MxPreset) : "google");

  const mxLine = m.records.mx.length ? m.records.mx.map((x) => (x.host === "." || !x.host ? t.mail.nullMx : `${x.host} (${x.priority})`)).join(", ") : t.mail.noMx;
  const tools = (
      <div className={`flex flex-wrap items-center gap-2 ${sub ? "" : "mt-4 border-t border-kumo-hairline pt-4"}`}>
        <Button size="sm" variant="secondary" onClick={() => setEditor({ kind: "mx", preset: presetOf(), updateSpf: true })}>
          {t.mail.setMx}
        </Button>
        <Button size="sm" variant="secondary" onClick={() => openSpf()}>
          {t.mail.editSpf}
        </Button>
        <Button size="sm" variant="secondary" onClick={() => setEditor({ kind: "dmarc", policy: currentPolicy, rua: "" })}>
          {t.mail.editDmarc}
        </Button>
        {!sub && (
          <>
            <span className="flex-1" />
            <DeepLink href={dmarcManagement} label={t.mail.dmarcManagement} />
          </>
        )}
      </div>
  );

  return (
    <div className="flex flex-col gap-6">
      {sub ? (
        <div className="flex flex-col gap-3">
          <div className="text-sm text-kumo-subtle">{mxLine}</div>
          {tools}
        </div>
      ) : (
        <LayerCard>
          <LayerCard.Primary>
            <div className="flex w-full flex-wrap items-center justify-between gap-4 text-left">
              <div>
                <div className="text-base font-semibold">{headline(t, m, false)}</div>
                <div className="mt-1 text-sm text-kumo-subtle">{mxLine}</div>
              </div>
              <Score m={m} />
            </div>
            {tools}
          </LayerCard.Primary>
        </LayerCard>
      )}

      <Box title={sub ? t.mail.sendersSub : t.mail.senders}>
        <p className="mb-3 text-sm text-kumo-subtle">{t.mail.sendersHint}</p>
        {m.senders.length ? (
          <TableCard>
            <Table>
              <Table.Header>
                <Table.Row>
                  <Table.Head>{t.mail.service}</Table.Head>
                  <Table.Head>{t.mail.receives}</Table.Head>
                  <Table.Head>SPF</Table.Head>
                  <Table.Head>DKIM</Table.Head>
                  <Table.Head className="w-48">
                    <span className="sr-only">{t.common.actions}</span>
                  </Table.Head>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {m.senders.map((s) => (
                  <Table.Row key={s.id}>
                    <Table.Cell>
                      {s.unknown ? (
                        <span>
                          <span className="font-mono text-xs">{s.name}</span> <span className="text-kumo-subtle">· {t.mail.unknownService}</span>
                        </span>
                      ) : (
                        s.name
                      )}
                    </Table.Cell>
                    <Table.Cell>{s.receives ? <Yes ok /> : <span className="text-kumo-inactive">—</span>}</Table.Cell>
                    <Table.Cell>{s.spf || s.needsSpf ? <Yes ok={s.spf} /> : <span className="text-kumo-inactive">—</span>}</Table.Cell>
                    <Table.Cell>{s.dkim || (s.needsDkim && !s.unknown) ? <Yes ok={s.dkim} /> : <span className="text-kumo-inactive">—</span>}</Table.Cell>
                    <Table.Cell>
                      <div className="flex justify-end gap-2">
                        {!s.spf && s.include && s.needsSpf && (
                          <Button size="sm" variant="secondary" onClick={() => openSpf([s.include!])}>
                            {t.mail.addToSpf}
                          </Button>
                        )}
                        {!s.dkim && s.needsDkim && s.docs && <DeepLink href={s.docs} label={t.mail.dkimDocs} cloudflare={false} />}
                      </div>
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table>
          </TableCard>
        ) : (
          <p className="text-sm text-kumo-subtle">{t.mail.noSenders}</p>
        )}
      </Box>

      {AREAS.map((area) => {
        const checks = m.checks.filter((c) => c.area === area);
        if (!checks.length) return null;
        return (
          <Box key={area} title={t.mail.areas[area]}>
            <ul className="flex flex-col divide-y divide-kumo-hairline">
              {checks.map((c: Check, i) => {
                const text = checkText(t, c);
                return (
                  <li key={`${c.id}-${i}`} className="flex items-start gap-3 py-3 first:pt-0 last:pb-0">
                    <LevelIcon level={c.level} />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium">{text.title}</div>
                      {text.detail && <div className={`mt-0.5 text-sm text-kumo-subtle ${RECORD_VALUE.has(c.id) ? "font-mono text-xs break-all" : ""}`}>{text.detail}</div>}
                    </div>
                    {c.params?.docs && <DeepLink href={String(c.params.docs)} label={t.mail.dkimDocs} cloudflare={false} />}
                    {c.id === "dmarc-none" && (
                      <Button size="sm" variant="secondary" onClick={() => setEditor({ kind: "dmarc", policy: "quarantine", rua: "" })}>
                        {t.mail.editDmarc}
                      </Button>
                    )}
                    {c.fix && (
                      <Button size="sm" variant="secondary" onClick={() => (c.fix === "add-spf-include" ? openSpf([String(c.params?.include ?? "")]) : c.fix === "google-mx" ? setEditor({ kind: "mx", preset: "google", updateSpf: true }) : setFix(c.fix!))}>
                        {sub && c.fix === "protect-no-mail" ? t.mail.protect : t.mail.fix[c.fix]}
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          </Box>
        );
      })}


      <ConfirmDialog
        open={editor?.kind === "mx"}
        onOpenChange={(o) => !o && setEditor(null)}
        title={t.mail.mxTitle}
        description={t.mail.mxDescription}
        confirm={t.mail.setMx}
        size="lg"
        busy={busy}
        onConfirm={async () => {
          if (editor?.kind === "mx" && (await run(z.zone.id, "POST", "/mail/mx", { preset: editor.preset, updateSpf: editor.updateSpf, ...target }, t.mail.mxDone))) setEditor(null);
        }}
      >
        {editor?.kind === "mx" && (
          <>
            <Select label={t.mail.mxProvider} value={editor.preset} onValueChange={(v) => setEditor({ ...editor, preset: v as MxPreset })} items={t.mail.mxPresets} />
            <div className="text-sm">
              <p className="mb-1 text-kumo-subtle">{t.mail.mxWillSet}</p>
              <ul className="font-mono text-xs">
                {mxPreset(editor.preset, name).map((r) => (
                  <li key={r.host}>
                    MX {r.priority} {r.host}
                  </li>
                ))}
              </ul>
              {m.records.mx.length > 0 && <p className="mt-2 text-kumo-subtle">{t.mail.mxCurrent(m.records.mx.map((x) => `${x.priority} ${x.host}`).join(", "))}</p>}
            </div>
            <Checkbox
              checked={editor.updateSpf}
              onCheckedChange={(v) => setEditor({ ...editor, updateSpf: !!v })}
              label={editor.preset === "none" ? t.mail.mxUpdateSpfNone : t.mail.mxUpdateSpf(t.mail.mxPresets[editor.preset])}
            />
          </>
        )}
      </ConfirmDialog>

      <ConfirmDialog
        open={editor?.kind === "spf"}
        onOpenChange={(o) => !o && setEditor(null)}
        title={t.mail.spfTitle2}
        description={t.mail.spfEditDescription}
        confirm={t.common.save}
        size="lg"
        busy={busy}
        onConfirm={async () => {
          if (editor?.kind === "spf" && (await run(z.zone.id, "PUT", "/mail/spf", { value: editor.value, ...target }, t.mail.spfSaved))) setEditor(null);
        }}
      >
        {editor?.kind === "spf" && (
          <>
            {m.records.spf.length > 0 && (
              <ul className="font-mono text-xs text-kumo-subtle line-through">
                {m.records.spf.map((v) => (
                  <li key={v}>{v}</li>
                ))}
              </ul>
            )}
            <Input label={t.mail.spfValue} className="font-mono" value={editor.value} onChange={(e) => setEditor({ ...editor, value: e.target.value })} />
          </>
        )}
      </ConfirmDialog>

      <ConfirmDialog
        open={editor?.kind === "dmarc"}
        onOpenChange={(o) => !o && setEditor(null)}
        title={t.mail.dmarcEditTitle}
        description={t.mail.dmarcEditDescription}
        confirm={t.common.save}
        busy={busy}
        onConfirm={async () => {
          if (editor?.kind === "dmarc" && (await run(z.zone.id, "PUT", "/mail/dmarc", { policy: editor.policy, rua: editor.rua.trim() || undefined, ...target }, t.mail.dmarcSaved))) setEditor(null);
        }}
      >
        {editor?.kind === "dmarc" && (
          <>
            <Select label={t.mail.policy} value={editor.policy} onValueChange={(v) => setEditor({ ...editor, policy: String(v) })} items={t.mail.policies} />
            <Input
              label={<>{t.mail.rua} <span className="font-normal text-kumo-subtle">{t.common.optional}</span></>}
              placeholder={`dmarc@${z.zone.name}`}
              value={editor.rua}
              onChange={(e) => setEditor({ ...editor, rua: e.target.value })}
              description={dmarcTags.rua ? t.mail.dmarcRuaKeep(dmarcTags.rua.replace(/^mailto:/, "")) : t.mail.ruaHint}
            />
            {!sub && (
              <div className="flex flex-wrap items-center gap-3 text-sm text-kumo-subtle">
                {t.mail.dmarcCfHint} <DeepLink href={dmarcManagement} label={t.mail.dmarcManagement} />
              </div>
            )}
          </>
        )}
      </ConfirmDialog>

      <ConfirmDialog
        open={fix === "protect-no-mail"}
        onOpenChange={(o) => !o && setFix(null)}
        title={t.mail.protectTitle(name)}
        description={t.mail.protectDescription}
        confirm={t.mail.protect}
        busy={busy}
        onConfirm={async () => {
          if (await run(z.zone.id, "POST", "/mail-fix", { fix: "protect-no-mail", ...target }, t.mail.protected)) setFix(null);
        }}
      >
        <ul className="list-disc pl-5 text-sm text-kumo-subtle">
          {/* On a subdomain: MX and SPF, DMARC only if it has its own; nothing on other names. */}
          {(sub ? t.mail.protectItems.slice(0, m.records.dmarc.length === 1 ? 3 : 2) : t.mail.protectItems).map((i) => (
            <li key={i}>{i}</li>
          ))}
        </ul>
      </ConfirmDialog>

      <ConfirmDialog
        open={fix === "add-dmarc"}
        onOpenChange={(o) => !o && setFix(null)}
        title={t.mail.dmarcTitle}
        description={t.mail.dmarcDescription}
        confirm={t.mail.add}
        busy={busy}
        onConfirm={async () => {
          if (await run(z.zone.id, "POST", "/mail-fix", { fix: "add-dmarc", policy, rua: rua.trim() || undefined, ...target }, t.mail.dmarcAdded)) setFix(null);
        }}
      >
        <Select label={t.mail.policy} value={policy} onValueChange={(v) => setPolicy(String(v))} items={t.mail.policies} />
        <Input label={t.mail.rua} placeholder={`dmarc@${z.zone.name}`} value={rua} onChange={(e) => setRua(e.target.value)} description={t.mail.ruaHint} />
        {!sub && (
          <div className="flex flex-wrap items-center gap-3 text-sm text-kumo-subtle">
            {t.mail.dmarcCfHint} <DeepLink href={dmarcManagement} label={t.mail.dmarcManagement} />
          </div>
        )}
      </ConfirmDialog>

      <ConfirmDialog
        open={fix === "add-spf"}
        onOpenChange={(o) => !o && setFix(null)}
        title={t.mail.spfTitle}
        description={t.mail.spfDescription(name, spfValue)}
        confirm={t.mail.add}
        busy={busy}
        onConfirm={async () => {
          if (await run(z.zone.id, "POST", "/mail-fix", { fix: "add-spf", ...target }, t.mail.spfAdded)) setFix(null);
        }}
      />
    </div>
  );
}

// --- DNS records (read only) ---

export function RecordsPanel({ z }: { z: ZoneDetail }) {
  const t = useT();
  const acc = z.zone.account.id;
  const records = displayRecords(z.records, z.customDomains);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex justify-end">
        <DeepLink href={dash.zone(z.zone.account.id, z.zone.name, "/dns/records")} />
      </div>
      <TableCard>
        <Table layout="auto">
          <Table.Header>
            <Table.Row>
              <Table.Head>{t.records.type}</Table.Head>
              <Table.Head>{t.records.name}</Table.Head>
              <Table.Head>{t.records.content}</Table.Head>
              <Table.Head>{t.records.proxy}</Table.Head>
              <Table.Head>{t.records.ttl}</Table.Head>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {records.map((r) => (
              <Table.Row key={r.key}>
                <Table.Cell className="font-mono text-xs">{r.type}</Table.Cell>
                <Table.Cell>{shortName(r.name, z.zone.name)}</Table.Cell>
                <Table.Cell className="max-w-[520px]">
                  <div className="flex min-w-0 items-center gap-2">
                    {r.worker !== undefined ? (
                      <Tooltip content={t.records.workerHint(r.worker || t.records.someWorker)}>
                        <span className="flex items-center gap-2">
                          <Badge variant="outline">Worker</Badge>
                          <a
                            className="font-medium text-kumo-link hover:underline"
                            href={dash.account(acc, r.worker ? `/workers/services/view/${r.worker}/production` : "/workers-and-pages")}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {r.worker || t.records.someWorker}
                          </a>
                        </span>
                      </Tooltip>
                    ) : (
                      <span className="truncate" title={r.content}>
                        {r.priority !== undefined && <span className="mr-1 text-kumo-subtle">{r.priority}</span>}
                        {r.content}
                      </span>
                    )}
                  </div>
                </Table.Cell>
                <Table.Cell>
                  {["A", "AAAA", "CNAME"].includes(r.type) ? (
                    r.proxied ? (
                      <Tooltip content={t.records.proxiedHint}>
                        <span className="cursor-help text-[#f6821f]">{t.records.proxied}</span>
                      </Tooltip>
                    ) : (
                      <span className="text-kumo-subtle">{t.records.dnsOnly}</span>
                    )
                  ) : (
                    ""
                  )}
                </Table.Cell>
                <Table.Cell className="text-kumo-subtle">{r.ttl === 1 ? t.records.auto : r.ttl}</Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table>
      </TableCard>
    </div>
  );
}

