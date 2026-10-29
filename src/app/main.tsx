import "@fontsource-variable/inter";
import "./styles.css";
import { Banner, Button, Toasty } from "@cloudflare/kumo";
import { WarningCircleIcon } from "@phosphor-icons/react";
import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { Shell } from "./components/Shell";
import { Container, ErrorState, Loading } from "./components/ui";
import { errorText, useT } from "./i18n";
import { useApi, useLoginNeeded, type Me } from "./lib/api";
import { useZonePrefetch } from "./lib/hooks";
import { navigate, parseRoute, useLinkInterception, useLocation } from "./lib/router";
import { Activity } from "./pages/Activity";
import { Connect } from "./pages/Connect";
import { McpInfo } from "./pages/McpInfo";
import { Domains } from "./pages/Domains";
import { Groups } from "./pages/Groups";
import { Home } from "./pages/Home";
import { Mail } from "./pages/Mail";
import { Parking } from "./pages/Parking";
import { Redirects } from "./pages/Redirects";
import { Setup } from "./pages/Setup";
import { ZonePage } from "./pages/Zone";

const LAST_ACCOUNT = "dpp:account";

function Login() {
  const t = useT();
  const state = useApi<{ configured: boolean; admin: boolean; code: boolean }>("/setup/state");
  const search = new URLSearchParams(location.search);
  const code = search.get("login_error");
  let params: Record<string, string> = {};
  try {
    params = JSON.parse(search.get("login_params") ?? "{}");
  } catch {}
  search.delete("login_error");
  search.delete("login_params");
  const ret = location.pathname + (search.size ? `?${search}` : "");
  return (
    <div className="flex min-h-full flex-col items-center justify-center bg-kumo-canvas p-6">
      <div className="w-full max-w-sm flex-1 content-center">
        <div className="mb-8 flex flex-col items-center gap-4 text-center">
          <img src="/logo.svg" alt="" className="size-16" />
          <div>
            <h1 className="text-xl font-semibold text-kumo-default">
              Dash<span className="text-[#f6821f]">++</span>
            </h1>
            <p className="mt-1 text-sm text-kumo-subtle">{t.login.tagline}</p>
          </div>
        </div>
        {code && <Banner className="mb-4" variant="error" icon={<WarningCircleIcon weight="fill" />} title={t.login.failed} description={errorText(t, code, params)} />}
        {state.data && !state.data.configured ? (
          <div className="flex flex-col gap-4">
            <Banner variant="alert" icon={<WarningCircleIcon weight="fill" />} title={t.setup.notReady} description={state.data.admin || state.data.code ? t.setup.notReadyAdmin : t.setup.notReadyHint} />
            {(state.data.admin || state.data.code) && (
              <a href="/setup" className="block">
                <Button variant="primary" className="w-full justify-center">
                  {t.setup.open}
                </Button>
              </a>
            )}
          </div>
        ) : (
          <>
            <a href={`/auth/login?return=${encodeURIComponent(ret || "/")}`} className="block">
              <Button variant="primary" className="w-full justify-center" disabled={!state.data}>
                {t.login.button}
              </Button>
            </a>
            <p className="mt-3 text-center text-xs text-kumo-subtle">{t.login.intro}</p>
          </>
        )}
      </div>
      <p className="text-xs text-kumo-subtle">{t.login.reserved}</p>
    </div>
  );
}

function App() {
  useLinkInterception();
  useZonePrefetch();
  const t = useT();
  const path = useLocation();
  const loginNeeded = useLoginNeeded();
  const isSetup = path.split("?")[0] === "/setup";
  const isConnect = path.split("?")[0] === "/connect" || path.split("?")[0] === "/mcp";
  const me = useApi<Me>(isSetup || isConnect ? null : "/me");
  const route = parseRoute(path);

  useEffect(() => {
    if (!me.data || isSetup || isConnect) return;
    const ids = me.data.accounts.map((a) => a.id);
    if (route.page === "root" || route.page === "notfound" || ("acc" in route && !ids.includes(route.acc))) {
      const last = localStorage.getItem(LAST_ACCOUNT);
      const acc = last && ids.includes(last) ? last : ids[0];
      if (acc) navigate(`/${acc}`, true);
    } else if ("acc" in route) {
      localStorage.setItem(LAST_ACCOUNT, route.acc);
    }
  }, [me.data, route, isSetup, isConnect]);

  if (isConnect) return path.startsWith("/mcp") ? <McpInfo /> : <Connect />;
  if (isSetup) return <Setup standalone />;
  if (loginNeeded || new URLSearchParams(location.search).has("login_error")) return <Login />;
  if (me.error)
    return (
      <Container className="py-16">
        <ErrorState error={me.error} onRetry={me.reload} />
      </Container>
    );
  if (!me.data || !("acc" in route) || !me.data.accounts.some((a) => a.id === route.acc)) {
    if (me.data && !me.data.accounts.length)
      return (
        <Container className="py-16">
          <ErrorState error={new Error(t.login.notEnabled)} />
        </Container>
      );
    return <Loading />;
  }

  const page = (() => {
    switch (route.page) {
      case "home":
        return <Home me={me.data} acc={route.acc} onMeChange={me.reload} />;
      case "domains":
        return <Domains acc={route.acc} />;
      case "parking":
        return <Parking acc={route.acc} />;
      case "redirects":
        return <Redirects acc={route.acc} />;
      case "mail":
        return <Mail acc={route.acc} />;
      case "groups":
        return <Groups acc={route.acc} />;
      case "activity":
        return <Activity acc={route.acc} />;
      case "zone":
        return <ZonePage acc={route.acc} zoneName={route.zone} tab={route.tab} />;
    }
  })();

  return (
    <Shell me={me.data} route={route}>
      {page}
    </Shell>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Toasty>
      <App />
    </Toasty>
  </StrictMode>,
);
