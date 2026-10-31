import { defineConfig } from "vitest/config";

// Tests run in Node: without the Cloudflare plugin of vite.config.ts, which resolves modules for workerd.
// The HTTP tests start workerd for D1, slower on small machines.
export default defineConfig({ test: { testTimeout: 30_000, hookTimeout: 30_000 } });
