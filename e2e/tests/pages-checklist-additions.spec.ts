// Adding a species to a checklist yourself, from both places the app offers it: the region's
// checklist ("+ Add a species", by search) and a species page ("Add to another checklist", by
// region or sea zone). The fixture's robin is on Canada's checklist but not British Columbia's,
// so it's the species added. Each addition is removed again, leaving the checklist as it was.
import { COUNTRY, PACKLESS_COUNTRY, PROVINCE, SEA_ZONE, SPECIES } from "../support/fixtureCatalog.js";
import { speciesId } from "../support/library.js";
import { expect, test } from "../support/test.js";

const robin = SPECIES.robin.commonName;

async function regionIdByName(request: import("@playwright/test").APIRequestContext, name: string): Promise<string> {
  const regions = (await (await request.get("/api/regions")).json()) as {
    regions: Array<{ id: string; name: string }>;
  };
  return regions.regions.find((r) => r.name === name)!.id;
}

test("adds a species to a province's checklist and removes it, from the checklist and the species page", async ({
  page,
}) => {
  const regions = (await (await page.request.get("/api/regions")).json()) as {
    regions: Array<{ id: string; name: string }>;
  };
  const provinceId = regions.regions.find((r) => r.name === PROVINCE.name)!.id;
  const robinId = await speciesId(page.request, SPECIES.robin);
  // The robin's card on the checklist (its link carries the species id).
  const robinCard = page.locator(`main a[href^="/species/${robinId}"]`);

  // --- From the region's checklist ---
  await page.goto(`/?region=${provinceId}`);
  await expect(page.getByText(SPECIES.moose.commonName).first()).toBeVisible();
  await expect(robinCard).toHaveCount(0);

  await page.getByRole("button", { name: "+ Add a species" }).click();
  const dialog = page.getByRole("dialog", { name: `Add a species to ${PROVINCE.name}` });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("combobox", { name: "Search species to add…" }).fill("robin");
  // Keyboard only: arrow to the match and pick it with Enter.
  await expect(dialog.getByRole("option", { name: new RegExp(robin) })).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Enter");
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText(`Added ${robin} to ${PROVINCE.name}'s checklist.`)).toBeVisible();

  await expect(robinCard).toBeVisible();
  await expect(robinCard.getByText("Added by you")).toBeVisible();
  // The catalog's own entries carry no such label.
  await expect(page.locator("main").getByText("Added by you")).toHaveCount(1);

  // It stays after a reload: it's saved on the server.
  await page.reload();
  await expect(robinCard.getByText("Added by you")).toBeVisible();

  await robinCard.getByRole("button", { name: "More options" }).click();
  await robinCard.getByRole("button", { name: "Remove from this checklist" }).click();
  await expect(page.getByText(`Removed ${robin} from ${PROVINCE.name}'s checklist.`)).toBeVisible();
  await expect(robinCard).toHaveCount(0);
  await expect(page.getByText(SPECIES.moose.commonName).first()).toBeVisible();

  // --- From the species page ---
  await page.goto(`/species/${robinId}`);
  await expect(page.getByRole("heading", { level: 1, name: robin })).toBeVisible();
  const toggle = page.getByRole("button", { name: "Add to another checklist" });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  const panel = page.getByRole("group", { name: "Add to another checklist" });

  // World and continents have no checklist of their own, so Add waits for a country or province.
  await panel.getByRole("button", { name: "Browse by region →" }).click();
  await expect(panel.getByText("World has no checklist of its own.", { exact: false })).toBeVisible();
  await expect(panel.getByRole("button", { name: "Add", exact: true })).toBeDisabled();
  await panel.getByRole("button", { name: "North America" }).click();
  await panel.getByRole("button", { name: "Canada" }).click();
  await panel.getByRole("button", { name: PROVINCE.name }).click();
  await panel.getByRole("button", { name: `Add to ${PROVINCE.name}` }).click();
  await expect(page.getByText(`Added ${robin} to ${PROVINCE.name}'s checklist.`)).toBeVisible();
  await expect(panel).toHaveCount(0);

  const added = page.getByRole("list", { name: "Checklists you added this species to" });
  await expect(added.getByRole("link", { name: PROVINCE.name })).toBeVisible();

  // The link opens that checklist, where the robin now shows as added by you.
  await added.getByRole("link", { name: PROVINCE.name }).click();
  await expect(page).toHaveURL(new RegExp(`region=${provinceId}`));
  await expect(robinCard.getByText("Added by you")).toBeVisible();

  await page.goBack();
  await page.getByRole("button", { name: `Remove from ${PROVINCE.name}'s checklist` }).click();
  await expect(page.getByText(`Removed ${robin} from ${PROVINCE.name}'s checklist.`)).toBeVisible();
  await expect(added).toHaveCount(0);

  await page.goto(`/?region=${provinceId}`);
  await expect(page.getByText(SPECIES.moose.commonName).first()).toBeVisible();
  await expect(robinCard).toHaveCount(0);
});

test("shows the species you added on a country whose pack isn't downloaded, with the download still offered", async ({
  page,
}) => {
  const countryId = await regionIdByName(page.request, PACKLESS_COUNTRY.name);
  const robinId = await speciesId(page.request, SPECIES.robin);
  const robinCard = page.locator(`main a[href^="/species/${robinId}"]`);
  const prompt = page.getByRole("heading", { name: `${PACKLESS_COUNTRY.name}'s checklist isn't downloaded yet` });

  await page.goto(`/?region=${countryId}`);
  await expect(prompt).toBeVisible();
  await expect(robinCard).toHaveCount(0);

  // Adding doesn't wait for the pack.
  await page.getByRole("button", { name: "+ Add a species" }).click();
  const dialog = page.getByRole("dialog", { name: `Add a species to ${PACKLESS_COUNTRY.name}` });
  await dialog.getByRole("combobox", { name: "Search species to add…" }).fill("robin");
  await dialog.getByRole("option", { name: new RegExp(robin) }).click();
  await expect(page.getByText(`Added ${robin} to ${PACKLESS_COUNTRY.name}'s checklist.`)).toBeVisible();

  // The robin shows, marked, under the download prompt, which stays.
  await expect(robinCard.getByText("Added by you")).toBeVisible();
  await expect(prompt).toBeVisible();
  await expect(page.getByText("Below are the species you've photographed here or added yourself.")).toBeVisible();
  await page.reload();
  await expect(robinCard.getByText("Added by you")).toBeVisible();

  await robinCard.getByRole("button", { name: "More options" }).click();
  await robinCard.getByRole("button", { name: "Remove from this checklist" }).click();
  await expect(page.getByText(`Removed ${robin} from ${PACKLESS_COUNTRY.name}'s checklist.`)).toBeVisible();
  await expect(robinCard).toHaveCount(0);
  await expect(prompt).toBeVisible();
});

test("adds a species to a sea zone from the species page, and shows it with that water ticked", async ({ page }) => {
  const robinId = await speciesId(page.request, SPECIES.robin);
  const robinCard = page.locator(`main a[href^="/species/${robinId}"]`);

  await page.goto(`/species/${robinId}`);
  await page.getByRole("button", { name: "Add to another checklist" }).click();
  const panel = page.getByRole("group", { name: "Add to another checklist" });
  await panel.getByRole("button", { name: "Sea zone" }).click();
  await panel.getByRole("textbox", { name: "Search sea zones" }).fill("alaska");
  await panel.getByRole("button", { name: SEA_ZONE.name }).click();
  await panel.getByRole("button", { name: `Add to ${SEA_ZONE.name}` }).click();
  await expect(page.getByText(`Added ${robin} to the ${SEA_ZONE.name} checklist.`)).toBeVisible();

  const added = page.getByRole("list", { name: "Checklists you added this species to" });
  await expect(added.getByText("(sea)")).toBeVisible();
  // The link opens the nearby country with only that water ticked, where the robin is marked as
  // added by you even though Canada's own checklist lists it.
  await added.getByRole("link", { name: SEA_ZONE.name }).click();
  await expect(page).toHaveURL(/includeLand=0/);
  await expect(page.getByRole("checkbox", { name: SEA_ZONE.name })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: `Include ${COUNTRY.name}'s own species` })).not.toBeChecked();
  await expect(robinCard.getByText("Added by you")).toBeVisible();
  await expect(page.locator("main").getByText("Added by you")).toHaveCount(1);

  await robinCard.getByRole("button", { name: "More options" }).click();
  await robinCard.getByRole("button", { name: "Remove from this checklist" }).click();
  await expect(page.getByText(`Removed ${robin} from the ${SEA_ZONE.name} checklist.`)).toBeVisible();
  // Nothing of yours is left in that water, so it's no longer offered, and Canada's own list,
  // robin included, comes back.
  await expect(page.getByRole("checkbox", { name: SEA_ZONE.name })).toHaveCount(0);
  await expect(robinCard).toBeVisible();
  await expect(page.locator("main").getByText("Added by you")).toHaveCount(0);
});
