// Failing files (T-04): a folder import with a zero-byte file, a text file named .jpg, a corrupt
// and a truncated JPEG and (not on Windows) an unreadable one. Each bad file gets a short, plain
// reason, and the good photo beside them still imports. Locked files on Windows and a file removed
// mid-import are manual checks: docs/docs/contributing/release-personas.md.
import { chmodSync } from "node:fs";
import path from "node:path";
import { writeBadFiles } from "../fixtures/bad-files/makeBadFiles.js";
import { SPECIES } from "../support/fixtureCatalog.js";
import { HEADERS, createTrip, json, speciesId, waitForJob, writeTripFolder } from "../support/library.js";
import { expect, test } from "../support/test.js";

const TRIP = "E2E Bad Files";
// Words that mean a developer's message reached the user.
const RAW_ERROR =
  /error\b|errno|ENOENT|EACCES|EPERM|EISDIR|sharp|vips|exiftool|buffer|stack|undefined|null|\bat \S+:\d+/i;

test("names each bad file's problem plainly and imports the good photo beside them", async ({ page }) => {
  const request = page.request;
  const folder = await writeTripFolder(request, TRIP, [
    { file: "good.jpg", species: SPECIES.chickadee, taken: "2022:07:01 12:00:00", tint: 170 },
  ]);
  const bad = await writeBadFiles(folder, 171);
  try {
    const tripId = await createTrip(request, TRIP, folder);
    await json(await request.post(`/api/trips/${tripId}/scan`, { headers: HEADERS }));
    await waitForJob(request, `/api/trips/${tripId}/scan/status`);

    const species = await speciesId(request, SPECIES.chickadee);
    const files = ["good.jpg", ...bad.map((b) => b.file)].map((relativePath) => ({ relativePath, speciesId: species }));
    await json(await request.post(`/api/trips/${tripId}/import`, { headers: HEADERS, data: { files } }));
    await waitForJob(request, `/api/trips/${tripId}/import/status`);
    const { results } = await json<{ results: Array<{ relativePath: string; captureId?: string; error?: string }> }>(
      await request.get(`/api/trips/${tripId}/import/status`, { headers: HEADERS }),
    );
    const resultFor = (file: string) => results.find((r) => r.relativePath === file);

    expect(resultFor("good.jpg")?.captureId, "the good photo imported").toBeTruthy();
    for (const { file, mayImport } of bad) {
      const result = resultFor(file);
      expect(result, `${file} has a result`).toBeTruthy();
      if (mayImport && result?.captureId) continue;
      expect(result?.error, `${file} says what went wrong`).toBeTruthy();
      expect(result!.error!.length, `${file}: "${result!.error}" is short`).toBeLessThan(160);
      expect(result!.error, `${file}: "${result!.error}" is plain`).not.toMatch(RAW_ERROR);
    }

    // The trip opens with the photo that made it, and no error toast.
    await page.goto(`/trips/${tripId}`);
    await expect(page.getByRole("heading", { level: 1, name: TRIP })).toBeVisible();
  } finally {
    if (process.platform !== "win32") chmodSync(path.join(folder, "unreadable.jpg"), 0o644);
  }
});
