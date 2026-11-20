import { test } from "node:test";
import assert from "node:assert/strict";
import { matchAssets } from "./releaseAssets.ts";

const a = (name: string) => ({ name, size: 1, url: `https://example.com/${name}` });

test("matches each platform by suffix", () => {
  const m = matchAssets(
    [
      "Lifer-macos-arm64.zip",
      "Lifer-macos-x64.zip",
      "Lifer_1.0.0_x64-setup.exe",
      "Lifer_1.0.0.AppImage",
      "Lifer_1.0.0_amd64.deb",
      "latest.json",
      "SHA256SUMS",
      "Lifer-macos-arm64.app.tar.gz",
    ].map(a),
  );
  assert.deepEqual(Object.keys(m).sort(), ["linuxAppImage", "linuxDeb", "macArm", "macIntel", "windows"]);
  assert.equal(m.macArm?.name, "Lifer-macos-arm64.zip");
});

test("a missing platform is absent", () => {
  const m = matchAssets(["Lifer-macos-arm64.zip", "Lifer_1.0.0_x64-setup.exe"].map(a));
  assert.equal(m.linuxDeb, undefined);
  assert.equal(m.linuxAppImage, undefined);
});
