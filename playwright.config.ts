// End-to-end browser tests: the production build against a scratch database, offline. See
// docs/docs/contributing/testing.md, and e2e/support/startServer.ts for what the server gets.
import { defineConfig, devices } from "@playwright/test";
import { API_PORT, AUTH_STATE_PATH, BASE_URL } from "./e2e/support/constants";

const CI = !!process.env.CI;

export default defineConfig({
  testDir: "e2e/tests",
  outputDir: "test-results",
  // One server and one database for the whole run, and the specs build on each other's state
  // (the account, the downloaded packs), so they run one at a time in a fixed order.
  workers: 1,
  fullyParallel: false,
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: CI ? [["github"], ["list"], ["html", { open: "never" }]] : [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    ...devices["Desktop Chrome"],
    // Dates and numbers render the same on every machine.
    locale: "en-US",
    timezoneId: "UTC",
  },
  projects: [
    // Creates the account through the UI on an empty server and completes onboarding. It can't
    // be retried: a retry would find the account already made.
    { name: "first-run", testMatch: "first-run.spec.ts", retries: 0 },
    {
      name: "signed-in",
      testIgnore: ["first-run.spec.ts", "logout.spec.ts"],
      dependencies: ["first-run"],
      use: { storageState: AUTH_STATE_PATH },
    },
    // Last, since it signs in and out on its own rather than using the saved session.
    { name: "sign-in", testMatch: "logout.spec.ts", dependencies: ["signed-in"] },
  ],
  webServer: {
    command: "npx tsx e2e/support/startServer.ts",
    url: `${BASE_URL}/health`,
    // Every run needs a fresh database, so a server left running is never reused.
    reuseExistingServer: false,
    // A first run may pull the Postgres image.
    timeout: 180_000,
    stdout: "ignore",
    stderr: "pipe",
    // SIGTERM lets the launcher stop the API and remove its container and temp files.
    gracefulShutdown: { signal: "SIGTERM", timeout: 20_000 },
    env: { E2E_PORT: String(API_PORT) },
  },
});
