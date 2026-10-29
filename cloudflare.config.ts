import { bindings, defineConfig, triggers } from "cf/config";

import * as entrypoint from "./src/worker/index.ts" with { type: "cf-worker" };

// Installed with the Deploy to Cloudflare button, nothing needs setting: the account comes from the
// build and Dash++ answers on workers.dev. An installation of your own can set these in `.env`:
// DPP_ACCOUNT_ID, DPP_HOSTNAME (a custom domain), DPP_ADMIN_EMAILS (comma separated).
try {
  process.loadEnvFile(".env");
} catch {}
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? process.env.DPP_ACCOUNT_ID;
const hostname = process.env.DPP_HOSTNAME;
const admins = process.env.DPP_ADMIN_EMAILS;

export default defineConfig(({ mode }) => ({
  accountId,
  worker: {
    name: "dash-plus-plus",
    compatibilityDate: "2026-10-28",
    compatibilityFlags: ["nodejs_compat"],
    entrypoint,
    workersDev: !hostname,
    previewUrls: false,
    domains: hostname ? [hostname] : [],
    assets: {
      notFoundHandling: "single-page-application",
      runWorkerFirst: ["/api/*", "/auth/*"],
    },
    observability: { enabled: true },
    triggers: [triggers.scheduled({ schedule: "*/15 * * * *" })],
    env: {
      DB: bindings.d1({ name: "dash-plus-plus" }),
      PUBLIC_URL: !!hostname && bindings.text(`https://${hostname}`),
      ACCOUNT_ID: !!accountId && bindings.text(accountId),
      // Superadmins: open the setup page and enable accounts. Without them, the first to sign in.
      ADMIN_EMAILS: !!admins && bindings.text(admins),
      OAUTH_CLIENT_ID: bindings.text(process.env.DPP_OAUTH_CLIENT_ID ?? ""),
      SESSION_KEY: bindings.secret(),
      // An installation of your own may give these at deploy; otherwise they are set from the
      // setup page, which the install code opens until signing in works.
      OAUTH_CLIENT_SECRET: !!admins && bindings.secret(),
      SERVICE_TOKEN: !!admins && bindings.secret(),
      SETUP_CODE: !admins && bindings.secret(),
      // Solo in sviluppo locale (vedi docs/sviluppo.md): in produzione non esistono.
      DEV_TOKEN: mode === "development" && bindings.secret(),
      DEV_EMAIL: mode === "development" && bindings.secret(),
    },
  },
}));
