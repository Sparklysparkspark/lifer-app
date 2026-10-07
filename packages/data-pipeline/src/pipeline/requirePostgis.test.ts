import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { requirePostgis } from "./requirePostgis.js";

const db = (installed: boolean) => ({ query: async () => ({ rowCount: installed ? 1 : 0, rows: [] }) }) as unknown as Pool;

describe("requirePostgis", () => {
  it("passes when the extension is installed", async () => {
    await expect(requirePostgis(db(true), "some-script.ts")).resolves.toBeUndefined();
  });

  it("names the script and the fix when it isn't", async () => {
    const err = await requirePostgis(db(false), "some-script.ts").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/^some-script\.ts needs PostGIS/);
    expect((err as Error).message).toContain("CREATE EXTENSION postgis");
  });
});
