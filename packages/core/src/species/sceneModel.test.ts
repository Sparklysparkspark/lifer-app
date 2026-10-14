import path from "node:path";
import { describe, expect, it } from "vitest";
import { SCENE_MODEL_VERSION } from "../config.js";
import { sceneModelFile } from "./sceneModel.js";

const dir = path.join("/models");
const urls = { int8: "https://example.test/int8.onnx", fp32: "https://example.test/fp32.onnx" };

describe("sceneModelFile", () => {
  it("runs the int8 file", () => {
    for (const [platform, arch] of [
      ["darwin", "arm64"],
      ["linux", "x64"],
      ["linux", "arm64"],
      ["win32", "x64"],
    ] as const) {
      expect(sceneModelFile(platform, arch, dir, urls)).toEqual({
        path: path.join(dir, `${SCENE_MODEL_VERSION}.onnx`),
        url: urls.int8,
      });
    }
  });

  it("runs the full-precision file on an Intel Mac, whose onnxruntime can't run the int8 one", () => {
    expect(sceneModelFile("darwin", "x64", dir, urls)).toEqual({
      path: path.join(dir, `${SCENE_MODEL_VERSION}-fp32.onnx`),
      url: urls.fp32,
    });
  });
});
