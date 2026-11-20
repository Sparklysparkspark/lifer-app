// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database. The push job end
// to end against a stand-in server: a photo that can't be uploaded fails the job and stays due.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.APP_DATA_DIR = `${process.env.TMPDIR ?? "/tmp"}/lifer-push-run-${process.pid}`;
});

const url = process.env.TEST_DATABASE_URL;
const SPECIES = "eeeeeeee-0000-4000-8000-00000000086a";
const CAPTURE = "eeeeeeee-0000-4000-8000-000000000861";
const SERVER_SPECIES = "eeeeeeee-0000-4000-8000-00000000086b";

describe.skipIf(!url)("push job", () => {
  let db: pg.Pool;
  let server: Server;
  const dir = process.env.APP_DATA_DIR!;
  const pushed: string[] = [];

  beforeAll(async () => {
    db = new pg.Pool({ connectionString: url });
    mkdirSync(dir, { recursive: true });
    // Answers as the linked server, says it lacks every capture, and refuses every upload.
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        res.setHeader("content-type", "application/json");
        if (req.url === "/health") return res.end(JSON.stringify({ instanceId: "push-run-test" }));
        if (req.url === "/api/sync/push") {
          const { captures } = JSON.parse(body) as { captures: { id: string; scientificName: string }[] };
          pushed.push(...captures.map((c) => c.id));
          return res.end(
            JSON.stringify({
              outcomes: captures.map((c) => ({ id: c.id, status: "needs-file" })),
              speciesIds: Object.fromEntries(captures.map((c) => [c.scientificName, SERVER_SPECIES])),
              userSpecies: 0,
              deleted: 0,
            }),
          );
        }
        res.statusCode = 500;
        res.end("{}");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    writeFileSync(
      path.join(dir, "server-link.json"),
      JSON.stringify({ instanceId: "push-run-test", token: "t", urls: [`http://127.0.0.1:${port}`] }),
    );
    const { getOrCreateLocalUser } = await import("../auth/session.js");
    const userId = (await getOrCreateLocalUser()).id;
    await db.query(
      `INSERT INTO species (id, scientific_name, common_name, taxon_class, gbif_key) VALUES ($1, 'Zzpushrun testus', 'Run Bird', 'aves', 980861)
       ON CONFLICT (id) DO NOTHING`,
      [SPECIES],
    );
    await db.query(
      `INSERT INTO captures_all (id, user_id, species_id, fingerprint) VALUES ($1, $2, $3, 'push-run') ON CONFLICT (id) DO NOTHING`,
      [CAPTURE, userId, SPECIES],
    );
  });

  afterAll(async () => {
    server?.close();
    if (db) {
      await db.query(`DELETE FROM captures_all WHERE id = $1`, [CAPTURE]);
      await db.query(`DELETE FROM sync_tombstones WHERE ref = $1`, [CAPTURE]);
      await db.query(`DELETE FROM species WHERE id = $1`, [SPECIES]);
      await db.end();
    }
    const { pool } = await import("@lifer/core/db.js");
    await pool.end();
    rmSync(dir, { recursive: true, force: true });
  });

  it("fails the job when a photo can't be uploaded, and keeps it due", async () => {
    const { pushJob, startPush } = await import("./push.js");
    expect(startPush()).toBe(true);
    await vi.waitFor(() => expect(pushJob.status.running).toBe(false), { timeout: 20_000, interval: 50 });
    expect(pushed).toContain(CAPTURE);
    expect(pushJob.status.error).toMatch(
      /^\d+ photos? couldn't be sent to the server and will be tried again at the next sync$/,
    );
    const row = (
      await db.query(`SELECT pushed_at IS NULL AS due, remote_id FROM captures_all WHERE id = $1`, [CAPTURE])
    ).rows[0];
    expect(row).toEqual({ due: true, remote_id: null });
  });
});
