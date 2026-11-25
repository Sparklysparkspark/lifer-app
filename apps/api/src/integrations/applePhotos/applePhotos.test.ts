// Apple Photos keyword sending without Photos: osascript and the database are mocked, so no
// script ever reaches a real Photos library.
import { beforeEach, describe, expect, it, vi } from "vitest";

const execFile = vi.fn();
vi.mock("node:child_process", () => ({ execFile: (...args: unknown[]) => execFile(...args) }));
const query = vi.fn();
vi.mock("@lifer/core/db.js", () => ({ pool: { query: (...args: unknown[]) => query(...args) } }));
vi.mock("../../uploads/exif.js", () => ({
  readPreservedFileName: (ref: string) => Promise.resolve(ref.endsWith("Eagle_0001.JPG") ? "IMG_4411.JPG" : null),
}));

import {
  ADD_KEYWORDS_SCRIPT,
  ApplePhotosError,
  LOOKUP_SCRIPT,
  parseLookup,
  pickMatch,
  runOsascript,
  scriptErrorNumber,
} from "./scripts.js";
import { SEND_IDLE, applePhotosJob, runApplePhotos, type Runner } from "./send.js";

const TAKEN = new Date("2026-05-03T14:00:00Z");
const daysSecs = (ms: number) => `${Math.floor(ms / 86_400_000)},${Math.floor((ms % 86_400_000) / 1000)}`;

describe("parseLookup", () => {
  it("reads ids and turns Photos' local time into UTC with the reported offset", () => {
    // Photos in UTC-6 shows 08:00 local for a 14:00 UTC shot; AppleScript's time to GMT is -21600.
    const local = TAKEN.getTime() - 6 * 3600_000;
    const out = `IMG_4411.JPG\tABC/L0/001\t${daysSecs(local)}\nIMG_4411.JPG\tDEF/L0/001\t\ntz\t-21600`;
    expect(parseLookup(out)).toEqual([
      { name: "IMG_4411.JPG", id: "ABC/L0/001", takenAt: TAKEN.getTime() },
      { name: "IMG_4411.JPG", id: "DEF/L0/001", takenAt: null },
    ]);
  });
});

describe("pickMatch", () => {
  const at = (id: string, hoursOff: number | null) => ({
    name: "IMG_4411.JPG",
    id,
    takenAt: hoursOff == null ? null : TAKEN.getTime() + hoursOff * 3600_000,
  });

  it("takes the closest file name hit within a day's zones, and nothing far off", () => {
    expect(pickMatch([at("far", 48), at("near", 1), at("nearer", 0.5)], TAKEN)).toBe("nearer");
    expect(pickMatch([at("far", 48)], TAKEN)).toBeNull();
    expect(pickMatch([], TAKEN)).toBeNull();
  });

  it("without a time on either side, only a single hit counts", () => {
    expect(pickMatch([at("only", null)], null)).toBe("only");
    expect(pickMatch([at("a", 0), at("b", 5)], null)).toBeNull();
    expect(pickMatch([at("undated", null)], TAKEN)).toBe("undated");
  });
});

describe("runOsascript", () => {
  beforeEach(() => execFile.mockReset());

  it("passes values as arguments, never inside the script text", async () => {
    execFile.mockImplementation((...a: unknown[]) => {
      const cb = a.at(-1);
      if (typeof cb === "function") cb(null, "1\n", "");
    });
    await runOsascript(ADD_KEYWORDS_SCRIPT, ["ID/1", 'Bald "Eagle"']);
    const [cmd, args] = execFile.mock.calls.find((c) => c[0] === "/usr/bin/osascript")!;
    expect(cmd).toBe("/usr/bin/osascript");
    expect(args).toEqual(["-e", ADD_KEYWORDS_SCRIPT, "ID/1", 'Bald "Eagle"']);
    expect(ADD_KEYWORDS_SCRIPT).not.toContain("Eagle");
  });

  it("names a denied Automation permission and an unavailable Photos", async () => {
    execFile.mockImplementationOnce((_c, _a, _o, cb) =>
      cb(new Error("failed"), "", "execution error: Not authorized to send Apple events to Photos. (-1743)"),
    );
    await expect(runOsascript(LOOKUP_SCRIPT, [])).rejects.toMatchObject({ problem: "automation_denied" });
    execFile.mockImplementationOnce((_c, _a, _o, cb) => cb(new Error("failed"), "", "Photos got an error (-600)"));
    await expect(runOsascript(LOOKUP_SCRIPT, [])).rejects.toMatchObject({ problem: "photos_unavailable" });
    expect(scriptErrorNumber('Can’t get media item id "x". (-1728)')).toBe(-1728);
  });
});

describe("runApplePhotos", () => {
  const USER = "00000000-0000-4000-8000-000000000001";
  const CAP_A = "00000000-0000-4000-8000-00000000000a";
  const CAP_B = "00000000-0000-4000-8000-00000000000b";
  const photos = [
    { id: CAP_A, taken_at: TAKEN, refs: ["/lib/Eagle_0001.JPG"], keywords: ["Bald Eagle", "Haliaeetus leucocephalus"] },
    { id: CAP_B, taken_at: TAKEN, refs: ["/lib/IMG_9999.CR3"], keywords: ["Osprey"] },
  ];

  function fakePhotos(): { runner: Runner; calls: Array<{ script: string; args: string[] }> } {
    const calls: Array<{ script: string; args: string[] }> = [];
    const runner: Runner = {
      pause: () => Promise.resolve(),
      run: async (script, args) => {
        calls.push({ script, args });
        if (script === LOOKUP_SCRIPT)
          // Only the camera name of photo A is in Photos; photo B isn't there at all.
          return args.includes("IMG_4411.JPG") ? `IMG_4411.JPG\tPH-1\t${daysSecs(TAKEN.getTime())}\ntz\t0` : "tz\t0";
        return "2";
      },
    };
    return { runner, calls };
  }

  async function run(mode: "check" | "send", runner: Runner) {
    query.mockResolvedValue({ rows: photos });
    applePhotosJob.start((ctx) => runApplePhotos(ctx, USER, [CAP_A, CAP_B], mode, runner), { ...SEND_IDLE, mode });
    await applePhotosJob.settled();
    return applePhotosJob.status;
  }

  it("a check finds photos by their camera file name and changes nothing", async () => {
    const { runner, calls } = fakePhotos();
    const status = await run("check", runner);
    expect(status).toMatchObject({ photos: 2, found: 1, notFound: 1, added: 0, problem: null });
    expect(calls.every((c) => c.script === LOOKUP_SCRIPT)).toBe(true);
  });

  it("sending after a check reuses its matches and only adds keywords to found photos", async () => {
    const { runner, calls } = fakePhotos();
    const status = await run("send", runner);
    expect(status).toMatchObject({ found: 1, notFound: 1, added: 1, failed: 0 });
    expect(calls).toEqual([{ script: ADD_KEYWORDS_SCRIPT, args: ["PH-1", "Bald Eagle", "Haliaeetus leucocephalus"] }]);
  });

  it("reports a denied Automation permission as a problem, not a crash", async () => {
    const runner: Runner = {
      pause: () => Promise.resolve(),
      run: () => Promise.reject(new ApplePhotosError("automation_denied", "no")),
    };
    const status = await run("check", runner);
    expect(status.problem).toBe("automation_denied");
    expect(status.error).toBeNull();
  });
});
