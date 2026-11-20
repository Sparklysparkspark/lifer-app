// U-10: Collection select mode. Select three whole groups, mark them seen in one bulk call, then
// Undo sends back exactly the species that changed (F3, D4).
import { expect, test } from "../support/test.js";

interface Bulk {
  action: string;
  speciesIds: string[];
}

test("selects three groups, marks them seen and undoes it", async ({ page }) => {
  // Family groups: the fixture's three listed species fall in three different families. Without
  // the pinned Photographed group, which repeats species from the families and selects with them.
  await page.goto("/?group=group&collectedFirst=0");
  await page.getByRole("button", { name: "Select", exact: true }).click();
  await expect(page.getByText("0 selected")).toBeVisible();

  const selectGroup = page.getByRole("button", { name: "Select group", exact: true });
  await expect.poll(() => selectGroup.count(), "groups on the page").toBeGreaterThanOrEqual(3);
  // Each click turns that button into Deselect group, so the first one left is always the next group.
  for (let i = 0; i < 3; i++) await selectGroup.first().click();
  await expect(page.getByRole("button", { name: "Deselect group", exact: true })).toHaveCount(3);
  const selected = Number((await page.getByText(/^\d+ selected$/).textContent())!.split(" ")[0]);
  expect(selected).toBeGreaterThanOrEqual(3);
  // D4: a Deselect all goes with every Select all.
  await expect(page.getByRole("button", { name: "Deselect all" })).toBeVisible();

  const seenCall = page.waitForRequest((r) => r.url().endsWith("/api/collection/bulk") && r.method() === "POST");
  await page.getByRole("button", { name: "Mark as seen" }).click();
  const seenReq = await seenCall;
  const seen = seenReq.postDataJSON() as Bulk;
  expect(seen.action).toBe("seen");
  expect(seen.speciesIds).toHaveLength(selected);
  const { changedIds } = (await (await seenReq.response())!.json()) as { changedIds: string[] };

  // One action leaves select mode and offers Undo in its toast.
  const toast = page.getByRole("region", { name: "Notifications" });
  await expect(toast.getByText(`Marked ${changedIds.length} species as seen.`)).toBeVisible();
  await expect(page.getByText(/^\d+ selected$/)).toHaveCount(0);
  if (changedIds.length === 0) return; // Already seen or photographed by earlier specs: nothing to undo.

  const undoCall = page.waitForRequest((r) => r.url().endsWith("/api/collection/bulk") && r.method() === "POST");
  await toast.getByRole("button", { name: "Undo" }).click();
  const undoReq = await undoCall;
  expect(undoReq.postDataJSON() as Bulk).toEqual({ action: "unseen", speciesIds: changedIds });
  const undone = (await (await undoReq.response())!.json()) as { changedIds: string[] };
  expect(undone.changedIds.sort()).toEqual([...changedIds].sort());
});
