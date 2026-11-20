#!/usr/bin/env node
// Lifer's example companion app: the whole public surface in one small program, with no
// dependencies. docs/docs/api/plugins.md walks through it.
//
//   node plugin.mjs --install [--dir <folder>]   writes the manifest into Lifer's plugins folder
//   plugin.mjs --lifer-host --protocol=1         how Lifer launches it (LIFER_HOST_TICKET set)
//
// LIFER_API_URL overrides the desktop API address (http://127.0.0.1:4310), for tests.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ID = "com.example.lifer-example";
const NAME = "Example companion";
const SCOPES = ["userdata.read", "imports.write"];
const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIFER = (process.env.LIFER_API_URL ?? "http://127.0.0.1:4310").replace(/\/$/, "");

/** Where Lifer looks for manifests on this system. */
function pluginsFolder() {
  const home = os.homedir();
  if (process.platform === "darwin") return path.join(home, "Library/Application Support/app.lifer.desktop/plugins");
  if (process.platform === "win32")
    return path.join(process.env.APPDATA ?? path.join(home, "AppData/Roaming"), "app.lifer.desktop/plugins");
  return path.join(process.env.XDG_DATA_HOME || path.join(home, ".local/share"), "app.lifer.desktop/plugins");
}

function install() {
  const at = process.argv.indexOf("--dir");
  const dir = at > 0 ? process.argv[at + 1] : pluginsFolder();
  const self = fileURLToPath(import.meta.url);
  // shortcut: Lifer runs `executable` directly, so on Windows a real app points at its own .exe;
  // this script relies on its shebang, which works on macOS and Linux only.
  if (process.platform !== "win32") chmodSync(self, 0o755);
  const manifest = {
    schema: 1,
    id: ID,
    name: NAME,
    publisher: "https://example.com",
    homepage: "https://example.com/lifer-example",
    support: "https://example.com/support",
    version: "1.0.0",
    executable: { darwin: self, linux: self, win32: self },
    protocol: [1],
    page: { label: "Example", icon: "M4 4h16v16H4z", accent: "#2f7d5b", surface: "default" },
    scopes: SCOPES,
    capabilities: ["pickers", "notifications"],
  };
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${ID}.json`);
  writeFileSync(file, JSON.stringify(manifest, null, 2));
  console.log(file);
}

if (process.argv.includes("--install")) {
  install();
  process.exit(0);
}
if (!process.argv.includes("--lifer-host")) {
  console.error("Lifer starts this app. To add it to Lifer, run: node plugin.mjs --install");
  process.exit(2);
}

// ---- Launched by Lifer ----

const ticket = process.env.LIFER_HOST_TICKET ?? "";
if (!/^[0-9a-f]{64}$/.test(ticket)) {
  console.error("LIFER_HOST_TICKET is missing");
  process.exit(2);
}
// The page's own requests carry this; Lifer hands it to the page in the `credential` message.
const pageToken = randomBytes(24).toString("base64url");
// Kept in memory only for the example. A real app stores its key in the OS credential store.
const state = { key: null, paired: false, species: null, sample: null, error: null, job: null };

const same = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

async function lifer(method, route, body) {
  const headers = { "x-lifer-client": "1" };
  if (state.key) headers["x-api-key"] = state.key;
  if (body) headers["content-type"] = "application/json";
  const res = await fetch(`${LIFER}${route}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`Lifer answered ${res.status}: ${data?.error ?? res.statusText}`);
  return data;
}

// The first time, this waits until the user answers Lifer's consent dialog.
async function pair() {
  try {
    const { key } = await lifer("POST", "/api/plugins/v1/pair", { ticket, pluginId: ID, scopes: SCOPES });
    state.key = key;
    state.paired = true;
    await readSpecies();
  } catch (err) {
    state.error = err.message;
  }
}

async function readSpecies() {
  const rows = [];
  let cursor = null;
  do {
    const page = await lifer("GET", `/api/userdata/v1/species${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`);
    rows.push(...page.items);
    cursor = page.nextCursor ?? null;
  } while (cursor);
  state.species = rows.length;
  state.sample = rows[0] ?? null;
  state.error = null;
}

async function importFolder(folder) {
  const { id } = await lifer("POST", "/api/imports/v1/folders", { path: folder, mode: "copy" });
  for (;;) {
    state.job = await lifer("GET", `/api/imports/v1/jobs/${id}`);
    if (!state.job.running) return;
    await new Promise((r) => setTimeout(r, 500));
  }
}

function send(res, status, body, type = "application/json") {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

async function readJson(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return JSON.parse(raw || "{}");
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  try {
    // Proves this is the process Lifer launched: only it knows the ticket.
    if (url.pathname === "/lifer-host/health") {
      const nonce = url.searchParams.get("nonce") ?? "";
      if (!/^[0-9a-f]{64}$/.test(nonce)) return send(res, 400, { error: "bad nonce" });
      return send(res, 200, { proof: createHmac("sha256", ticket).update(nonce).digest("hex") });
    }
    // The page itself needs no token; everything it asks for does.
    if (req.method === "GET" && url.pathname === "/") {
      return send(res, 200, readFileSync(path.join(HERE, "page.html"), "utf8"), "text/html; charset=utf-8");
    }
    const presented = req.headers["x-page-token"];
    if (typeof presented !== "string" || !same(presented, pageToken)) return send(res, 401, { error: "no page token" });

    if (req.method === "GET" && url.pathname === "/state") {
      const { key: _key, ...shown } = state;
      return send(res, 200, shown);
    }
    if (req.method === "POST" && url.pathname === "/refresh") {
      await readSpecies().catch((err) => (state.error = err.message));
      return send(res, 200, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/import") {
      const { folder } = await readJson(req);
      if (typeof folder !== "string" || !path.isAbsolute(folder)) return send(res, 400, { error: "folder" });
      state.job = { running: true };
      importFolder(folder).catch((err) => (state.error = err.message));
      return send(res, 202, { ok: true });
    }
    send(res, 404, { error: "not found" });
  } catch (err) {
    send(res, 500, { error: err.message });
  }
});

server.listen(0, "127.0.0.1", () => {
  const { port } = server.address();
  console.log(`LIFER_PLUGIN_READY port=${port} page=/ pageToken=${pageToken}`);
  void pair();
});

// Leave with Lifer: when stdin closes, or when Lifer's process is gone.
process.stdin.resume();
process.stdin.on("end", () => process.exit(0));
const parent = Number(process.env.LIFER_WATCH_PARENT_PID);
if (parent > 0) {
  setInterval(() => {
    try {
      process.kill(parent, 0);
    } catch {
      process.exit(0);
    }
  }, 2000).unref();
}
