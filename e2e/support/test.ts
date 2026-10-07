// The specs' `test`: Playwright's, plus a check that fails a test on any uncaught page error,
// console.error or error toast, so a page that breaks quietly still fails.
import { test as base, expect, type Page } from "@playwright/test";

interface PageProblems {
  /** Console errors matching this are expected by the test and not counted. */
  allowConsoleErrors: RegExp | null;
}

export const test = base.extend<PageProblems & { problems: string[]; offlineUpdateCheck: void }>({
  allowConsoleErrors: [null, { option: true }],
  // The update banner asks GitHub for the latest release on every page load, from the browser
  // rather than the server. Answered here with no release, so a run stays offline and never hits
  // GitHub's hourly limit for anonymous requests (which fails the run with a 403 console error).
  offlineUpdateCheck: [
    async ({ page }, use) => {
      await page.route("https://api.github.com/repos/*/*/releases/latest", (route) =>
        route.fulfill({ json: {}, headers: { "access-control-allow-origin": "*" } }),
      );
      await use();
    },
    { auto: true },
  ],
  // Automatic, so every test is checked whether or not it asks for the list.
  problems: [
    async ({ page, allowConsoleErrors }, use) => {
      const problems: string[] = [];
      page.on("pageerror", (err) => problems.push(`page error: ${err.message}`));
      page.on("console", (msg) => {
        if (msg.type() !== "error") return;
        // The resource URL is only in the location, so it's added for matching and reporting.
        const text = msg.location().url ? `${msg.text()} (${msg.location().url})` : msg.text();
        if (allowConsoleErrors?.test(text)) return;
        problems.push(`console.error: ${text}`);
      });
      await use(problems);
      expect(problems, "the page logged errors").toEqual([]);
      if (!page.isClosed()) await expectNoErrorToast(page);
    },
    { auto: true },
  ],
});

// Signed out, the only API call that should fail is a sign-in with the wrong password, which the
// API answers with a 401 the browser logs. Any other 401 means a signed-in request fired early.
export const WRONG_PASSWORD_401 = /status of 401 \(Unauthorized\) \(http:\/\/[^/]+\/api\/auth\/login\)$/;

/** Toasts live in the "Notifications" region (components/Toast.tsx); only error ones are alerts. */
export function errorToasts(page: Page) {
  return page.getByRole("region", { name: "Notifications" }).getByRole("alert");
}

export async function expectNoErrorToast(page: Page): Promise<void> {
  await expect(errorToasts(page), "an error toast is showing").toHaveCount(0);
}

export { expect };
