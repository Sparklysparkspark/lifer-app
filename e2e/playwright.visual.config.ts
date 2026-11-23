// The visual tour and behavioural checks: the production build against the realistic fixture
// (support/realisticCatalog.ts), in Chromium and WebKit (the desktop app's macOS web view). See
// docs/docs/contributing/testing.md.
import { defineConfig, devices } from "@playwright/test";
import { API_PORT, BASE_URL } from "./support/constants";
import { VISUAL_AUTH_STATE } from "./visual/visual";

const CI = !!process.env.CI;
// CI runs only the behavioural and accessibility checks: screenshots differ by OS and fonts, and the baselines are made on macOS.
const BEHAVIOUR_ONLY = !!process.env.E2E_BEHAVIOUR_ONLY;

const signedIn = {
  storageState: VISUAL_AUTH_STATE,
  locale: "en-US",
  timezoneId: "UTC",
  colorScheme: "light" as const,
  reducedMotion: "reduce" as const,
};

export default defineConfig<{ allowPageErrors: RegExp | null }>({
  testDir: "visual",
  outputDir: "../test-results/visual",
  snapshotPathTemplate: "{testDir}/__screenshots__/{projectName}-{platform}/{arg}{ext}",
  // One server and database; the specs only read it (or undo what they change), so order doesn't matter.
  workers: 1,
  fullyParallel: false,
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  timeout: 120_000,
  expect: {
    timeout: 15_000,
    toHaveScreenshot: { maxDiffPixelRatio: 0.01, threshold: 0.2, animations: "disabled", caret: "hide" },
  },
  reporter: CI
    ? [["github"], ["list"], ["html", { open: "never", outputFolder: "../playwright-report/visual" }]]
    : [["list"], ["html", { open: "never", outputFolder: "../playwright-report/visual" }]],
  use: { baseURL: BASE_URL, trace: "retain-on-failure", screenshot: "only-on-failure" },
  projects: [
    { name: "seed", testMatch: "seed.setup.ts", retries: 0 },
    {
      name: "chromium",
      testMatch: BEHAVIOUR_ONLY ? /(behaviour|a11y)\.spec\.ts$/ : /\.spec\.ts$/,
      dependencies: ["seed"],
      use: { ...devices["Desktop Chrome"], ...signedIn },
    },
    {
      name: "webkit",
      testMatch: BEHAVIOUR_ONLY ? /(behaviour|a11y)\.spec\.ts$/ : /\.spec\.ts$/,
      dependencies: ["seed"],
      // WebKit reports this ResizeObserver notice as an uncaught error; it is not one.
      use: {
        ...devices["Desktop Safari"],
        ...signedIn,
        allowPageErrors: /^ResizeObserver loop completed with undelivered notifications\.$/,
      },
    },
  ],
  webServer: {
    command: "npx tsx support/startServer.ts",
    url: `${BASE_URL}/health`,
    reuseExistingServer: false,
    timeout: 300_000,
    stdout: "ignore",
    stderr: "pipe",
    gracefulShutdown: { signal: "SIGTERM", timeout: 20_000 },
    env: { E2E_PORT: String(API_PORT), E2E_FIXTURE: "realistic" },
  },
});
