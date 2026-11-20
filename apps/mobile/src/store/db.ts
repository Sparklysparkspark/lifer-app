// The phone's own database behind one small async interface: expo-sqlite on the device
// (expoDb.ts), node:sqlite in tests (testDb.ts), so the real SQL is what the tests run.
export type Param = string | number | null | Uint8Array;
export type Row = Record<string, string | number | null | Uint8Array>;

export interface Db {
  exec(sql: string): Promise<void>;
  run(sql: string, params?: Param[]): Promise<void>;
  all<T = Row>(sql: string, params?: Param[]): Promise<T[]>;
  get<T = Row>(sql: string, params?: Param[]): Promise<T | null>;
  /** One transaction; not nestable. */
  tx<T>(fn: () => Promise<T>): Promise<T>;
}
