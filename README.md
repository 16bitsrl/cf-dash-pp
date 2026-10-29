# Dash++

What the Cloudflare dashboard doesn't do: domain parking, redirects, email checks (MX, SPF, DKIM, DMARC), domain groups and a history of DNS changes. Everyone signs in with their own Cloudflare account and sees only what they would see in the dashboard. Built with Cloudflare's own design system.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/16bitsrl/cf-dash-pp)

## Install

1. Select **Deploy to Cloudflare**. Keep the Worker name `dash-plus-plus`. You are asked for two values:
   - `SESSION_KEY`: a long random string, for example from `openssl rand -hex 32`;
   - `SETUP_CODE`: a code of your choice, used once to open the setup page.
2. Open the address of the new Worker (`dash-plus-plus.<your-subdomain>.workers.dev`), select **Open setup** and type the setup code.
3. Connect Dash++ to Cloudflare: paste a temporary API token with the **OAuth Client Write** permission and Dash++ creates its sign-in client, or create the client by hand with the values shown.
4. Sign in with Cloudflare. The first person to sign in becomes the administrator and chooses which accounts Dash++ serves.

Optionally, connect a read-only token so Dash++ rereads every domain every 15 minutes, even when nobody has it open.

## An installation of your own

`npx cf deploy` reads these from `.env`, if present:

```ini
DPP_ACCOUNT_ID=<account id>
DPP_HOSTNAME=<custom domain, instead of workers.dev>
DPP_ADMIN_EMAILS=<comma separated administrators>
```

With `DPP_ADMIN_EMAILS` the setup code is not used, and the OAuth client secret and the shared token can also be given as Worker secrets (`OAUTH_CLIENT_SECRET`, `SERVICE_TOKEN`).

## Develop

```bash
npm install
npm test
npm run dev
```

Local development signs you in with a Cloudflare token from `.dev.vars` (`DEV_TOKEN`, `DEV_EMAIL`, `SESSION_KEY`).
