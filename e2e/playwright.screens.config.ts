// The screenshot review harness (e2e/screens/screens.spec.ts). Run it with `npm run screens`.
import { defineConfig, devices } from "@playwright/test";
import { API_PORT, BASE_URL } from "./support/constants";

export default defineConfig({
  testDir: "screens",
  outputDir: "../test-results/screens-run",
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 600_000,
  reporter: [["list"]],
  use: { baseURL: BASE_URL, ...devices["Desktop Chrome"], locale: "en-US", timezoneId: "UTC", reducedMotion: "reduce" },
  webServer: {
    command: "npx tsx support/startServer.ts",
    url: `${BASE_URL}/health`,
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: "ignore",
    stderr: "pipe",
    gracefulShutdown: { signal: "SIGTERM", timeout: 20_000 },
    env: { E2E_PORT: String(API_PORT) },
  },
});
