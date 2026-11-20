import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  buildReport,
  deleteCrashReport,
  listCrashReports,
  normalizeReport,
  redact,
  saveCrashReport,
  sendCrashReport,
} from "./report.js";

const HOME = "/Users/judah";
const USER = "judah";

// Everything here is user data that must never leave the computer.
const SECRETS = [
  "judah",
  "Pictures",
  "Birds 2026",
  "Costa Rica",
  "IMG_4821",
  "Owl at dusk",
  "Turdus migratorius",
  "Snowy Owl",
  "Big Year",
  "My Albums",
  "judah@example.com",
  "lifer_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789",
  "eyJhbGciOiJIUzI1NiJ9",
  "s3cr3tSessionValue",
  "hunter2",
  "49.2827",
  "-123.1207",
  "192.168.1.20",
  "nas.local",
  "D:\\Photos",
  "Wildlife",
  "9f86d081884c7d659a2feaa0c55ad015",
];

const MESSAGE = [
  `ENOENT: no such file or directory, open '/Users/judah/Pictures/Birds 2026/Costa Rica/IMG_4821.CR3'`,
  `Species "Turdus migratorius" not found in album 'Big Year' (Snowy Owl)`,
  `duplicate key value violates unique constraint "albums_name_key" Key (name)=(My Albums) already exists.`,
  `Upload of Owl at dusk.jpg failed for judah@example.com with key lifer_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789`,
  `Authorization: Bearer eyJhbGciOiJIUzI1NiJ9 cookie lifer_session=s3cr3tSessionValue password=hunter2`,
  `at 49.2827,-123.1207 via http://192.168.1.20:3000/api/photos?token=abc and https://nas.local/x`,
  `copy D:\\Photos\\Wildlife\\IMG_4821.NEF to ~/Pictures/Birds 2026/out failed, hash 9f86d081884c7d659a2feaa0c55ad015`,
  `Cannot read properties of undefined (reading 'scientificName')`,
].join("\n");

const STACK = [
  "TypeError: Cannot read properties of undefined (reading 'scientificName')",
  "    at fileCapture (file:///Applications/Lifer.app/Contents/Resources/api/dist/captures/routes.js:120:15)",
  "    at async Promise.all (index 0)",
  "    at Object.handler (/Users/judah/Development/lifer-app/apps/api/src/uploads/routes.ts:88:7)",
  "    at C:\\Users\\judah\\AppData\\Local\\Lifer\\api\\dist\\index.js:10:3",
  "    at readPhoto (/Users/judah/Pictures/Birds 2026/Costa Rica/IMG_4821.CR3)",
  "    at http://127.0.0.1:47321/assets/index-B3kd8sl2.js:1:2345",
  'called `Result::unwrap()` on an `Err` value: Os { code: 2, message: "No such file or directory" }',
  "   1: std::panicking::begin_panic",
  "             at /rustc/90b35a6239c3d8bdabc530a6a0816f7ff89a0aaf/library/std/src/panicking.rs:12:5",
].join("\n");

describe("redact", () => {
  const out = redact(`${MESSAGE}\n${STACK}`, HOME, USER);

  it("leaves no user data behind", () => {
    for (const secret of SECRETS) expect(out, secret).not.toContain(secret);
    expect(out).not.toMatch(/\/Users|AppData|Applications/);
  });

  it("keeps Lifer's own source frames as a file name and line", () => {
    expect(out).toContain("routes.js:120:15");
    expect(out).toContain("routes.ts:88:7");
    expect(out).toContain("index.js:10:3");
    expect(out).toContain("index-B3kd8sl2.js:1:2345");
    expect(out).toContain("(reading 'scientificName')");
    expect(out).toContain("`Result::unwrap()`");
    expect(out).toContain("at panicking.rs:12:5");
    expect(out).toContain("ENOENT: no such file or directory");
  });
});

describe("crash report files", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "lifer-crash-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("saves redacted reports, keeps the newest ten and deletes by id", () => {
    for (let i = 0; i < 12; i++) {
      saveCrashReport(
        buildReport("server-exception", new Error(`boom ${i} in /Users/x/a.jpg`), new Date(1_000 + i)),
        dir,
      );
    }
    const reports = listCrashReports(dir);
    expect(reports).toHaveLength(10);
    expect(reports[0]).toMatchObject({ id: "1011", report: { app: "lifer", kind: "server-exception" } });
    expect(reports[0].report.message).toBe("Error: boom 11 in <path>");
    expect(Object.keys(reports[0].report).sort()).toEqual(
      ["app", "arch", "kind", "message", "os", "stack", "timestamp", "version"].sort(),
    );
    deleteCrashReport("1011", dir);
    deleteCrashReport("../1010", dir);
    expect(listCrashReports(dir)[0].id).toBe("1010");
  });

  it("reads the desktop shell's reports and drops unreadable ones", () => {
    writeFileSync(
      path.join(dir, "5000.json"),
      JSON.stringify({
        app: "lifer",
        kind: "desktop-panic",
        message: "panicked",
        stack: "",
        timestamp: 5000,
        log: "x",
      }),
    );
    writeFileSync(path.join(dir, "6000.json"), "{not json");
    const reports = listCrashReports(dir);
    expect(reports).toHaveLength(1);
    expect(reports[0].report.timestamp).toBe(new Date(5000).toISOString());
    expect(reports[0].report).not.toHaveProperty("log");
    expect(readdirSync(dir)).toEqual(["5000.json"]);
  });

  it("refuses unknown kinds", () => {
    expect(normalizeReport({ kind: "other", message: "x" })).toBeNull();
  });
});

describe("sendCrashReport", () => {
  let server: Server;
  let url: string;
  let status = 204;
  let received: { body: unknown; type?: string } | null = null;

  beforeAll(async () => {
    server = createServer((req: IncomingMessage, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        received = { body: JSON.parse(body), type: req.headers["content-type"] };
        if (status === 0) return; // never answers
        res.writeHead(status).end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/crash`;
  });
  afterAll(() => {
    server.closeAllConnections();
    server.close();
  });

  const report = buildReport("web-error", new Error("boom"), new Date(0));

  it("posts the payload with the note", async () => {
    status = 204;
    await sendCrashReport(report, "  clicked Import  ", url);
    expect(received).toEqual({ body: { ...report, note: "clicked Import" }, type: "application/json" });
  });

  it("leaves the note out when blank, and fails on anything but 204", async () => {
    status = 500;
    await expect(sendCrashReport(report, " ", url)).rejects.toThrow(/500/);
    expect(received!.body).not.toHaveProperty("note");
  });

  it("gives up after the timeout", async () => {
    status = 0;
    await expect(sendCrashReport(report, undefined, url, 50)).rejects.toThrow();
  });
});
