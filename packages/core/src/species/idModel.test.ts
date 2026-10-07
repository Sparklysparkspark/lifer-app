import path from "node:path";
import { describe, expect, it } from "vitest";
import { ID_MODEL_VERSION } from "../config.js";
import { idModelFiles } from "./idModel.js";

const dir = path.join("/models");
const urls = { cpu: "https://example.test/int8.onnx", gpu: "https://example.test/fp32.onnx", gpuBytes: 123 };
const int8Path = path.join(dir, `${ID_MODEL_VERSION}.onnx`);
const fp32Path = path.join(dir, `${ID_MODEL_VERSION}-fp32.onnx`);

describe("idModelFiles", () => {
  it("runs the int8 file on the CPU, with the full-precision copy for a GPU", () => {
    for (const [platform, arch] of [
      ["darwin", "arm64"],
      ["linux", "x64"],
      ["linux", "arm64"],
      ["win32", "x64"],
    ] as const) {
      expect(idModelFiles(platform, arch, dir, urls)).toEqual({
        cpu: { path: int8Path, url: urls.cpu },
        gpuCopy: { path: fp32Path, url: urls.gpu, bytes: 123 },
      });
    }
  });

  it("runs only the full-precision file on an Intel Mac, whose onnxruntime can't run the int8 one", () => {
    expect(idModelFiles("darwin", "x64", dir, urls)).toEqual({ cpu: { path: fp32Path, url: urls.gpu }, gpuCopy: null });
  });
});
