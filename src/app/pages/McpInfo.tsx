import { ClipboardText, LayerCard } from "@cloudflare/kumo";
import { CheckIcon } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { useT } from "../i18n";

/** What people see when they open the MCP address in a browser: how to connect an assistant. */
export function McpInfo() {
  const t = useT();
  const url = `${location.origin}/mcp`;
  const Step = ({ title, children }: { title: string; children: ReactNode }) => (
    <div className="flex flex-col gap-2 px-4 py-4">
      <h2 className="text-sm font-semibold text-kumo-default">{title}</h2>
      {children}
    </div>
  );
  return (
    <div className="flex min-h-full flex-col items-center bg-kumo-canvas px-6 py-12">
      <div className="flex w-full max-w-xl flex-col gap-8">
        <div className="flex flex-col items-center gap-4 text-center">
          <a href="/">
            <img src="/logo.svg" alt="Dash++" className="size-16" />
          </a>
          <div>
            <h1 className="text-xl font-semibold text-kumo-default">{t.mcp.title}</h1>
            <p className="mt-2 text-sm text-kumo-subtle">{t.mcp.intro}</p>
          </div>
        </div>

        <LayerCard>
          <LayerCard.Secondary>{t.mcp.address}</LayerCard.Secondary>
          <LayerCard.Primary className="flex flex-col gap-2">
            <ClipboardText size="base" text={url} />
            <p className="text-sm text-kumo-subtle">{t.mcp.addressHint}</p>
          </LayerCard.Primary>
        </LayerCard>

        <LayerCard>
          <LayerCard.Secondary>{t.mcp.howTo}</LayerCard.Secondary>
          <LayerCard.Primary className="divide-y divide-kumo-hairline p-0">
            <Step title="Claude Code">
              <ClipboardText size="sm" text={`claude mcp add --transport http dash-plus-plus ${url}`} />
              <p className="text-sm text-kumo-subtle">{t.mcp.claudeCode}</p>
            </Step>
            <Step title={t.mcp.claudeApp}>
              <p className="text-sm text-kumo-subtle">{t.mcp.claudeAppText}</p>
            </Step>
            <Step title={t.mcp.other}>
              <p className="text-sm text-kumo-subtle">{t.mcp.otherText}</p>
            </Step>
          </LayerCard.Primary>
        </LayerCard>

        <LayerCard>
          <LayerCard.Secondary>{t.mcp.can}</LayerCard.Secondary>
          <LayerCard.Primary>
            <ul className="flex flex-col gap-2 text-sm">
              {t.mcp.abilities.map((a) => (
                <li key={a} className="flex items-start gap-2">
                  <CheckIcon size={16} className="mt-0.5 shrink-0 text-kumo-subtle" />
                  {a}
                </li>
              ))}
            </ul>
            <p className="mt-4 text-sm text-kumo-subtle">{t.mcp.safety}</p>
          </LayerCard.Primary>
        </LayerCard>

        <p className="text-center text-sm">
          <a href="/" className="text-kumo-link hover:underline">
            {t.mcp.open}
          </a>
        </p>
      </div>
    </div>
  );
}
