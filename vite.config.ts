import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

try {
  process.loadEnvFile(".env");
} catch {}

// Link previews need absolute addresses: the installation's own domain, if it has one.
const siteUrl = (): Plugin => ({
  name: "site-url",
  transformIndexHtml: (html) => {
    const host = process.env.DPP_HOSTNAME;
    if (host) return html.replaceAll("%SITE_URL%", `https://${host}`);
    return html.replace(/\s*<meta property="og:url"[^>]*>/, "").replaceAll("%SITE_URL%", "");
  },
});

export default defineConfig({
  plugins: [react(), tailwindcss(), cloudflare(), siteUrl()],
});
