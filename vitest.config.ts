import { defineConfig } from "vitest/config";

// Tests run in Node: without the Cloudflare plugin of vite.config.ts, which resolves modules for workerd.
export default defineConfig({});
