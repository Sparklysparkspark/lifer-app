import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { newestSnapshot } from "./dbSnapshot.js";

describe("newestSnapshot", () => {
  it("picks the newest finished database dump, ignoring partials and other files", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "lifer-snap-"));
    try {
      const file = (name: string, day: number) => {
        writeFileSync(path.join(dir, name), "x");
        const t = new Date(Date.UTC(2026, 9, day));
        utimesSync(path.join(dir, name), t, t);
      };
      file("lifer-db-before-refresh-a.dump", 1);
      file("lifer-db-2026.sql", 3);
      file("lifer-db-before-refresh-b.dump.partial", 5);
      file("lifer-data-2026.tar.gz", 6);
      expect(newestSnapshot(dir)?.file).toBe("lifer-db-2026.sql");
      expect(newestSnapshot(path.join(dir, "none"))).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
