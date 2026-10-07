import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const settings = vi.hoisted(() => ({
  current: {} as Record<string, unknown>,
  written: [] as Array<Record<string, unknown>>,
}));
vi.mock("@lifer/core/localSettings.js", () => ({
  readLocalSettings: () => settings.current,
  writeLocalSettings: (patch: Record<string, unknown>) => settings.written.push(patch),
}));
// The SQL itself is checked against a real database in storageMove.integration.test.ts. Here the
// client records which (old, new) pair each relink query got, and can be told to fail.
const db = vi.hoisted(() => ({
  relinks: [] as unknown[][],
  fail: false,
  during: null as (() => Promise<void>) | null,
}));
vi.mock("@lifer/core/db.js", () => ({
  withTransaction: async (fn: (c: { query: (sql: string, params: unknown[]) => Promise<void> }) => Promise<void>) => {
    if (db.fail) throw new Error("database unavailable");
    await db.during?.();
    return fn({ query: async (_sql, params) => void db.relinks.push(params) });
  },
}));
const config = vi.hoisted(() => ({ dataDir: "", desktop: true }));
vi.mock("@lifer/core/config.js", () => ({
  get DATA_DIR() {
    return config.dataDir;
  },
  get SINGLE_USER_MODE() {
    return config.desktop;
  },
}));
// Signed in means this header here; the session check itself has its own tests.
vi.mock("../auth/session.js", () => ({
  requireAuth: async (
    request: { headers: Record<string, unknown> },
    reply: { code: (n: number) => { send: (b: unknown) => void } },
  ) => {
    if (request.headers["x-test-signed-in"] !== "1") reply.code(401).send({ error: "Sign in" });
  },
}));
// Real rename/cp unless a test swaps one in: EXDEV acts out a move to another drive.
type FsCall = (...args: unknown[]) => Promise<unknown>;
const fsFake = vi.hoisted(() => ({ rename: null as FsCall | null, cp: null as FsCall | null }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...real,
    rename: (...args: unknown[]) => (fsFake.rename ?? (real.rename as FsCall))(...args),
    cp: (...args: unknown[]) => (fsFake.cp ?? (real.cp as FsCall))(...args),
  };
});

const { moveDirectoryContents, recoverInterruptedStorageMigration, storageMoveRoutes } =
  await import("./storageMove.js");

function fsError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: simulated`), { code });
}

let root: string;
let from: string;
let to: string;
beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "lifer-move-"));
  from = path.join(root, "old");
  to = path.join(root, "new");
  settings.current = {};
  settings.written = [];
  db.relinks = [];
  db.fail = false;
  db.during = null;
  fsFake.rename = fsFake.cp = null;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("recoverInterruptedStorageMigration", () => {
  beforeEach(() => {
    mkdirSync(from);
    mkdirSync(to);
    writeFileSync(path.join(from, "left-behind.jpg"), "x");
    writeFileSync(path.join(to, "complete-copy.jpg"), "x");
  });

  it("does nothing when no move was in progress", async () => {
    await recoverInterruptedStorageMigration();
    expect(settings.written).toEqual([]);
    expect(existsSync(path.join(from, "left-behind.jpg"))).toBe(true);
    expect(existsSync(path.join(to, "complete-copy.jpg"))).toBe(true);
  });

  it("finishes a move whose copy completed, even with the old folder only partly deleted", async () => {
    settings.current = { migration: { from, to, copied: true } };
    await recoverInterruptedStorageMigration();
    expect(existsSync(path.join(to, "complete-copy.jpg"))).toBe(true);
    expect(existsSync(from)).toBe(false);
    expect(db.relinks.length).toBeGreaterThan(0);
    expect(db.relinks.every((params) => params[0] === from && params[1] === to)).toBe(true);
    expect(settings.written.at(-1)).toStrictEqual({ dataDir: to, migration: undefined });
  });

  it("finishes a copied move whose old folder is already fully deleted", async () => {
    rmSync(from, { recursive: true });
    settings.current = { migration: { from, to, copied: true } };
    await recoverInterruptedStorageMigration();
    expect(settings.written.at(-1)).toStrictEqual({ dataDir: to, migration: undefined });
  });

  it("rolls back a move interrupted while copying, keeping the originals", async () => {
    settings.current = { migration: { from, to } };
    await recoverInterruptedStorageMigration();
    expect(existsSync(to)).toBe(false);
    expect(existsSync(path.join(from, "left-behind.jpg"))).toBe(true);
    expect(db.relinks).toEqual([]);
    expect(settings.written.at(-1)).toStrictEqual({ dataDir: from, migration: undefined });
  });

  it("rolls back when the crash came before the new folder was even created", async () => {
    rmSync(to, { recursive: true });
    settings.current = { migration: { from, to } };
    await recoverInterruptedStorageMigration();
    expect(existsSync(path.join(from, "left-behind.jpg"))).toBe(true);
    expect(settings.written.at(-1)).toStrictEqual({ dataDir: from, migration: undefined });
  });

  // The rename moved everything but the process died before the marker was cleared. Rolling back
  // here would delete the only copy of the library.
  it("finishes, never rolls back, a move whose old folder is already empty", async () => {
    rmSync(path.join(from, "left-behind.jpg"));
    settings.current = { migration: { from, to } };
    await recoverInterruptedStorageMigration();
    expect(existsSync(path.join(to, "complete-copy.jpg"))).toBe(true);
    expect(settings.written.at(-1)).toStrictEqual({ dataDir: to, migration: undefined });
  });
});

describe("moveDirectoryContents", () => {
  beforeEach(() => {
    mkdirSync(path.join(from, "Birds"), { recursive: true });
    writeFileSync(path.join(from, "Birds", "osprey.jpg"), "osprey");
  });

  it("renames on the same drive, creating the new folder's parents, without copying a byte", async () => {
    const inode = statSync(path.join(from, "Birds", "osprey.jpg")).ino;
    const dest = path.join(root, "nested", "new");
    await moveDirectoryContents(from, dest);
    expect(statSync(path.join(dest, "Birds", "osprey.jpg")).ino).toBe(inode);
    expect(existsSync(from)).toBe(false);
  });

  it("copies then deletes across drives, noting the copy finished before deleting anything", async () => {
    fsFake.rename = () => Promise.reject(fsError("EXDEV"));
    const events: string[] = [];
    fsFake.cp = async (...args) => {
      const { cp } = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
      await cp(args[0] as string, args[1] as string, args[2] as object);
      events.push(`copied, old still there: ${existsSync(from)}`);
    };
    await moveDirectoryContents(from, to, () => events.push(`onCopied, old still there: ${existsSync(from)}`));
    expect(events).toEqual(["copied, old still there: true", "onCopied, old still there: true"]);
    expect(readFileSync(path.join(to, "Birds", "osprey.jpg"), "utf8")).toBe("osprey");
    expect(existsSync(from)).toBe(false);
  });

  it("keeps file times when copying across drives", async () => {
    const old = new Date("2020-05-01T12:00:00Z");
    const { utimes } = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    await utimes(path.join(from, "Birds", "osprey.jpg"), old, old);
    fsFake.rename = () => Promise.reject(fsError("EXDEV"));
    await moveDirectoryContents(from, to);
    expect(statSync(path.join(to, "Birds", "osprey.jpg")).mtime.toISOString()).toBe(old.toISOString());
  });

  it("clears a partial copy and keeps the originals when the copy fails", async () => {
    fsFake.rename = () => Promise.reject(fsError("EXDEV"));
    fsFake.cp = async () => {
      mkdirSync(path.join(to, "Birds"), { recursive: true });
      writeFileSync(path.join(to, "Birds", "half.jpg"), "partial");
      throw fsError("ENOSPC");
    };
    const onCopied = vi.fn();
    await expect(moveDirectoryContents(from, to, onCopied)).rejects.toMatchObject({ code: "ENOSPC" });
    expect(existsSync(to)).toBe(false);
    expect(readFileSync(path.join(from, "Birds", "osprey.jpg"), "utf8")).toBe("osprey");
    expect(onCopied).not.toHaveBeenCalled();
  });
});

describe("storage routes", () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    config.dataDir = from;
    config.desktop = true;
    mkdirSync(path.join(from, "Birds"), { recursive: true });
    writeFileSync(path.join(from, "Birds", "osprey.jpg"), "osprey");
    app = Fastify();
    await app.register(storageMoveRoutes);
  });
  afterEach(() => app.close());

  const signedIn = { "x-test-signed-in": "1" };
  const put = (dataDir: unknown, query = "") =>
    app.inject({ method: "PUT", url: `/settings/storage${query}`, payload: { dataDir } as object, headers: signedIn });
  const get = (url: string) => app.inject({ method: "GET", url, headers: signedIn });
  const libraryUntouched = () => expect(readFileSync(path.join(from, "Birds", "osprey.jpg"), "utf8")).toBe("osprey");

  it("needs a signed-in user for every storage route", async () => {
    expect((await app.inject({ method: "GET", url: "/settings/storage" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/settings/storage/status" })).statusCode).toBe(401);
    const res = await app.inject({ method: "PUT", url: "/settings/storage", payload: { dataDir: to } });
    expect(res.statusCode).toBe(401);
    libraryUntouched();
    expect(settings.written).toEqual([]);
  });

  it("reports the library folder and whether this install can change it", async () => {
    config.desktop = false;
    const res = await get("/settings/storage");
    expect(res.json()).toEqual({ dataDir: from, changeable: false });
  });

  it("moves the library, relinks stored paths and asks for a restart", async () => {
    const res = await put(to);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ dataDir: to, previousDataDir: from, filesMoved: true, restartRequired: true });
    expect(readFileSync(path.join(to, "Birds", "osprey.jpg"), "utf8")).toBe("osprey");
    expect(existsSync(from)).toBe(false);
    expect(db.relinks.length).toBeGreaterThan(0);
    expect(db.relinks.every((params) => params[0] === from && params[1] === to)).toBe(true);
    // The marker is written before anything moves, so a crash mid-move is recoverable.
    expect(settings.written[0]).toEqual({ migration: { from, to } });
    // toStrictEqual: `migration: undefined` is what clears the marker, so it must be there.
    expect(settings.written.at(-1)).toStrictEqual({ dataDir: to, migration: undefined });
  });

  it("notes when a move across drives has finished copying, so a crash then finishes it", async () => {
    fsFake.rename = () => Promise.reject(fsError("EXDEV"));
    expect((await put(to)).statusCode).toBe(200);
    expect(readFileSync(path.join(to, "Birds", "osprey.jpg"), "utf8")).toBe("osprey");
    expect(existsSync(from)).toBe(false);
    expect(settings.written).toStrictEqual([
      { migration: { from, to } },
      { migration: { from, to, copied: true } },
      { dataDir: to, migration: undefined },
    ]);
  });

  it("reports relinking while stored paths are being rewritten", async () => {
    const phases: unknown[] = [];
    db.during = async () => void phases.push((await get("/settings/storage/status")).json().phase);
    await put(to);
    expect(phases).toEqual(["relinking"]);
  });

  it("refuses on a server, where the library folder is a bind mount", async () => {
    config.desktop = false;
    expect((await put(to)).statusCode).toBe(404);
    expect((await get("/settings/storage/status")).statusCode).toBe(404);
    libraryUntouched();
    expect(settings.written).toEqual([]);
  });

  it("refuses a destination that isn't an absolute path", async () => {
    const res = await put("relative/folder");
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("dataDir must be an absolute path");
    libraryUntouched();
  });

  it.each([
    ["a missing dataDir", { dataDir: undefined }, "", /^Invalid body: dataDir is required$/],
    ["an empty dataDir", { dataDir: "" }, "", /^Invalid body: dataDir /],
    ["a dataDir that isn't text", { dataDir: 42 }, "", /^Invalid body: dataDir must be string$/],
    ["an unknown field", { dataDir: "/x", force: true }, "", /^Invalid body: unexpected field force$/],
    ["a background value other than 1", { dataDir: "/x" }, "?background=yes", /^Invalid query: background must be 1$/],
  ])("refuses %s before touching anything", async (_name, payload, query, error) => {
    const res = await app.inject({ method: "PUT", url: `/settings/storage${query}`, payload, headers: signedIn });
    expect([res.statusCode, res.json()]).toEqual([
      400,
      { error: expect.stringMatching(error), code: "invalid_request" },
    ]);
    libraryUntouched();
    expect(settings.written).toEqual([]);
  });

  it("answers a server with desktop_only before looking at the body", async () => {
    config.desktop = false;
    const res = await app.inject({
      method: "PUT",
      url: "/settings/storage",
      payload: { dataDir: 42 },
      headers: signedIn,
    });
    expect([res.statusCode, res.json().code]).toEqual([404, "desktop_only"]);
  });

  it("refuses a request with no body", async () => {
    const res = await app.inject({ method: "PUT", url: "/settings/storage", headers: signedIn });
    expect(res.statusCode).toBe(400);
    libraryUntouched();
  });

  it("refuses the current location", async () => {
    const res = await put(from);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("That's already the current storage location");
    libraryUntouched();
  });

  it("refuses to move a library into a folder that already has files, touching neither", async () => {
    mkdirSync(to);
    writeFileSync(path.join(to, "someone-elses.txt"), "keep me");
    const res = await put(to);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/isn't empty/);
    libraryUntouched();
    expect(readFileSync(path.join(to, "someone-elses.txt"), "utf8")).toBe("keep me");
    expect(settings.written).toEqual([]);
  });

  it("moves into an existing empty folder", async () => {
    mkdirSync(to);
    expect((await put(to)).statusCode).toBe(200);
    expect(readFileSync(path.join(to, "Birds", "osprey.jpg"), "utf8")).toBe("osprey");
  });

  it("just switches folders when the library is empty, even to one that has files", async () => {
    rmSync(path.join(from, "Birds"), { recursive: true });
    mkdirSync(to);
    writeFileSync(path.join(to, "existing.jpg"), "x");
    const res = await put(to);
    expect(res.json()).toEqual({ dataDir: to, previousDataDir: from, filesMoved: false, restartRequired: true });
    expect(existsSync(path.join(to, "existing.jpg"))).toBe(true);
    expect(db.relinks).toEqual([]);
    expect(settings.written).toStrictEqual([{ dataDir: to, migration: undefined }]);
  });

  it("creates the new folder when there was never a library to move", async () => {
    rmSync(from, { recursive: true });
    const res = await put(to);
    expect(res.json().filesMoved).toBe(false);
    expect(statSync(to).isDirectory()).toBe(true);
  });

  it("asks for a restart before a second move, since DATA_DIR still names the old folder", async () => {
    expect((await put(to)).statusCode).toBe(200);
    const res = await put(path.join(root, "third"));
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("Restart Lifer before moving the library again");
  });

  it("refuses a second move while one is running, and reports progress in the background", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    fsFake.rename = async (...args) => {
      await gate;
      const { rename } = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
      return rename(args[0] as string, args[1] as string);
    };
    const started = await put(to, "?background=1");
    expect(started.json()).toEqual({ started: true });
    const second = await put(path.join(root, "third"));
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toBe("Your library is already being moved");
    const running = await get("/settings/storage/status");
    expect(running.json()).toMatchObject({ running: true, phase: "moving", currentItem: to });
    release();
    await vi.waitFor(async () => {
      const done = await get("/settings/storage/status");
      expect(done.json()).toMatchObject({ running: false, result: { dataDir: to, filesMoved: true } });
    });
  });

  it("keeps the library where it was and says why when the move fails", async () => {
    fsFake.rename = () => Promise.reject(fsError("EXDEV"));
    fsFake.cp = () => Promise.reject(new Error("disk full"));
    const res = await put(to);
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: "Couldn't move your library: disk full", code: "storage_move_failed" });
    libraryUntouched();
    expect(existsSync(to)).toBe(false);
    // The marker is dropped, so the next start doesn't try to recover a move that never happened.
    expect(settings.written).toStrictEqual([{ migration: { from, to } }, { migration: undefined }]);
  });

  it("leaves the marker for startup recovery when relinking fails after the files moved", async () => {
    db.fail = true;
    const res = await put(to);
    expect(res.statusCode).toBe(500);
    expect(readFileSync(path.join(to, "Birds", "osprey.jpg"), "utf8")).toBe("osprey");
    expect(settings.written.at(-1)).toEqual({ migration: { from, to } });
  });
});
