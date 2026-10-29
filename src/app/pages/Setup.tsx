import { Badge, Banner, Button, ClipboardText, Collapsible, Input, LayerCard, SensitiveInput, Switch } from "@cloudflare/kumo";
import { CheckCircleIcon } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { useState } from "react";
import { BackgroundToken } from "../components/Background";
import { Container, DeepLink, ErrorState, Loading, PageHeader } from "../components/ui";
import { useT } from "../i18n";
import { SETUP_CODE, useApi, type Me } from "../lib/api";
import { dash, useFormat } from "../lib/format";
import { useAction } from "../lib/hooks";

type SetupInfo = {
  publicUrl: string;
  accountId: string | null;
  redirectUri: string;
  scopes: string[];
  admins: string[];
  oauth: { configured: boolean; clientId: string | null; source: "setup" | "deploy" | null };
  service: { configured: boolean; source: "setup" | "deploy" | null; lastSync: { finished_at: number | null; zones: number | null } | null };
};

function Step({ title, state, children }: { title: string; state: "done" | "todo" | "optional"; children: ReactNode }) {
  const t = useT();
  return (
    <LayerCard>
      <LayerCard.Secondary className="flex items-center justify-between gap-2">
        <span>{title}</span>
        <Badge variant={state === "done" ? "success" : state === "todo" ? "warning" : "neutral"} appearance="dot">
          {state === "done" ? t.setup.done : state === "todo" ? t.setup.todo : t.setup.optional}
        </Badge>
      </LayerCard.Secondary>
      <LayerCard.Primary>
        <div className="flex flex-col gap-4 text-sm">{children}</div>
      </LayerCard.Primary>
    </LayerCard>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid items-center gap-1 sm:grid-cols-[220px_1fr]">
      <span className="text-kumo-subtle">{label}</span>
      <ClipboardText size="sm" text={value} />
    </div>
  );
}

export function Setup({ standalone }: { standalone?: boolean }) {
  const t = useT();
  const f = useFormat();
  const q = useApi<SetupInfo>("/setup");
  const me = useApi<Me>("/me");
  const { run, busy } = useAction();
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [token, setToken] = useState("");
  const [autoToken, setAutoToken] = useState("");
  const s = q.data;
  const oauthPage = s?.accountId ? dash.account(s.accountId, "/oauth-clients") : "https://dash.cloudflare.com/?to=/:account/oauth-clients";

  const manualSteps = s && (
    <ol className="flex list-decimal flex-col gap-4 pl-5">
          <li>
            <div className="flex flex-wrap items-center gap-3">
              {t.setup.step1} <DeepLink href={oauthPage} label={t.setup.openOauth} />
            </div>
          </li>
          <li>
            <p className="mb-2">{t.setup.step2}</p>
            <div className="flex flex-col gap-2">
              <Field label={t.setup.fieldName} value="Dash++" />
              <Field label={t.setup.fieldResponse} value="Code" />
              <Field label={t.setup.fieldGrants} value="Authorization Code, Refresh Token" />
              <Field label={t.setup.fieldAuth} value="Client Secret Basic" />
              <Field label={t.setup.fieldRedirect} value={s.redirectUri} />
              <Field label={t.setup.fieldClientUrl} value={s.publicUrl} />
              <div className="grid gap-1 sm:grid-cols-[220px_1fr]">
                <span className="text-kumo-subtle">{t.setup.fieldScopes}</span>
                <ul className="flex flex-wrap gap-1.5">
                  {s.scopes.map((sc) => (
                    <li key={sc}>
                      <Badge variant="outline" className="font-mono">
                        {sc}
                      </Badge>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </li>
          <li>
            <p className="mb-2">{t.setup.step3}</p>
            <form
              className="flex flex-col gap-3 sm:max-w-lg"
              onSubmit={async (e) => {
                e.preventDefault();
                if (await run("PUT", "/setup/oauth", { clientId, clientSecret }, t.setup.savedOauth)) {
                  setClientSecret("");
                  q.reload();
                }
              }}
            >
              <Input label={t.setup.clientId} value={clientId} onChange={(e) => setClientId(e.target.value)} autoComplete="off" />
              <SensitiveInput label={t.setup.clientSecret} value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} autoComplete="off" />
              <div className="flex gap-2">
                <Button type="submit" variant="primary" loading={busy} disabled={!clientId.trim() || !clientSecret.trim()}>
                  {t.setup.saveOauth}
                </Button>
              </div>
            </form>
          </li>
        </ol>
  );

  const serviceForm = (
    <>
        <div className="flex flex-wrap items-center gap-3">
          {t.setup.serviceStep} <DeepLink href="https://dash.cloudflare.com/profile/api-tokens" label={t.setup.openTokens} />
        </div>
        <ul className="flex flex-wrap gap-1.5">
          {t.setup.servicePerms.map((p) => (
            <li key={p}>
              <Badge variant="outline">{p}</Badge>
            </li>
          ))}
        </ul>
        <form
          className="flex flex-col gap-3 sm:max-w-lg"
          onSubmit={async (e) => {
            e.preventDefault();
            const res = await run<{ zones: number; done?: undefined }>("PUT", "/setup/service", { token }, (r) => t.setup.savedToken(r.zones));
            if (res) {
              setToken("");
              q.reload();
            }
          }}
        >
          <SensitiveInput label={t.setup.token} value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" />
          <div>
            <Button type="submit" variant="secondary" loading={busy} disabled={!token.trim()}>
              {t.setup.saveToken}
            </Button>
          </div>
        </form>
    </>
  );

  const body = q.error?.code === "login" && !s ? (
    <SetupCode onDone={q.reload} />
  ) : q.error && !s ? (
    <ErrorState error={q.error} onRetry={q.reload} />
  ) : !s ? (
    <Loading />
  ) : (
    <div className="flex flex-col gap-6">
      {s.oauth.configured && (
        <Banner
          icon={<CheckCircleIcon weight="fill" />}
          title={t.setup.ready}
          description={s.service.configured ? t.setup.readyText : t.setup.readyTextNoService}
          action={<Banner.Action onClick={() => (location.href = "/auth/login?return=/")}>{t.setup.tryLogin}</Banner.Action>}
        />
      )}
      {me.data && (
        <Step title={t.setup.accounts} state={me.data.accounts.some((a) => a.enabled) ? "done" : "todo"}>
          <p className="text-kumo-subtle">{t.setup.accountsText}</p>
          <ul className="divide-y divide-kumo-hairline rounded-lg border border-kumo-hairline">
            {me.data.accounts.map((a) => (
              <li key={a.id} className="flex flex-col gap-3 p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="font-medium">{a.name}</div>
                    <div className="text-kumo-subtle">{!a.enabled ? t.setup.statusOff : a.syncToken ? t.setup.statusOwn : s.service.configured ? t.setup.statusShared : t.setup.statusNone}</div>
                  </div>
                  <Switch
                    aria-label={t.setup.accountEnabled(a.name)}
                    checked={a.enabled}
                    disabled={busy}
                    onCheckedChange={async (on) => {
                      if (await run(on ? "POST" : "DELETE", `/accounts/${a.id}/tenant`, {}, on ? t.home.enabled : t.setup.disabled)) me.reload();
                    }}
                  />
                </div>
                {a.enabled && (
                  <Collapsible.Root>
                    <Collapsible.DefaultTrigger>{t.setup.connect}</Collapsible.DefaultTrigger>
                    <Collapsible.DefaultPanel>
                      <div className="pt-3">
                        <BackgroundToken acc={a.id} onSaved={me.reload} />
                      </div>
                    </Collapsible.DefaultPanel>
                  </Collapsible.Root>
                )}
              </li>
            ))}
          </ul>
        </Step>
      )}

      <Step title={t.setup.oauth} state={s.oauth.configured ? "done" : "todo"}>
        <p className="text-kumo-subtle">{t.setup.oauthText}</p>
        {s.oauth.configured && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-kumo-hairline bg-kumo-elevated p-4">
            <div className="flex items-start gap-3">
              <CheckCircleIcon size={20} weight="fill" className="mt-0.5 shrink-0 text-kumo-success" />
              <div>
                <div className="font-medium">{t.setup.oauthReady}</div>
                <div className="text-kumo-subtle">
                  {t.setup.clientId}: <span className="font-mono">{s.oauth.clientId}</span>. {s.oauth.source && t.setup.configuredFrom(s.oauth.source)}
                </div>
              </div>
            </div>
            <a href="/auth/login?return=/">
              <Button variant="primary">{t.setup.tryLogin}</Button>
            </a>
          </div>
        )}
        {s.accountId && !s.oauth.configured && (
          <div className="flex flex-col gap-3 rounded-lg border border-kumo-hairline p-4">
            <span className="font-medium">{t.setup.auto}</span>
            <p className="text-kumo-subtle">{t.setup.autoText}</p>
            <div className="flex flex-wrap items-center gap-3">
              <Badge variant="outline">{t.setup.autoPerm}</Badge>
              <DeepLink href="https://dash.cloudflare.com/profile/api-tokens" label={t.setup.openTokens} />
            </div>
            <form
              className="flex flex-col gap-3 sm:max-w-lg"
              onSubmit={async (e) => {
                e.preventDefault();
                if (await run("POST", "/setup/oauth/create", { token: autoToken }, t.setup.autoDone)) {
                  setAutoToken("");
                  q.reload();
                }
              }}
            >
              <SensitiveInput label={t.setup.token} value={autoToken} onChange={(e) => setAutoToken(e.target.value)} autoComplete="off" />
              <div>
                <Button type="submit" variant="primary" loading={busy} disabled={!autoToken.trim()}>
                  {t.setup.autoButton}
                </Button>
              </div>
            </form>
          </div>
        )}
        {s.oauth.configured ? (
          <Collapsible.Root>
            <Collapsible.DefaultTrigger>{t.setup.replaceOauth}</Collapsible.DefaultTrigger>
            <Collapsible.DefaultPanel>
              <div className="pt-3">{manualSteps}</div>
            </Collapsible.DefaultPanel>
          </Collapsible.Root>
        ) : (
          <>
            <span className="font-medium">{t.setup.manual}</span>
            {manualSteps}
          </>
        )}
      </Step>

      <Step title={t.setup.service} state={s.service.configured ? "done" : "optional"}>
        <p className="text-kumo-subtle">{t.setup.serviceText}</p>
        {s.service.configured && (
          <p>
            {s.service.source && t.setup.configuredFrom(s.service.source)} {s.service.lastSync?.finished_at ? t.setup.lastSync(f.ago(s.service.lastSync.finished_at), s.service.lastSync.zones ?? 0) : ""}
          </p>
        )}
        {s.service.configured ? (
          <Collapsible.Root>
            <Collapsible.DefaultTrigger>{t.setup.replaceToken}</Collapsible.DefaultTrigger>
            <Collapsible.DefaultPanel>
              <div className="flex flex-col gap-4 pt-3">{serviceForm}</div>
            </Collapsible.DefaultPanel>
          </Collapsible.Root>
        ) : (
          serviceForm
        )}
      </Step>

      <Step title={t.setup.admins} state={s.admins.length ? "done" : "todo"}>
        <p className="text-kumo-subtle">{s.admins.length ? t.setup.adminsText : t.setup.adminsFirst}</p>
        <ul className="font-mono">
          {s.admins.map((a) => (
            <li key={a}>{a}</li>
          ))}
        </ul>
      </Step>
    </div>
  );

  return (
    <div className={standalone ? "min-h-full bg-kumo-canvas" : ""}>
      {standalone && (
        <header className="flex h-[57px] items-center gap-3 border-b border-kumo-hairline px-6">
          <a href="/" className="flex items-center gap-3" data-external>
            <img src="/logo.svg" alt="" className="size-8" />
            <span className="text-[15px] font-semibold tracking-tight text-kumo-default">
              Dash<span className="text-[#f6821f]">++</span>
            </span>
          </a>
        </header>
      )}
      <PageHeader title={t.setup.title} description={t.setup.description} />
      <Container className="pt-6 pb-16">{body}</Container>
    </div>
  );
}

/** Before signing in works, the install code opens this page. */
function SetupCode({ onDone }: { onDone: () => void }) {
  const t = useT();
  const state = useApi<{ code: boolean }>("/setup/state");
  const [code, setCode] = useState("");
  const [wrong, setWrong] = useState(false);
  if (!state.data) return <Loading />;
  if (!state.data.code) return <Banner variant="alert" title={t.setup.notReady} description={t.setup.notReadyHint} />;
  return (
    <LayerCard>
      <LayerCard.Secondary>{t.setup.codeTitle}</LayerCard.Secondary>
      <LayerCard.Primary>
        <form
          className="flex flex-col gap-3 text-sm sm:max-w-lg"
          onSubmit={async (e) => {
            e.preventDefault();
            sessionStorage.setItem(SETUP_CODE, code.trim());
            const ok = await fetch("/api/setup", { headers: { "x-setup-code": code.trim() } }).then((r) => r.ok);
            if (!ok) sessionStorage.removeItem(SETUP_CODE);
            setWrong(!ok);
            if (ok) onDone();
          }}
        >
          <p className="text-kumo-subtle">{t.setup.codeText}</p>
          <SensitiveInput label={t.setup.codeTitle} value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off" error={wrong ? t.setup.codeWrong : undefined} />
          <div>
            <Button type="submit" variant="primary" disabled={!code.trim()}>
              {t.setup.codeButton}
            </Button>
          </div>
        </form>
      </LayerCard.Primary>
    </LayerCard>
  );
}
