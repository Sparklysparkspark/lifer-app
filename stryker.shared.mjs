// Shared StrykerJS options for every workspace's stryker*.config.mjs. Run them through
// `npm run test:mutation` (scripts/mutation.mjs), which runs each package's configs in turn from
// that package's folder. See docs/docs/contributing/testing.md.

/**
 * @param {object} opts
 * @param {string} opts.name report name, e.g. "core" or "core-integration"
 * @param {string[]} opts.mutate files to mutate, relative to the package
 * @param {boolean} [opts.integration] needs TEST_DATABASE_URL; runs one mutant at a time, since
 *   integration tests share one database and clear rows another run would be checking
 * @returns {import("@stryker-mutator/api/core").PartialStrykerOptions}
 */
export function strykerConfig({ name, mutate, integration = false }) {
  return {
    testRunner: "vitest",
    plugins: ["@stryker-mutator/vitest-runner"],
    vitest: { related: true },
    // Only the tests that cover a mutant run against it.
    coverageAnalysis: "perTest",
    mutate,
    ...(integration ? { concurrency: 1 } : {}),
    // Integration tests start Fastify, sharp and Postgres connections, so a mutant gets longer.
    timeoutMS: integration ? 30_000 : 10_000,
    reporters: ["clear-text", "progress", "html", "json"],
    htmlReporter: { fileName: `../../reports/mutation/${name}.html` },
    jsonReporter: { fileName: `../../reports/mutation/${name}.json` },
    // Stryker copies the package into a sandbox per run. Copy only what the tests need: the data
    // pipeline's data/ folder alone is many gigabytes and would fill the disk.
    ignorePatterns: ["/*", "!/src", "!/migrations", "!/package.json", "!/tsconfig*.json", "!/vitest.config.ts"],
    tempDirName: ".stryker-tmp",
    cleanTempDir: "always",
    // Report only; the score is a guide for where tests are weak, not a gate yet.
    thresholds: { high: 90, low: 80, break: null },
  };
}
