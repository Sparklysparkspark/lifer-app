// A second API in desktop mode (SINGLE_USER_MODE), for desktop-only features: companion apps, the
// Lightroom Classic import. It shares the run's database and mirror, keeps its library and app data
// under the caller's folder, and takes the per-launch secret the Tauri shell would give it. Pages
// get in through a stubbed shell answering local_api_credential with the same secret.
import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LOCAL_DATABASE_URL, MIRROR_URL } from "./constants.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const API_DIR = path.join(REPO_ROOT, "apps", "api");
const PORT = Number(process.env.E2E_DESKTOP_PORT ?? 4519);
export const DESKTOP_URL = `http://127.0.0.1:${PORT}`;

export interface DesktopApi {
  /** The desktop library folder (DATA_DIR), inside the caller's folder. */
  dataDir: string;
  stop(): Promise<void>;
}

/** Starts the desktop-mode API with `launchToken` as LIFER_LAUNCH_TOKEN; the caller removes `dir`. */
export async function startDesktopApi(launchToken: string, dir: string): Promise<DesktopApi> {
  const dataDir = path.join(dir, "library");
  const appDataDir = path.join(dir, "app-data");
  for (const d of [dataDir, appDataDir]) mkdirSync(d, { recursive: true });
  mkdirSync(path.join(REPO_ROOT, "test-results"), { recursive: true });
  const log = createWriteStream(path.join(REPO_ROOT, "test-results", "e2e-desktop-server.log"), { flags: "a" });
  // E2E_API_DIST as in startServer.ts, so both servers run the same build.
  const api: ChildProcess = spawn(process.execPath, [`${process.env.E2E_API_DIST ?? "dist"}/index.js`], {
    cwd: API_DIR,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      NODE_ENV: "production",
      PORT: String(PORT),
      DATABASE_URL: process.env.E2E_DATABASE_URL ?? LOCAL_DATABASE_URL,
      SINGLE_USER_MODE: "1",
      LIFER_LAUNCH_TOKEN: launchToken,
      LIFER_ALLOW_UNTOKENED_DESKTOP: "",
      GBIF_USER: "",
      GBIF_PWD: "",
      EBIRD_API_KEY: "",
      INAT_CLIENT_ID: "",
      DATA_DIR: dataDir,
      APP_DATA_DIR: appDataDir,
      LIFER_GPU: "off",
      PACK_INDEX_URL: `${MIRROR_URL}/pack-index.json`,
      CATALOG_MANIFEST_URL: `${MIRROR_URL}/catalog-manifest.json`,
      CATALOG_SEED_URL: `${MIRROR_URL}/catalog-seed.sql.gz`,
      MAP_DOWNLOAD_URL: `${MIRROR_URL}/world.pmtiles`,
      // As the main e2e server: anything else that reaches for the internet is refused by the mirror.
      NODE_USE_ENV_PROXY: "1",
      HTTP_PROXY: MIRROR_URL,
      HTTPS_PROXY: MIRROR_URL,
      NO_PROXY: "127.0.0.1,localhost",
    },
  });
  api.stdout!.pipe(log, { end: false });
  api.stderr!.pipe(log, { end: false });

  const stop = async () => {
    if (api.exitCode === null) {
      const exited = new Promise((resolve) => api.once("exit", resolve));
      api.kill("SIGTERM");
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 8000))]);
    }
    log.end();
  };
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (api.exitCode !== null) {
      await stop();
      throw new Error("The desktop-mode API exited at startup; see test-results/e2e-desktop-server.log");
    }
    const up = await fetch(`${DESKTOP_URL}/health`).then(
      (r) => r.ok,
      () => false,
    );
    if (up) return { dataDir, stop };
    if (Date.now() > deadline) {
      await stop();
      throw new Error("The desktop-mode API didn't start in time");
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}
