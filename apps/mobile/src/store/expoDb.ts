import * as SQLite from "expo-sqlite";
import type { Db, Param } from "./db";
import { migrate } from "./migrations";

/** Opens the phone's database (creating it on first run) and brings its schema up to date. */
export async function openDb(name = "lifer.db"): Promise<Db> {
  const sqlite = await SQLite.openDatabaseAsync(name);
  await sqlite.execAsync("PRAGMA journal_mode = WAL");
  const db: Db = {
    exec: (sql) => sqlite.execAsync(sql),
    run: async (sql, params = []) => void (await sqlite.runAsync(sql, params as Param[])),
    all: <T>(sql: string, params: Param[] = []) => sqlite.getAllAsync<T>(sql, params),
    get: async <T>(sql: string, params: Param[] = []) => (await sqlite.getFirstAsync<T>(sql, params)) ?? null,
    tx: (fn) => {
      let out: Awaited<ReturnType<typeof fn>>;
      return sqlite.withTransactionAsync(async () => void (out = await fn())).then(() => out);
    },
  };
  await migrate(db);
  return db;
}
