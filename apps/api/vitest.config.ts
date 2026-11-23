import { configDefaults, defineConfig } from "vitest/config";

// Integration tests share one scratch database, so with TEST_DATABASE_URL set files run one at a
// time, or one file's cleanup would remove rows another is checking.
// Timing-budget tests (*.timing.test.ts) run as their own project after the rest, one file at a
// time, so a busy neighbour can't blow their budget.
export default defineConfig({
  test: {
    projects: [
      { extends: true, test: { name: "unit", exclude: [...configDefaults.exclude, "**/*.timing.test.ts"] } },
      { extends: true, test: { name: "timing", include: ["src/**/*.timing.test.ts"], fileParallelism: false } },
    ],
    fileParallelism: !process.env.TEST_DATABASE_URL,
    // Tests only ever reach the scratch database. Without TEST_DATABASE_URL, any query (even from
    // code a unit test didn't expect to touch the database) fails fast instead of falling back to
    // DATABASE_URL or localhost:5432, which may be a real library or the maintainer database.
    env: { DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgres://none@127.0.0.1:1/no-test-database" },
  },
});
