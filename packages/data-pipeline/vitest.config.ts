import { defineConfig } from "vitest/config";

// Integration tests share one scratch database, so with TEST_DATABASE_URL set files run one at a
// time (as in core and api), or one file's species show up in another's selection while it runs.
export default defineConfig({
  test: {
    fileParallelism: !process.env.TEST_DATABASE_URL,
    // Tests only ever reach the scratch database. Without TEST_DATABASE_URL, any query fails fast
    // instead of falling back to DATABASE_URL or localhost:5432, the maintainer database.
    env: { DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgres://none@127.0.0.1:1/no-test-database" },
  },
});
