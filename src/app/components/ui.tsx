import { Badge, Banner, CloudflareLogo, Empty, Loader } from "@cloudflare/kumo";
import {
  ArrowBendUpRightIcon,
  ArrowSquareOutIcon,
  CheckCircleIcon,
  CheckIcon,
  CircleDashedIcon,
  ClockIcon,
  GlobeIcon,
  InfoIcon,
  PauseIcon,
  QuestionIcon,
  SignpostIcon,
  WarningCircleIcon,
  WarningIcon,
} from "@phosphor-icons/react";
import type { ReactNode } from "react";
import type { Level } from "../../worker/lib/mail";
import { useT } from "../i18n";
import type { CachedZone, Usage } from "../lib/api";

export function Container({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`mx-auto w-full max-w-[1200px] px-6 lg:px-8 ${className}`}>{children}</div>;
}

export function PageHeader({ title, description, pill, actions, breadcrumbs, children }: { title: ReactNode; description?: ReactNode; pill?: ReactNode; actions?: ReactNode; breadcrumbs?: ReactNode; children?: ReactNode }) {
  return (
    <div className="border-b border-kumo-hairline">
      <Container className={children ? "pt-8" : "py-8"}>
        {breadcrumbs && <div className="mb-3">{breadcrumbs}</div>}
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <h1 className="max-w-full truncate text-xl font-semibold text-kumo-default">{title}</h1>
              {pill}
            </div>
            {description && <div className="mt-1 text-sm text-kumo-subtle">{description}</div>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </div>
        {children}
      </Container>
    </div>
  );
}

/** The dashboard's "View docs" pill, here to open the same page in Cloudflare. */
export function DashPill({ href }: { href: string }) {
  const t = useT();
  return (
    <a href={href} target="_blank" rel="noreferrer" aria-label={t.common.openInCloudflare} className="inline-flex items-center gap-1 rounded-full border border-kumo-line px-2 py-0.5 text-xs text-kumo-default hover:bg-kumo-tint">
      <CloudflareLogo variant="glyph" className="w-3.5" />
      <span className="hidden sm:inline">{t.common.openInCloudflare}</span>
      <ArrowSquareOutIcon size={12} />
    </a>
  );
}

/** Link to the page of the Cloudflare dashboard that goes further than Dash++. */
export function DeepLink({ href, label, cloudflare = true }: { href: string; label?: string; cloudflare?: boolean }) {
  const t = useT();
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      aria-label={label ?? t.common.deepDive}
      className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-kumo-line bg-kumo-base px-2 py-1 text-xs font-medium text-kumo-default shadow-xs hover:bg-kumo-tint"
    >
      {cloudflare && <CloudflareLogo variant="glyph" className="w-4" />}
      {label ?? <span className="hidden sm:inline">{t.common.deepDive}</span>}
      <ArrowSquareOutIcon size={12} className="text-kumo-subtle" />
    </a>
  );
}

export function ZoneStatus({ status, paused }: { status: string; paused?: boolean }) {
  const t = useT();
  if (paused)
    return (
      <span className="inline-flex items-center gap-1.5 text-sm text-kumo-default">
        <PauseIcon size={14} /> {t.status.paused}
      </span>
    );
  if (status === "active")
    return (
      <span className="inline-flex items-center gap-1.5 text-sm text-kumo-default">
        <CheckIcon size={14} /> {t.status.active}
      </span>
    );
  return (
    <span className="inline-flex items-center gap-1.5 text-sm text-kumo-warning">
      <ClockIcon size={14} /> {status === "pending" ? t.status.pending : status}
    </span>
  );
}

const USAGE: Record<Usage, { icon: typeof InfoIcon; className: string }> = {
  parked: { icon: SignpostIcon, className: "text-kumo-default" },
  "parking-partial": { icon: WarningIcon, className: "text-kumo-warning" },
  redirect: { icon: ArrowBendUpRightIcon, className: "text-kumo-default" },
  site: { icon: GlobeIcon, className: "text-kumo-default" },
  empty: { icon: CircleDashedIcon, className: "text-kumo-subtle" },
  unknown: { icon: QuestionIcon, className: "text-kumo-subtle" },
};

export function UsageBadge({ usage, target }: { usage: Usage | null | undefined; target?: string | null }) {
  const t = useT();
  if (!usage) return <span className="text-kumo-inactive">—</span>;
  const u = USAGE[usage];
  return (
    <span className={`inline-flex min-w-0 items-center gap-1.5 text-sm ${u.className}`}>
      <u.icon size={15} className="shrink-0" />
      <span className="shrink-0">{t.usage[usage]}</span>
      {usage === "redirect" && target && <span className="truncate text-kumo-subtle">→ {target.replace(/^https?:\/\//, "")}</span>}
      {usage === "site" && target && <span className="truncate text-kumo-subtle">· {t.usage.worker(target)}</span>}
    </span>
  );
}

export function MailBadge({ mail }: { mail: CachedZone["mail"] | null | undefined }) {
  const t = useT();
  if (!mail?.mode) return <span className="text-kumo-inactive">—</span>;
  const issues = (mail.errors ?? 0) + (mail.warnings ?? 0);
  if (mail.errors)
    return (
      <Badge variant="error" appearance="dot">
        {t.mailBadge.problems(issues)}
      </Badge>
    );
  if (mail.warnings)
    return (
      <Badge variant="warning" appearance="dot">
        {t.mailBadge.warnings(issues)}
      </Badge>
    );
  if (mail.mode === "protected")
    return (
      <Badge variant="success" appearance="dot">
        {t.mailBadge.protected}
      </Badge>
    );
  if (mail.mode === "none")
    return (
      <Badge variant="neutral" appearance="dot">
        {t.mailBadge.none}
      </Badge>
    );
  return (
    <Badge variant="success" appearance="dot">
      {mail.provider ?? t.mailBadge.active}
    </Badge>
  );
}

const LEVEL: Record<Level, { icon: typeof InfoIcon; className: string }> = {
  error: { icon: WarningCircleIcon, className: "text-kumo-danger" },
  warning: { icon: WarningIcon, className: "text-kumo-warning" },
  info: { icon: InfoIcon, className: "text-kumo-info" },
  ok: { icon: CheckCircleIcon, className: "text-kumo-success" },
};

export function LevelIcon({ level, size = 18 }: { level: Level; size?: number }) {
  const t = useT();
  const L = LEVEL[level];
  return <L.icon size={size} weight="fill" className={`shrink-0 ${L.className}`} aria-label={t.level[level]} />;
}

export function Loading({ label }: { label?: string }) {
  const t = useT();
  return (
    <div className="flex items-center justify-center gap-2 py-16 text-sm text-kumo-subtle">
      <Loader size={16} /> {label ?? t.common.loading}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: Error; onRetry?: () => void }) {
  const t = useT();
  return (
    <Banner
      variant="error"
      icon={<WarningCircleIcon weight="fill" />}
      title={t.common.cantLoad}
      description={error.message}
      action={onRetry && <Banner.Action onClick={onRetry}>{t.common.retry}</Banner.Action>}
    />
  );
}

export function EmptyState({ title, description, icon }: { title: string; description?: string; icon?: ReactNode }) {
  return <Empty size="sm" icon={icon} title={title} description={description} />;
}

/** Table container as in the dashboard: thin border, rounded corners. */
export function TableCard({ children }: { children: ReactNode }) {
  return <div className="dpp-table overflow-x-auto rounded-lg border border-kumo-hairline bg-kumo-base">{children}</div>;
}
