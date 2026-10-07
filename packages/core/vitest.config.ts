import { defineConfig } from "vitest/config";

// Integration tests share one scratch database, so with TEST_DATABASE_URL set files run one at a
// time, or one file's cleanup would remove rows another is checking.
export default defineConfig({
  test: {
    fileParallelism: !process.env.TEST_DATABASE_URL,
    // Tests only ever reach the scratch database. Without TEST_DATABASE_URL, any query (even from
    // code a unit test didn't expect to touch the database) fails fast instead of falling back to
    // DATABASE_URL or localhost:5432, which may be a real library or the maintainer database.
    env: { DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgres://none@127.0.0.1:1/no-test-database" },
  },
});
