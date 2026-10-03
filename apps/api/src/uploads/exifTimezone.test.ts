// The same photo must get the same taken_at, fingerprint, file-name date and year folder on a
// UTC server (Docker) and on a desktop in another zone. Each case runs in a child process with
// its own TZ, since a process's zone is fixed once dates have been used.
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const apiDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const loader = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;

interface Reading {
  takenAt: string;
  wallClock: string;
  legacyTakenAt: string | null;
  strict: string;
  loose: string;
  legacy: { strict: string; loose: string } | null;
  /** The legacy zone-dependent result, in this process's zone. */
  oldStrict: string;
  oldLoose: string;
  folder: string;
}

function readIn(tz: string, exifDate: string): Reading {
  const script = `
    import { createHash } from "node:crypto";
    import { ExifDateTime } from "exiftool-vendored";
    const { captureTimeFromTags, fingerprintFromTags } = await import("./src/uploads/exif.ts");
    const { originalsFolder } = await import("./src/uploads/organizedPath.ts");
    const dt = ExifDateTime.fromEXIF(${JSON.stringify(exifDate)});
    const tags = { DateTimeOriginal: dt, SubSecTimeOriginal: "42", Model: "Canon EOS R5", SerialNumber: "123" };
    const time = captureTimeFromTags(tags);
    const fp = fingerprintFromTags(tags);
    const iso = dt.toDate().toISOString();
    const hash = (parts) => createHash("sha256").update(parts.join("|")).digest("hex");
    const folder = originalsFolder("/lib", { organizeByYear: true, speciesFolderName: "Mallard", taxonClass: null, takenAt: time.takenAt, takenAtWallClock: time.wallClock, subfolder: "Adjusted" });
    console.log(JSON.stringify({
      takenAt: time.takenAt.toISOString(), wallClock: time.wallClock, legacyTakenAt: time.legacyTakenAt?.toISOString() ?? null,
      strict: fp.strict, loose: fp.loose, legacy: fp.legacy ?? null,
      oldStrict: hash([iso, "42", "Canon EOS R5", "123"]), oldLoose: hash([iso, "Canon EOS R5"]), folder,
    }));
    process.exit(0);
  `;
  const out = execFileSync(process.execPath, ["--import", loader, "--input-type=module", "-e", script], {
    cwd: apiDir,
    env: { ...process.env, TZ: tz },
    encoding: "utf8",
  });
  return JSON.parse(out.trim().split("\n").pop()!);
}

describe("capture time doesn't depend on the server's zone", () => {
  // Half an hour into New Year's Day on the camera's clock: 2023 in UTC-8 if read as local.
  const newYear = "2024:01:01 00:30:15";
  const utc = readIn("UTC", newYear);
  const la = readIn("America/Los_Angeles", newYear);

  it("gives the same taken_at and fingerprint in UTC and in Los Angeles", () => {
    expect(la.takenAt).toBe(utc.takenAt);
    expect(la.takenAt).toBe("2024-01-01T00:30:15.000Z");
    expect(la.strict).toBe(utc.strict);
    expect(la.loose).toBe(utc.loose);
  });

  it("matches exactly what a UTC server (Docker) always stored", () => {
    expect(utc.strict).toBe(utc.oldStrict);
    expect(utc.loose).toBe(utc.oldLoose);
    expect(utc.legacy).toBeNull();
    expect(utc.legacyTakenAt).toBeNull();
  });

  it("keeps the old local-zone reading on a desktop outside UTC, for matching rows stored earlier", () => {
    expect(la.legacy).toEqual({ strict: la.oldStrict, loose: la.oldLoose });
    expect(la.legacyTakenAt).toBe("2024-01-01T08:30:15.000Z");
  });

  it("dates the file name and year folder by the camera's own clock", () => {
    expect(utc.wallClock).toBe("2024-01-01T00:30:15");
    expect(la.wallClock).toBe("2024-01-01T00:30:15");
    expect(la.folder).toBe(path.join("/lib", "Wildlife 2024", "Other", "Mallard", "Adjusted"));
    expect(utc.folder).toBe(la.folder);
  });

  it("uses the file's own offset when it has one, the same everywhere", () => {
    const withOffset = "2024:01:01 00:30:15-08:00";
    const a = readIn("UTC", withOffset);
    const b = readIn("America/Los_Angeles", withOffset);
    expect(a.takenAt).toBe("2024-01-01T08:30:15.000Z");
    expect(b.takenAt).toBe(a.takenAt);
    expect(b.strict).toBe(a.strict);
    expect(a.strict).toBe(a.oldStrict);
    expect(b.legacy).toBeNull();
    expect(a.wallClock).toBe("2024-01-01T00:30:15");
  });
});

