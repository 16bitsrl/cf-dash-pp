import { Badge, Button, LayerCard } from "@cloudflare/kumo";
import {
  ArrowBendUpRightIcon,
  CheckCircleIcon,
  ClockCounterClockwiseIcon,
  EnvelopeSimpleIcon,
  FoldersIcon,
  type Icon,
  LockKeyIcon,
  PlugsConnectedIcon,
  ShieldCheckIcon,
  SignpostIcon,
  WarningCircleIcon,
  CloudCheckIcon,
} from "@phosphor-icons/react";
import { LANGS, setLang, useLang, useT, type Lang } from "../i18n";

const FEATURE_ICONS: Icon[] = [SignpostIcon, ArrowBendUpRightIcon, EnvelopeSimpleIcon, FoldersIcon, ClockCounterClockwiseIcon, PlugsConnectedIcon];
const TRUST_ICONS: Icon[] = [LockKeyIcon, CloudCheckIcon, ShieldCheckIcon];

/** What people who aren't signed in see at the home page: what Dash++ does and how to get in. */
export function Landing() {
  const t = useT();
  const lang = useLang();
  const l = t.landing;
  const login = `/auth/login?return=${encodeURIComponent("/")}`;

  return (
    <div className="flex min-h-full flex-col bg-kumo-canvas">
      <header className="border-b border-kumo-hairline bg-kumo-base">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-4 px-6">
          <a href="/" className="flex items-center gap-2.5">
            <img src="/logo.svg" alt="" className="size-7" />
            <span className="font-semibold text-kumo-default">
              Dash<span className="text-[#f6821f]">++</span>
            </span>
          </a>
          <div className="flex items-center gap-3">
            <div className="flex text-xs">
              {(Object.keys(LANGS) as Lang[]).map((k) => (
                <button key={k} type="button" onClick={() => setLang(k)} className={`rounded px-2 py-1 uppercase ${k === lang ? "font-semibold text-kumo-default" : "text-kumo-subtle hover:text-kumo-default"}`} aria-pressed={k === lang} title={LANGS[k].label}>
                  {k}
                </button>
              ))}
            </div>
          </div>
        </div>
      </header>

      <main className="flex-1">
        <section className="mx-auto grid max-w-6xl items-center gap-12 px-6 py-16 md:py-24 lg:grid-cols-[1.1fr_1fr]">
          <div className="flex flex-col items-start gap-6">
            <span className="text-sm font-medium text-kumo-subtle">{l.eyebrow}</span>
            <h1 className="text-4xl font-semibold tracking-tight text-balance text-kumo-default md:text-5xl">{l.title}</h1>
            <p className="max-w-xl text-lg text-pretty text-kumo-subtle">{l.intro}</p>
            <div className="flex flex-wrap gap-3">
              <a href={login}>
                <Button variant="primary" size="lg">
                  {l.cta}
                </Button>
              </a>
              <a href="mailto:hello@16bit.it" data-external>
                <Button size="lg" icon={<EnvelopeSimpleIcon />}>
                  {l.contact}
                </Button>
              </a>
            </div>
            <div className="flex flex-col gap-2 text-sm text-kumo-subtle">
              <p>{l.ctaHint}</p>
              <p className="flex flex-wrap items-center gap-2">
                <Badge variant="beta">{l.soon}</Badge>
                {l.installSoon}
              </p>
            </div>
          </div>
          <Preview />
        </section>

        <section className="border-t border-kumo-hairline bg-kumo-base">
          <div className="mx-auto max-w-6xl px-6 py-16 md:py-20">
            <h2 className="text-2xl font-semibold tracking-tight text-kumo-default">{l.featuresTitle}</h2>
            <div className="mt-10 grid gap-x-10 gap-y-10 sm:grid-cols-2 lg:grid-cols-3">
              {l.features.map((f, i) => {
                const I = FEATURE_ICONS[i];
                return (
                  <div key={f.title} className="flex flex-col gap-2">
                    <span className="flex size-9 items-center justify-center rounded-lg border border-kumo-hairline bg-kumo-canvas text-kumo-brand">
                      <I size={20} />
                    </span>
                    <h3 className="mt-2 font-semibold text-kumo-default">{f.title}</h3>
                    <p className="text-sm text-pretty text-kumo-subtle">{f.text}</p>
                  </div>
                );
              })}
            </div>
          </div>
        </section>

        <section className="border-t border-kumo-hairline">
          <div className="mx-auto max-w-6xl px-6 py-16 md:py-20">
            <h2 className="text-2xl font-semibold tracking-tight text-kumo-default">{l.trustTitle}</h2>
            <div className="mt-10 grid gap-4 md:grid-cols-3">
              {l.trust.map((f, i) => {
                const I = TRUST_ICONS[i];
                return (
                  <LayerCard key={f.title}>
                    <LayerCard.Primary className="flex h-full flex-col gap-2">
                      <I size={22} className="text-kumo-subtle" />
                      <h3 className="mt-1 font-semibold text-kumo-default">{f.title}</h3>
                      <p className="text-sm text-pretty text-kumo-subtle">{f.text}</p>
                    </LayerCard.Primary>
                  </LayerCard>
                );
              })}
            </div>
          </div>
        </section>
        <section className="border-t border-kumo-hairline bg-kumo-base">
          <div className="mx-auto flex max-w-6xl flex-col items-start gap-3 px-6 py-16 md:py-20">
            <img src="/brand/16bit.png" alt="16bit" className="mb-3 h-12 w-auto" />
            <h2 className="text-2xl font-semibold tracking-tight text-kumo-default">{l.byTitle}</h2>
            <p className="text-pretty text-kumo-subtle">
              {l.byText.map((line) => (
                <span key={line} className="block">
                  {line}
                </span>
              ))}
            </p>
            <div className="mt-4 flex flex-wrap items-center gap-4">
              <span className="font-medium text-kumo-default">{l.byAsk}</span>
              <a href="mailto:hello@16bit.it" data-external>
                <Button icon={<EnvelopeSimpleIcon />}>{l.contact}</Button>
              </a>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-kumo-hairline bg-kumo-base">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-6 py-8 text-sm text-kumo-subtle">
          <a href="https://16bit.it" target="_blank" rel="noreferrer" className="hover:text-kumo-default">
            16bit.it
          </a>
          <p>
            © {new Date().getFullYear()} 16bit Srl · P.IVA 09662570960 · {l.disclaimer}
          </p>
        </div>
      </footer>
    </div>
  );
}

/** A made-up domain, drawn with the panel's own pieces, to show what Dash++ looks like. */
function Preview() {
  const m = useT().landing.mock;
  const checks = ["MX", "SPF", "DKIM"];
  return (
    <div aria-hidden className="pointer-events-none select-none">
      <LayerCard className="shadow-sm">
        <LayerCard.Secondary className="flex items-center justify-between">
          <span className="font-medium text-kumo-default">{m.domain}</span>
          <Badge variant="success">{m.parked}</Badge>
        </LayerCard.Secondary>
        <LayerCard.Primary className="flex flex-col divide-y divide-kumo-hairline p-0 text-sm">
          <div className="flex items-center gap-3 px-4 py-3">
            <ArrowBendUpRightIcon size={18} className="shrink-0 text-kumo-subtle" />
            <span className="text-kumo-default">{m.redirect}</span>
            <span className="ml-auto text-kumo-subtle">301</span>
          </div>
          <div className="flex flex-col gap-2.5 px-4 py-3">
            <span className="flex items-center gap-3 text-kumo-default">
              <EnvelopeSimpleIcon size={18} className="shrink-0 text-kumo-subtle" />
              {m.mail}
            </span>
            <div className="flex flex-wrap gap-2 pl-[30px]">
              {checks.map((c) => (
                <span key={c} className="flex items-center gap-1.5 rounded-md border border-kumo-hairline px-2 py-1 text-xs">
                  <CheckCircleIcon size={14} weight="fill" className="text-kumo-success" />
                  {c} {m.ok}
                </span>
              ))}
            </div>
            <div className="ml-[30px] flex items-center gap-2 rounded-md bg-kumo-warning-tint px-3 py-2 text-xs">
              <WarningCircleIcon size={16} weight="fill" className="shrink-0 text-kumo-warning" />
              <span className="text-kumo-default">{m.dmarc}</span>
              <Button size="xs" className="ml-auto" tabIndex={-1}>
                {m.fix}
              </Button>
            </div>
          </div>
          <div className="flex items-center gap-3 px-4 py-3 text-kumo-subtle">
            <ClockCounterClockwiseIcon size={18} className="shrink-0" />
            {m.changed}
          </div>
        </LayerCard.Primary>
      </LayerCard>
    </div>
  );
}
