// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database.
// The crash sheet's routes against a local stand-in for the report server.
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const USER = "eeeeeeee-0000-4000-8000-000000000931";
const TOKEN = "lifer_test_crash_reports_931";

describe.skipIf(!url)("crash report routes", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  let dir: string;
  let cookieName: string;
  let stub: Server;
  let status = 204;
  const received: unknown[] = [];

  const call = (method: "GET" | "POST", route: string, payload?: unknown) =>
    app.inject({ method, url: `/api${route}`, payload: payload as object, cookies: { [cookieName]: TOKEN } });
  const ids = async () =>
    (await call("GET", "/crash-reports")).json().reports.map((r: { id: string }) => r.id) as string[];

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "lifer-crash-routes-"));
    process.env.DATABASE_URL = url;
    process.env.SINGLE_USER_MODE = "0";
    stub = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        received.push(JSON.parse(body));
        res.writeHead(status).end();
      });
    });
    await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
    db = new pg.Pool({ connectionString: url });
    const { hashToken } = await import("../auth/session.js");
    ({ SESSION_COOKIE_NAME: cookieName } = await import("@lifer/core/config.js"));
    const { crashReportRoutes } = await import("./routes.js");
    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
    await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'crash-reports@test', 'x')`, [USER]);
    await db.query(`INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 day')`, [
      hashToken(TOKEN),
      USER,
    ]);
    app = Fastify();
    await app.register(cookie);
    const reportUrl = `http://127.0.0.1:${(stub.address() as AddressInfo).port}/v1/crash`;
    await app.register(crashReportRoutes, { prefix: "/api", reportUrl, dir });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    stub?.close();
    if (db) {
      await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
      await db.end();
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("needs a session", async () => {
    expect((await app.inject({ method: "GET", url: "/api/crash-reports" })).statusCode).toBe(401);
  });

  it("records a web error redacted, and sends exactly what it shows", async () => {
    const recorded = await call("POST", "/crash-reports", {
      message: "TypeError: x is undefined in album 'Big Year'",
      stack: "at render (http://127.0.0.1:3000/assets/index-abc.js:1:2)\nat /Users/someone/Pictures/owl.jpg",
    });
    expect(recorded.statusCode).toBe(200);
    const { reports } = (await call("GET", "/crash-reports")).json();
    expect(reports).toHaveLength(1);
    expect(reports[0].report).toMatchObject({
      app: "lifer",
      kind: "web-error",
      message: "TypeError: x is undefined in album '<redacted>'",
      stack: "at render (index-abc.js:1:2)\nat <path>",
    });

    status = 204;
    const sent = await call("POST", "/crash-reports/send", { ids: [reports[0].id], note: "Opening an album" });
    expect(sent.statusCode).toBe(200);
    expect(received.at(-1)).toEqual({ ...reports[0].report, note: "Opening an album" });
    expect(readdirSync(dir)).toEqual([]);
  });

  it("keeps the report when sending fails, then dismisses it", async () => {
    await call("POST", "/crash-reports", { message: "boom", stack: "" });
    const [id] = await ids();
    status = 503;
    const failed = await call("POST", "/crash-reports/send", { ids: [id] });
    expect(failed.statusCode).toBe(502);
    expect(await ids()).toEqual([id]);

    const saved = await call("GET", "/crash-reports/download");
    expect(saved.headers["content-disposition"]).toContain("lifer-crash-report.json");
    expect(saved.json()).toHaveLength(1);

    expect((await call("POST", "/crash-reports/dismiss", { ids: [id] })).statusCode).toBe(200);
    expect(await ids()).toEqual([]);
  });

  it("refuses ids that aren't report ids", async () => {
    expect((await call("POST", "/crash-reports/dismiss", { ids: ["../settings"] })).statusCode).toBe(400);
  });
});
