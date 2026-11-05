import { Button, SensitiveInput } from "@cloudflare/kumo";
import { CheckCircleIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { useT } from "../i18n";
import { useApi } from "../lib/api";
import { useFormat } from "../lib/format";
import { useAction } from "../lib/hooks";
import { DeepLink } from "./ui";

type Info = { enabled: boolean; configured: boolean; setAt: number | null; setBy: string | null; link: string; canManage: boolean };

/** Connects the account's own read-only token, so its domains stay up to date in the background. */
export function BackgroundToken({ acc, onSaved }: { acc: string; onSaved?: () => void }) {
  const t = useT();
  const f = useFormat();
  const q = useApi<Info>(`/accounts/${acc}/background`);
  const { run, busy } = useAction();
  const [token, setToken] = useState("");
  const s = q.data;
  if (!s) return null;

  return (
    <div className="flex flex-col gap-3 text-sm">
      {s.configured && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="flex items-center gap-2">
            <CheckCircleIcon size={18} weight="fill" className="shrink-0 text-kumo-success" />
            {t.background.connected(s.setBy ?? "", s.setAt ? f.ago(s.setAt) : "")}
          </span>
          {s.canManage && (
            <Button
              variant="secondary"
              size="sm"
              loading={busy}
              onClick={async () => {
                if (await run("DELETE", `/accounts/${acc}/background`, {}, t.background.removed)) {
                  q.reload();
                  onSaved?.();
                }
              }}
            >
              {t.background.remove}
            </Button>
          )}
        </div>
      )}
      {!s.canManage ? (
        <p className="text-kumo-subtle">{t.background.onlyAdmins}</p>
      ) : (
      <ol className="flex list-decimal flex-col gap-3 pl-5">
        <li>
          <div className="flex flex-wrap items-center gap-3">
            {t.background.step1} <DeepLink href={s.link} label={t.background.create} />
          </div>
        </li>
        <li>
          <p className="mb-2">{t.background.step2}</p>
          <form
            className="flex flex-col gap-3 sm:max-w-lg"
            onSubmit={async (e) => {
              e.preventDefault();
              if (await run<{ zones: number; done?: undefined }>("PUT", `/accounts/${acc}/background`, { token }, (r) => t.background.saved(r.zones))) {
                setToken("");
                q.reload();
                onSaved?.();
              }
            }}
          >
            <SensitiveInput label={t.setup.token} value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" />
            <div>
              <Button type="submit" variant="primary" loading={busy} disabled={!token.trim()}>
                {t.setup.saveToken}
              </Button>
            </div>
          </form>
        </li>
      </ol>
      )}
    </div>
  );
}
