// eBird checklists (I-07): import My eBird Data, match a trip's photo to its checklist, confirm the
// link, and open the checklist on eBird from the trip and from the photo. eBird itself is never
// reached: the new tab's request is answered here.
import { writeFileSync } from "node:fs";
import type { BrowserContext, Page } from "@playwright/test";
import { SPECIES } from "../support/fixtureCatalog.js";
import { seedTrip } from "../support/library.js";
import { expect, test } from "../support/test.js";

const SUB_ID = "S9100001";
const CHECKLIST_URL = `https://ebird.org/checklist/${SUB_ID}`;
const HEADER =
  "Submission ID,Common Name,Scientific Name,Taxonomic Order,Count,State/Province,County,Location ID,Location,Latitude,Longitude,Date,Time,Protocol,Duration (Min),All Obs Reported";

async function opensChecklist(context: BrowserContext, page: Page, open: () => Promise<void>): Promise<void> {
  const popup = page.waitForEvent("popup");
  await open();
  const tab = await popup;
  await expect(tab).toHaveURL(CHECKLIST_URL);
  await tab.close();
}

test("imports eBird checklists, links a trip's photo and opens the checklist", async ({ page, context }, testInfo) => {
  await context.route("https://ebird.org/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "<title>eBird checklist</title>" }),
  );
  const trip = await seedTrip(page.request, "E2E eBird checklists", [
    { file: "ebird-chickadee.jpg", species: SPECIES.chickadee, taken: "2018:05:20 07:40:00", tint: 164 },
  ]);
  const csv = testInfo.outputPath("MyEBirdData.csv");
  writeFileSync(
    csv,
    [
      HEADER,
      `${SUB_ID},Black-capped Chickadee,Poecile atricapillus,1,2,CA-BC,Metro,L91,E2E Pond,49.25,-123.1,2018-05-20,07:30 AM,Traveling,60,1`,
    ].join("\n"),
  );

  await page.goto("/settings/species");
  const row = page.locator("#ebird-import");
  const chooser = page.waitForEvent("filechooser");
  await row.getByText("Choose file", { exact: true }).click();
  await (await chooser).setFiles(csv);
  await expect(row.getByText(/^1 checklist kept/)).toBeVisible();

  // The trip suggests the photo for the checklist; confirming links it.
  await page.goto(`/trips/${trip.id}`);
  const section = page.locator("section").filter({ has: page.getByRole("heading", { name: "eBird checklists" }) });
  await expect(section.getByText("E2E Pond")).toBeVisible();
  await section.getByRole("button", { name: "Match photos" }).click();
  await expect(page.getByText("1 photo suggested", { exact: true })).toBeVisible();
  await section.getByRole("button", { name: "Link 1 photo" }).click();
  await expect(section.getByText(/1 photo linked/)).toBeVisible();

  await opensChecklist(context, page, async () => {
    await section.getByRole("button", { name: "More options" }).click();
    await page.getByRole("menuitem", { name: "Open on eBird" }).click();
  });

  // The photo's viewer links to the same checklist.
  await page.goto(`/gallery?tripId=${trip.id}`);
  await page.getByTestId("photo-tile").first().getByRole("img").first().click();
  await opensChecklist(context, page, () => page.getByRole("button", { name: "Open checklist on eBird" }).click());
});
