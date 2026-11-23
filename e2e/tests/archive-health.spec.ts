// Archive health (docs/plans/archive-health.md) on the real server, so it runs on every system the
// e2e matrix runs on: a file damaged under the same modification time, one deleted, one unreadable,
// one edited (new time), and a whole folder gone like an unplugged drive. Each must land as the
// table in archive-health.md says, in the API and on the Settings row and list.
import { chmodSync, readFileSync, renameSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { LOCAL_DATABASE_URL } from "../support/constants.js";
import { SPECIES } from "../support/fixtureCatalog.js";
import { HEADERS, json, seedTrip } from "../support/library.js";
import { expect, test } from "../support/test.js";

const TRIP = "E2E Archive Health";
// Windows has no permission bit that stops the owner reading a file.
const CAN_LOCK = process.platform !== "win32";

type Problem = { id: string; path: string; problem: "changed" | "unreadable" | "missing" };

// Windows refuses to change a file another process still has open (the server's readers, the
// virus scanner), so a just-imported file gets a few seconds to come free.
async function whenFree(what: string, change: () => void): Promise<void> {
  for (let tries = 0; ; tries++) {
    try {
      return change();
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (!["EBUSY", "EPERM", "UNKNOWN"].includes(code ?? "")) throw err;
      if (tries === 20)
        throw new Error(`${what} still locked after ${tries} tries (${code}): ${(err as Error).message}`, {
          cause: err,
        });
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

test("flags damaged, unreadable and missing files, and leaves edits and unplugged folders alone", async ({ page }) => {
  // The pass waits for a quiet minute after any import before it reads a file.
  test.setTimeout(300_000);
  const request = page.request;
  const db = new pg.Client({ connectionString: process.env.E2E_DATABASE_URL ?? LOCAL_DATABASE_URL });
  await db.connect();
  const locked: string[] = [];
  try {
    const at = (i: number) => `2023:06:0${i} 12:00:00`;
    const kept = await seedTrip(request, TRIP, [
      { file: "damaged.jpg", species: SPECIES.chickadee, taken: at(1), tint: 160 },
      { file: "deleted.jpg", species: SPECIES.chickadee, taken: at(2), tint: 161 },
      { file: "locked.jpg", species: SPECIES.chickadee, taken: at(3), tint: 162 },
      { file: "edited.jpg", species: SPECIES.chickadee, taken: at(4), tint: 163 },
    ]);
    const unplugged = await seedTrip(request, `${TRIP} Drive`, [
      { file: "away.jpg", species: SPECIES.chickadee, taken: at(5), tint: 164 },
    ]);
    const captureIds = { ...kept.captureIds, ...unplugged.captureIds };
    const rows = (
      await db.query<{ id: string; ref: string; capture_id: string }>(
        `SELECT id, ref, capture_id FROM originals WHERE capture_id = ANY($1)`,
        [Object.values(captureIds)],
      )
    ).rows;
    const original = (file: string) => rows.find((r) => r.capture_id === captureIds[file])!;
    const ids = rows.map((r) => r.id);

    // Runs passes until every file in `ids` has been checked (a pass already under way may have
    // passed these rows, so another is asked for whenever none is running).
    const checkAll = async (want: string[]) => {
      await expect
        .poll(
          async () => {
            const summary = await json<{ running: boolean }>(
              await request.get("/api/originals/health", { headers: HEADERS }),
            );
            if (!summary.running)
              await request.put("/api/originals/health", { headers: HEADERS, data: { enabled: true } });
            const res = await db.query(`SELECT 1 FROM originals WHERE id = ANY($1) AND checked_at IS NOT NULL`, [want]);
            return res.rowCount;
          },
          { timeout: 240_000, intervals: [2_000] },
        )
        .toBe(want.length);
    };

    // First pass: every file gets its baseline.
    await checkAll(ids);

    // Damage under the same modification time (bit rot).
    const damaged = original("damaged.jpg").ref;
    const before = statSync(damaged);
    const bytes = readFileSync(damaged);
    bytes[Math.floor(bytes.length / 2)] ^= 0xff;
    await whenFree("damaged.jpg", () => writeFileSync(damaged, bytes));
    utimesSync(damaged, before.atime, before.mtime);
    // An edit: new bytes and a new time.
    const edited = original("edited.jpg").ref;
    const editedBytes = readFileSync(edited);
    editedBytes[Math.floor(editedBytes.length / 2)] ^= 0xff;
    await whenFree("edited.jpg", () => writeFileSync(edited, editedBytes));
    utimesSync(edited, new Date(), new Date(Date.now() + 3_600_000));
    await whenFree("deleted.jpg", () => unlinkSync(original("deleted.jpg").ref));
    if (CAN_LOCK) {
      chmodSync(original("locked.jpg").ref, 0o000);
      locked.push(original("locked.jpg").ref);
    }
    // The whole folder gone, as when its drive is unplugged.
    const away = path.dirname(original("away.jpg").ref);
    await whenFree("the Drive folder", () => renameSync(away, `${away}-unplugged`));

    // Ninety days on: every file is due again.
    await db.query(`UPDATE originals SET checked_at = NULL WHERE id = ANY($1)`, [ids]);
    await checkAll(ids.filter((id) => id !== original("away.jpg").id));

    const { items } = await json<{ items: Problem[] }>(
      await request.get("/api/originals/health/problems", { headers: HEADERS }),
    );
    const problemOf = (file: string) => items.find((i) => i.id === original(file).id)?.problem ?? null;
    expect(problemOf("damaged.jpg")).toBe("changed");
    expect(problemOf("deleted.jpg")).toBe("missing");
    expect(problemOf("locked.jpg")).toBe(CAN_LOCK ? "unreadable" : null);
    expect(problemOf("edited.jpg")).toBeNull();
    expect(problemOf("away.jpg")).toBeNull();
    const away1 = await db.query(`SELECT health, checked_at FROM originals WHERE id = $1`, [original("away.jpg").id]);
    expect(away1.rows[0]).toEqual({ health: null, checked_at: null });

    // Settings > Storage links to the list, which names each problem in plain words.
    await page.goto("/settings/storage");
    await page.getByRole("link", { name: /files? ha(s|ve) (a )?problems?/ }).click();
    await expect(page).toHaveURL(/\/archive-health$/);
    await page.getByLabel("Search files").fill(TRIP);
    const row = (file: string) => page.getByRole("listitem").filter({ hasText: path.basename(original(file).ref) });
    await expect(row("damaged.jpg")).toContainText("Contents changed");
    await expect(row("deleted.jpg")).toContainText("Missing");
    if (CAN_LOCK) await expect(row("locked.jpg")).toContainText("Can't be read");
    await expect(row("edited.jpg")).toHaveCount(0);

    // Ignore accepts the damaged file as it is now, and it leaves the list.
    await row("damaged.jpg").getByRole("button", { name: "More options" }).click();
    await page.getByRole("menuitem", { name: "Ignore" }).click();
    await expect(row("damaged.jpg")).toHaveCount(0);
    await expect(row("deleted.jpg")).toBeVisible();
  } finally {
    for (const file of locked) chmodSync(file, 0o644);
    await db.end();
  }
});
