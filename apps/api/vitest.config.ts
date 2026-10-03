import { defineConfig } from "vitest/config";

// Integration tests share one scratch database, so with TEST_DATABASE_URL set files run one at a
// time, or one file's cleanup would remove rows another is checking.
export default defineConfig({
  test: {
    fileParallelism: !process.env.TEST_DATABASE_URL,
  },
});
