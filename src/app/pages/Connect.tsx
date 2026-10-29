import { Banner, Button } from "@cloudflare/kumo";
import { CheckCircleIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { useT } from "../i18n";

type Info = { client: string; host: string; local: boolean };

/** Where a program connecting with MCP sends the person: they confirm, then sign in with Cloudflare. */
export function Connect() {
  const t = useT();
  const search = new URLSearchParams(location.search);
  const id = search.get("request");
  const [info, setInfo] = useState<Info | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "busy" | "denied" | "expired" | "client">(search.get("error") === "client" ? "client" : id ? "loading" : "expired");

  useEffect(() => {
    if (state !== "loading") return;
    fetch(`/oauth/request/${encodeURIComponent(id!)}`)
      .then((r) => (r.ok ? (r.json() as Promise<Info>) : Promise.reject()))
      .then((v: Info) => (setInfo(v), setState("ready")))
      .catch(() => setState("expired"));
  }, []);

  async function answer(what: "approve" | "deny") {
    setState("busy");
    const res = await fetch(`/oauth/request/${encodeURIComponent(id!)}/${what}`, { method: "POST", headers: { "x-dash-plus-plus": "1" } }).catch(() => null);
    const json = ((await res?.json().catch(() => null)) ?? {}) as { redirect?: string | null };
    if (!res?.ok) return setState("expired");
    if (json.redirect) location.href = json.redirect;
    if (what === "deny") setState("denied");
  }

  return (
    <div className="flex min-h-full flex-col items-center justify-center bg-kumo-canvas p-6">
      <div className="w-full max-w-sm flex-1 content-center">
        <div className="mb-8 flex flex-col items-center gap-4 text-center">
          <img src="/logo.svg" alt="" className="size-16" />
          {info && <h1 className="text-xl font-semibold text-kumo-default">{t.connect.title({ client: info.client })}</h1>}
        </div>
        {state === "expired" || state === "client" ? (
          <Banner variant="alert" icon={<WarningCircleIcon weight="fill" />} description={state === "client" ? t.connect.client : t.connect.expired} />
        ) : state === "denied" ? (
          <Banner icon={<CheckCircleIcon weight="fill" />} description={t.connect.denied} />
        ) : (
          info && (
            <div className="flex flex-col gap-4">
              <p className="text-sm text-kumo-default">{t.connect.text({ client: info.client })}</p>
              <p className="text-sm text-kumo-subtle">
                {info.local ? t.connect.backLocal : t.connect.back({ host: info.host })} {t.connect.unknown}
              </p>
              <div className="flex flex-col gap-2">
                <Button variant="primary" className="w-full justify-center" loading={state === "busy"} onClick={() => answer("approve")}>
                  {t.connect.allow}
                </Button>
                <Button variant="secondary" className="w-full justify-center" disabled={state === "busy"} onClick={() => answer("deny")}>
                  {t.connect.deny}
                </Button>
              </div>
            </div>
          )
        )}
      </div>
    </div>
  );
}
