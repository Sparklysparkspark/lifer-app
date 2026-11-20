// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database.
// Input validation on the iNaturalist routes: malformed bodies and ids are refused before any
// call to iNaturalist, and well-formed ones still reach the handler.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Reading observations back from iNaturalist (the existing-observations check) never leaves the test.
vi.mock("./observationSync.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fetchObservationPages: vi.fn(async () => 0),
  fetchDeletedObservationIds: vi.fn(async () => []),
  fetchPreview: vi.fn(async () => {
    throw new Error("no network in tests");
  }),
}));

const url = process.env.TEST_DATABASE_URL;
const USER = "eeeeeeee-0000-4000-8000-000000000811";
const TOKEN = "lifer_test_inaturalist_routes_811";
const CAPTURE = "eeeeeeee-0000-4000-8000-000000000812";
const RELAY = "https://liferwildlife.com/inat-callback/";
const invalid = (message: RegExp) => ({ error: expect.stringMatching(message), code: "invalid_request" });

describe.skipIf(!url)("iNaturalist routes input", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  let dataDir: string;
  let cookieName: string;
  let savedConfig: unknown[] = [];

  const call = (method: "GET" | "POST" | "PUT", route: string, payload?: unknown, token: string | null = TOKEN) =>
    app.inject({ method, url: route, payload: payload as object, cookies: token ? { [cookieName]: token } : {} });

  beforeAll(async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "lifer-inat-routes-"));
    process.env.DATABASE_URL = url;
    process.env.DATA_DIR = dataDir;
    process.env.APP_DATA_DIR = path.join(dataDir, "app-data");
    process.env.SINGLE_USER_MODE = "0";
    // Stands in for the built-in client ID, which is empty until Lifer's app is registered.
    process.env.INAT_CLIENT_ID = "test-client";
    process.env.INAT_REDIRECT_URI = RELAY;
    db = new pg.Pool({ connectionString: url });
    const { hashToken } = await import("../auth/session.js");
    ({ SESSION_COOKIE_NAME: cookieName } = await import("@lifer/core/config.js"));
    const { inaturalistRoutes } = await import("./routes.js");
    savedConfig = (await db.query(`SELECT * FROM inat_server_config`)).rows;
    await db.query(`DELETE FROM install_settings WHERE key = 'inat_trusted_origins'`);
    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
    await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'inat-routes@test', 'x')`, [USER]);
    await db.query(`INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 day')`, [
      hashToken(TOKEN),
      USER,
    ]);
    app = Fastify();
    await app.register(cookie);
    await app.register(inaturalistRoutes, { prefix: "/api" });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    if (db) {
      await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
      // The server config is one shared row: put back whatever was there.
      await db.query(`DELETE FROM inat_server_config`);
      for (const row of savedConfig as Array<{ client_id: string | null; redirect_uri: string | null }>) {
        await db.query(`INSERT INTO inat_server_config (id, client_id, redirect_uri) VALUES (true, $1, $2)`, [
          row.client_id,
          row.redirect_uri,
        ]);
      }
      await db.end();
    }
    const { pool } = await import("@lifer/core/db.js");
    await pool.end();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("asks for a session before it looks at the body", async () => {
    expect((await call("POST", "/api/inaturalist/observations", { captureIds: "x" }, null)).statusCode).toBe(401);
  });

  it("refuses a malformed server config and saves a good one", async () => {
    const put = (body: unknown) => call("PUT", "/api/inaturalist/server-config", body);
    const cases: Array<[unknown, RegExp]> = [
      [{ clientId: 42 }, /^Invalid body: clientId /],
      [{ clearClientId: "yes" }, /^Invalid body: clearClientId must be boolean$/],
      [{ redirectUri: "", secret: "x" }, /^Invalid body: unexpected field secret$/],
    ];
    for (const [body, message] of cases) {
      const res = await put(body);
      expect([res.statusCode, res.json()]).toEqual([400, invalid(message)]);
    }
    // What the Settings page sends.
    const ok = await put({ clientId: "abc123", redirectUri: "https://lifer.example/api/inaturalist/callback" });
    expect([ok.statusCode, ok.json()]).toEqual([200, { ok: true }]);
    const row = (await db.query(`SELECT client_id, redirect_uri FROM inat_server_config`)).rows[0];
    expect(row).toEqual({ client_id: "abc123", redirect_uri: "https://lifer.example/api/inaturalist/callback" });
    expect((await put({ clientId: null, redirectUri: "" })).statusCode).toBe(200);
  });

  it("refuses observation requests without well-formed capture ids", async () => {
    const post = (body: unknown) => call("POST", "/api/inaturalist/observations", body);
    const cases: Array<[unknown, RegExp]> = [
      [{}, /^Invalid body: captureIds is required$/],
      [{ captureIds: [] }, /^Invalid body: captureIds /],
      [{ captureIds: CAPTURE }, /^Invalid body: captureIds must be array$/],
      [{ captureIds: ["nope"] }, /^Invalid body: captureIds\.0 must be an id/],
      [{ captureIds: [CAPTURE], regionId: "Alaska" }, /^Invalid body: regionId must be an id/],
      [{ captureIds: [CAPTURE], speciesId: CAPTURE }, /^Invalid body: unexpected field speciesId$/],
    ];
    for (const [body, message] of cases) {
      const res = await post(body);
      expect([res.statusCode, res.json()]).toEqual([400, invalid(message)]);
    }
    // Well-formed: the handler runs and finds no linked account.
    const res = await post({ captureIds: [CAPTURE] });
    expect([res.statusCode, res.json()]).toEqual([409, { error: "iNaturalist account not connected" }]);
  });

  it("checks unfinished observations only with a linked account", async () => {
    const res = await call("POST", "/api/inaturalist/pending/check");
    expect([res.statusCode, res.json()]).toEqual([409, { error: "iNaturalist account not connected" }]);
  });

  it("lets iNaturalist's callback through with its own extra parameters", async () => {
    const res = await call("GET", "/api/inaturalist/callback?code=abc&error_description=x", undefined, null);
    expect([res.statusCode, res.json()]).toEqual([400, { error: "Missing code or state" }]);
  });

  it("takes a linked desktop's sign-in on the server, stored encrypted", async () => {
    const body = { accessToken: "at-from-desktop", refreshToken: null, inatUserId: "7", inatUsername: "desk-birder" };
    expect((await call("PUT", "/api/inaturalist/account", body, null)).statusCode).toBe(401);
    expect((await call("PUT", "/api/inaturalist/account", body)).statusCode).toBe(200);
    const row = await db.query(`SELECT access_token, inat_username FROM user_inaturalist_accounts WHERE user_id = $1`, [
      USER,
    ]);
    expect(row.rows[0].inat_username).toBe("desk-birder");
    expect(row.rows[0].access_token).not.toContain("at-from-desktop");
    await db.query(`DELETE FROM user_inaturalist_accounts WHERE user_id = $1`, [USER]);
  });

  describe("sign-in through the relay page", () => {
    const connect = (headers: Record<string, string>) =>
      app.inject({ method: "POST", url: "/api/inaturalist/connect", headers, cookies: { [cookieName]: TOKEN } });
    const trust = (headers: Record<string, string>, address: string) =>
      app.inject({
        method: "POST",
        url: "/api/inaturalist/trust",
        headers,
        payload: { address },
        cookies: { [cookieName]: TOKEN },
      });
    // The first sign-in from an address asks; the answer is remembered.
    const authorizeParams = async (headers: Record<string, string>, address: string) => {
      const first = await connect(headers);
      expect(first.statusCode).toBe(200);
      if (first.json().needsTrust) {
        expect(first.json().address).toBe(address);
        expect((await trust(headers, address)).statusCode).toBe(200);
      }
      const res = await connect(headers);
      expect(res.statusCode).toBe(200);
      return new URL(res.json().authorizeUrl).searchParams;
    };
    const originIn = (state: string) => Buffer.from(state.split(".")[1], "base64url").toString();

    it("sends the relay as redirect_uri, with the origin the browser used in state", async () => {
      const https = await authorizeParams(
        { host: "lifer.example.com", "x-forwarded-proto": "https" },
        "https://lifer.example.com",
      );
      expect(https.get("redirect_uri")).toBe(RELAY);
      expect(https.get("client_id")).toBeTruthy();
      expect(originIn(https.get("state")!)).toBe("https://lifer.example.com");
      const lan = await authorizeParams({ host: "192.168.1.20:30080" }, "http://192.168.1.20:30080");
      expect(originIn(lan.get("state")!)).toBe("http://192.168.1.20:30080");
    });

    it("refuses to start from a public address over plain http", async () => {
      const res = await connect({ host: "lifer.example.com" });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/https/);
    });

    it("uses a saved redirect URI as is, without the relay's origin in state", async () => {
      const own = "https://lifer.example.com/api/inaturalist/callback";
      await db.query(`UPDATE inat_server_config SET redirect_uri = $1`, [own]);
      try {
        const params = await authorizeParams({ host: "lifer.example.com", "x-forwarded-proto": "https" }, "");
        expect(params.get("redirect_uri")).toBe(own);
        expect(params.get("state")).not.toContain(".");
      } finally {
        await db.query(`UPDATE inat_server_config SET redirect_uri = NULL`);
      }
    });

    it("finishes a state it issued, exchanging the code with the relay redirect_uri", async () => {
      const params = await authorizeParams(
        { host: "lifer.example.com", "x-forwarded-proto": "https" },
        "https://lifer.example.com",
      );
      const tokenBodies: URLSearchParams[] = [];
      const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        const target = String(input);
        if (target.endsWith("/oauth/token")) {
          tokenBodies.push(init!.body as URLSearchParams);
          return Response.json({ access_token: "at", refresh_token: "rt" });
        }
        if (target.endsWith("/users/api_token")) return Response.json({ api_token: "jwt" });
        return Response.json({ results: [{ id: 42, login: "relay-birder" }] });
      });
      try {
        const query = new URLSearchParams({ code: "c0de", state: params.get("state")! });
        const res = await call("GET", `/api/inaturalist/callback?${query}`);
        expect(res.body).toContain("Connected as relay-birder");
        expect(tokenBodies).toHaveLength(1);
        expect(tokenBodies[0].get("redirect_uri")).toBe(RELAY);
        expect(tokenBodies[0].get("code")).toBe("c0de");
        expect(tokenBodies[0].get("code_verifier")).toBeTruthy();
        // One use only.
        const again = await call("GET", `/api/inaturalist/callback?${query}`);
        expect(again.body).toContain("expired");
      } finally {
        fetchMock.mockRestore();
        await db.query(`DELETE FROM user_inaturalist_accounts WHERE user_id = $1`, [USER]);
      }
    });

    it("asks once per address, and only for the address the browser is using", async () => {
      const headers = { host: "other.example.com", "x-forwarded-proto": "https" };
      const first = await connect(headers);
      expect(first.json()).toEqual({ needsTrust: true, address: "https://other.example.com" });
      const wrong = await trust(headers, "https://evil.example.com");
      expect(wrong.statusCode).toBe(400);
      expect((await trust(headers, "https://other.example.com")).statusCode).toBe(200);
      expect((await connect(headers)).json().authorizeUrl).toContain("https://www.inaturalist.org");
    });

    it("won't finish a sign-in from a different session or with no session", async () => {
      const params = await authorizeParams(
        { host: "lifer.example.com", "x-forwarded-proto": "https" },
        "https://lifer.example.com",
      );
      const fetchMock = vi.spyOn(globalThis, "fetch");
      try {
        const query = new URLSearchParams({ code: "c0de", state: params.get("state")! });
        const other = await call("GET", `/api/inaturalist/callback?${query}`, undefined, "another-session-token");
        expect(other.body).toContain("different window");
        const none = await call("GET", `/api/inaturalist/callback?${query}`, undefined, null);
        // The attempt is spent once seen, so the owner's own late callback no longer works either.
        expect(none.body).toContain("expired");
        expect(fetchMock).not.toHaveBeenCalled();
      } finally {
        fetchMock.mockRestore();
      }
    });

    it("rejects a state it never issued", async () => {
      const fetchMock = vi.spyOn(globalThis, "fetch");
      try {
        const forged = Buffer.from("https://lifer.example.com").toString("base64url");
        const res = await call("GET", `/api/inaturalist/callback?code=c&state=made-up.${forged}`);
        expect(res.body).toContain("expired");
        expect(fetchMock).not.toHaveBeenCalled();
      } finally {
        fetchMock.mockRestore();
      }
    });
  });
});
