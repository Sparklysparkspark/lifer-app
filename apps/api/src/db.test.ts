import { describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";

vi.mock("pg", () => ({ Pool: class { on() {} query() { return Promise.resolve(); } } }));

const { withTransaction } = await import("./db.js");

function fakeDb(failOn?: string) {
  const sql: string[] = [];
  const release = vi.fn();
  const client = {
    query: vi.fn(async (text: string) => {
      sql.push(text);
      if (failOn && text.startsWith(failOn)) throw new Error(`fail ${failOn}`);
      return { rows: [] };
    }),
    release,
  } as unknown as PoolClient;
  return { db: { connect: async () => client }, sql, release };
}

describe("withTransaction", () => {
  it("commits and returns the callback's value", async () => {
    const { db, sql, release } = fakeDb();
    const out = await withTransaction(async (c) => {
      await c.query("SELECT 1");
      return 42;
    }, {}, db);
    expect(out).toBe(42);
    expect(sql).toEqual(["BEGIN", "SELECT 1", "COMMIT"]);
    expect(release).toHaveBeenCalledWith(undefined);
  });

  it("sets local timeouts and takes the reference data lock after BEGIN", async () => {
    const { db, sql } = fakeDb();
    await withTransaction(async () => undefined, { statementTimeoutMs: 5000, lockTimeoutMs: 250.7, lockReferenceData: true }, db);
    expect(sql).toEqual([
      "BEGIN",
      "SET LOCAL statement_timeout = 5000",
      "SET LOCAL lock_timeout = 250",
      "SELECT pg_advisory_xact_lock($1)",
      "COMMIT",
    ]);
  });

  it("rolls back and rethrows when the callback fails", async () => {
    const { db, sql, release } = fakeDb();
    await expect(
      withTransaction(async () => {
        throw new Error("boom");
      }, {}, db),
    ).rejects.toThrow("boom");
    expect(sql).toEqual(["BEGIN", "ROLLBACK"]);
    expect(release).toHaveBeenCalledWith(undefined);
  });

  it("destroys the client when ROLLBACK itself fails", async () => {
    const { db, release } = fakeDb("ROLLBACK");
    await expect(
      withTransaction(async () => {
        throw new Error("boom");
      }, {}, db),
    ).rejects.toThrow("boom");
    expect(release.mock.calls[0][0]).toBeInstanceOf(Error);
  });

  it("rolls back when COMMIT fails", async () => {
    const { db, sql } = fakeDb("COMMIT");
    await expect(withTransaction(async () => 1, {}, db)).rejects.toThrow("fail COMMIT");
    expect(sql.at(-1)).toBe("ROLLBACK");
  });
});
