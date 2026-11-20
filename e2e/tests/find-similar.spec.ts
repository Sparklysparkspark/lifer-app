// U-11: "Keep all" and "Not similar" drop a similar group for good, and Undo brings it back.
// The e2e server has no CLIP model, so the spec stores the photos' vectors itself.
import pg from "pg";
import { LOCAL_DATABASE_URL } from "../support/constants.js";
import { SPECIES } from "../support/fixtureCatalog.js";
import { seedTrip } from "../support/library.js";
import { errorToasts, expect, test } from "../support/test.js";

const TRIP = "E2E Find Similar";
// EMBEDDING_MODEL_VERSION in packages/core/src/config.ts.
const MODEL_VERSION = "clip-vit-l14-v2";

test("keeps all of one group, marks another not similar, and undoes", async ({ page }) => {
  // Two bursts, a few seconds apart within each, of different species.
  const trip = await seedTrip(page.request, TRIP, [
    { file: "moose-1.jpg", species: SPECIES.moose, taken: "2020:06:01 06:17:00", tint: 195 },
    { file: "moose-2.jpg", species: SPECIES.moose, taken: "2020:06:01 06:17:05", tint: 196 },
    { file: "chickadee-1.jpg", species: SPECIES.chickadee, taken: "2020:06:01 07:17:00", tint: 197 },
    { file: "chickadee-2.jpg", species: SPECIES.chickadee, taken: "2020:06:01 07:17:05", tint: 198 },
  ]);
  const db = new pg.Client({ connectionString: process.env.E2E_DATABASE_URL ?? LOCAL_DATABASE_URL });
  await db.connect();
  try {
    for (const id of Object.values(trip.captureIds))
      await db.query(`INSERT INTO capture_embeddings (capture_id, embedding, model_version) VALUES ($1, $2, $3)`, [
        id,
        [1, 0, 0, 0],
        MODEL_VERSION,
      ]);
  } finally {
    await db.end();
  }

  const notifications = page.getByRole("region", { name: "Notifications" });
  const moose = page.getByRole("link", { name: new RegExp(SPECIES.moose.commonName) });
  const chickadee = page.getByRole("link", { name: new RegExp(SPECIES.chickadee.commonName) });

  await page.goto("/gallery/similar");
  await expect(page.getByText("2 groups, largest first")).toBeVisible();

  // Keep all: back to the list without the group; Undo opens it again.
  await moose.click();
  await expect(page.getByTestId("photo-tile")).toHaveCount(2);
  await page.getByRole("button", { name: "Keep all" }).click();
  await expect(page).toHaveURL(/\/gallery\/similar$/);
  await expect(notifications.getByText("Kept all of them. This group won't come back.")).toBeVisible();
  await expect(page.getByText("1 group, largest first")).toBeVisible();
  await expect(moose).toHaveCount(0);
  await notifications.getByRole("button", { name: "Undo" }).click();
  await expect(page).toHaveURL(/\/gallery\?similarTo=/);
  await expect(page.getByRole("button", { name: "Keep all" })).toBeVisible();
  await expect(page.getByTestId("photo-tile")).toHaveCount(2);

  // The visible way back to the list of groups.
  await page.getByRole("link", { name: "All similar photos" }).click();
  await expect(page.getByText("2 groups, largest first")).toBeVisible();

  // Not similar: gone for good, including after a reload.
  await chickadee.click();
  await page.getByRole("button", { name: "Not similar" }).click();
  await expect(notifications.getByText("Marked as not similar. This group won't come back.")).toBeVisible();
  await expect(page.getByText("1 group, largest first")).toBeVisible();
  await page.reload();
  await expect(page.getByText("1 group, largest first")).toBeVisible();
  await expect(chickadee).toHaveCount(0);
  await expect(moose).toBeVisible();
  await expect(errorToasts(page)).toHaveCount(0);
});
