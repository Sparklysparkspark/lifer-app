// Recognition runs on this OS: the bundled detector loads in the inference worker and runs on the
// CPU. The recognition-smoke job in ci.yml runs it on Windows, macOS and Linux.
import { afterAll, expect, it } from "vitest";
import { BASIC_DETECTOR_MODEL_PATH, probeModel, stopInference } from "./inference.js";

afterAll(() => stopInference());

it("runs the bundled detector on the CPU", async () => {
  const result = await probeModel(BASIC_DETECTOR_MODEL_PATH, ["cpu"], [1, 3, 640, 640], 1);
  expect(result.vector.length).toBeGreaterThan(0);
  expect(result.vector.every(Number.isFinite)).toBe(true);
}, 120_000);
