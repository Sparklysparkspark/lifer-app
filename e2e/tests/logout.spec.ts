// Signing in and out with the account the first-run spec made. Runs without the saved session,
// so it starts signed out, and runs last since logging out ends only its own session anyway.
import { ACCOUNT } from "../support/constants.js";
import { expect, WRONG_PASSWORD_401, test } from "../support/test.js";

test.use({ allowConsoleErrors: WRONG_PASSWORD_401 });

async function logIn(page: import("@playwright/test").Page, password: string): Promise<void> {
  await page.getByPlaceholder("Email").fill(ACCOUNT.email);
  await page.getByPlaceholder("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Log in" }).click();
}

test("logs in, logs out and logs back in", async ({ page }) => {
  // Signed out, every page sends you to the login form, which no longer offers account creation.
  await page.goto("/gallery");
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole("button", { name: "Log in" })).toBeVisible();
  await expect(page.getByPlaceholder("Confirm password")).toHaveCount(0);

  await logIn(page, "not the password");
  await expect(page.getByText("Invalid email or password")).toBeVisible();
  await expect(page).toHaveURL(/\/login$/);

  await logIn(page, ACCOUNT.password);
  await expect(page).toHaveURL(/\/(\?.*)?$/);
  await expect(page.getByText(/\d+ \/ \d+ collected/)).toBeVisible();

  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("button", { name: "Log out" }).click();
  await expect(page).toHaveURL(/\/login$/);

  // The session is gone on the server too, not just in the page: a reload stays signed out.
  await page.reload();
  await expect(page).toHaveURL(/\/login$/);
  await page.goto("/settings");
  await expect(page).toHaveURL(/\/login$/);

  await logIn(page, ACCOUNT.password);
  await expect(page).toHaveURL(/\/(\?.*)?$/);
  await page.getByRole("navigation").getByRole("link", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
});
