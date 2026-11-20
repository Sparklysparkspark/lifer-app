// node:sqlite behind the Db interface, for tests only.
import { DatabaseSync } from "node:sqlite";
import type { Db, Param } from "./db";
import { migrate } from "./migrations";

export function memoryDb(): Db {
  const sqlite = new DatabaseSync(":memory:");
  return {
    exec: async (sql) => void sqlite.exec(sql),
    run: async (sql, params = []) => void sqlite.prepare(sql).run(...(params as Param[])),
    all: async <T>(sql: string, params: Param[] = []) => sqlite.prepare(sql).all(...params) as T[],
    get: async <T>(sql: string, params: Param[] = []) => (sqlite.prepare(sql).get(...params) as T | undefined) ?? null,
    tx: async (fn) => {
      sqlite.exec("BEGIN");
      try {
        const out = await fn();
        sqlite.exec("COMMIT");
        return out;
      } catch (e) {
        sqlite.exec("ROLLBACK");
        throw e;
      }
    },
  };
}

export async function migratedDb(): Promise<Db> {
  const db = memoryDb();
  await migrate(db);
  return db;
}
