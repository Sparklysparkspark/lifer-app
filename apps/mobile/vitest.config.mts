import { defineConfig } from "vitest/config";

// Only RN-free logic is unit tested here; screens are covered by device tests.
export default defineConfig({ test: { include: ["src/**/*.test.ts"] } });
