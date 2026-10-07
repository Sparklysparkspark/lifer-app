import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canonicalPath, isWithin, isWithinResolved } from "./pathContainment.js";

let tmp: string;
let real: string;
let data: string;
let outside: string;
let link: string;

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), "lifer-containment-")));
  real = path.join(tmp, "real");
  data = path.join(real, "data");
  outside = path.join(tmp, "outside");
  for (const d of [path.join(data, "Birds"), outside]) mkdirSync(d, { recursive: true });
  // The data folder seen through a symlink, like macOS's /tmp or a symlinked NAS mount.
  link = path.join(tmp, "link");
  symlinkSync(real, link);
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe("isWithin", () => {
  it("accepts the root itself and anything below it", () => {
    expect(isWithin("/data", "/data")).toBe(true);
    expect(isWithin("/data", "/data/Birds/heron.jpg")).toBe(true);
  });

  it("refuses a sibling that only shares a name prefix", () => {
    expect(isWithin("/data", "/data2")).toBe(false);
    expect(isWithin("/data", "/data2/Birds")).toBe(false);
  });

  it("refuses a parent and a path that climbs out with ..", () => {
    expect(isWithin("/data", "/")).toBe(false);
    expect(isWithin("/data", path.resolve("/data/Birds/../../etc"))).toBe(false);
  });

  it("keeps a folder whose name starts with two dots inside", () => {
    expect(isWithin("/data", "/data/..cache")).toBe(true);
  });

  it("works with the filesystem root as the root", () => {
    expect(isWithin("/", "/data")).toBe(true);
  });
});

describe("canonicalPath", () => {
  it("resolves a symlink anywhere in the path", () => {
    expect(canonicalPath(path.join(link, "data", "Birds"))).toBe(path.join(data, "Birds"));
  });

  it("resolves the existing part of a path that doesn't exist yet and keeps the rest", () => {
    expect(canonicalPath(path.join(link, "data", "New", "Wildlife"))).toBe(path.join(data, "New", "Wildlife"));
  });

  it("normalizes .. lexically before resolving", () => {
    expect(canonicalPath(path.join(link, "data", "Birds", "..", "Birds"))).toBe(path.join(data, "Birds"));
  });
});

describe("isWithinResolved", () => {
  it("matches a realpath against a root spelled through a symlink, and the other way round", () => {
    const linkedRoot = path.join(link, "data");
    expect(isWithin(linkedRoot, path.join(data, "Birds"))).toBe(false); // the mismatch it fixes
    expect(isWithinResolved(linkedRoot, path.join(data, "Birds"))).toBe(true);
    expect(isWithinResolved(data, path.join(linkedRoot, "Birds"))).toBe(true);
    expect(isWithinResolved(linkedRoot, path.join(data, "Birds", "Wildlife"))).toBe(true);
  });

  it("refuses a symlink inside the root that leads outside it", () => {
    symlinkSync(outside, path.join(data, "escape"));
    expect(isWithinResolved(data, path.join(data, "escape"))).toBe(false);
    expect(isWithinResolved(path.join(link, "data"), path.join(data, "escape", "file.jpg"))).toBe(false);
  });

  it("refuses .. climbing out of the root", () => {
    expect(isWithinResolved(data, path.join(data, "..", "..", "outside"))).toBe(false);
    expect(isWithinResolved(path.join(link, "data"), path.join(link, "data", "..", ".."))).toBe(false);
  });

  it("refuses a sibling sharing the root's name prefix, real or through a symlink", () => {
    mkdirSync(`${data}2`);
    expect(isWithinResolved(data, `${data}2`)).toBe(false);
    expect(isWithinResolved(path.join(link, "data"), `${data}2`)).toBe(false);
  });
});
