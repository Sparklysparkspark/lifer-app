// This app has two modes, picked once at first launch (see store.js/picker.html) and
// changeable later from the Lifer menu:
//
//   - "local": spawns the API as a real child process (same tsx-driven entrypoint `npm run
//     dev`/`start` already use) using Electron's OWN bundled binary in Node-emulation mode
//     (ELECTRON_RUN_AS_NODE) rather than requiring a system Node install, then opens a window
//     onto it. Postgres is still an external prerequisite (DATABASE_URL) — bundling an
//     embedded database is bigger, separate work, not attempted here.
//   - "remote": no local API at all — just a native window onto a Lifer server you already
//     run elsewhere. That server's own login page (email/password, forgot password, all of
//     it) handles authentication exactly as it would in a browser; this app is just the
//     window chrome around it.
const { app, BrowserWindow, dialog, ipcMain, Menu } = require("electron");
const { spawn } = require("node:child_process");
const path = require("node:path");
const http = require("node:http");
const https = require("node:https");
const { readConfig, writeConfig, clearConfig } = require("./store.js");

const LOCAL_PORT = process.env.LIFER_DESKTOP_PORT || 4310;

const resourcesRoot = app.isPackaged ? process.resourcesPath : path.join(__dirname, "..", "..");
const apiDir = path.join(resourcesRoot, "api");
const webDistDir = app.isPackaged ? path.join(resourcesRoot, "web") : path.join(resourcesRoot, "web", "dist");
const nodeModulesDir = app.isPackaged ? path.join(resourcesRoot, "node_modules") : path.join(resourcesRoot, "..", "node_modules");

let apiProcess = null;
let mainWindow = null;

function fetchOk(url, timeoutMs = 5000) {
  const client = url.startsWith("https:") ? https : http;
  return new Promise((resolve) => {
    const req = client.get(url, { timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode != null && res.statusCode < 500);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

function waitForServer(url, timeoutMs = 30000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    async function attempt() {
      if (await fetchOk(url, 2000)) return resolve();
      if (Date.now() - start > timeoutMs) {
        return reject(new Error("Lifer's backend didn't respond in time. Check that Postgres is running."));
      }
      setTimeout(attempt, 300);
    }
    attempt();
  });
}

function startApi(dataDir) {
  const tsxDir = path.join(nodeModulesDir, "tsx", "dist");
  apiProcess = spawn(
    process.execPath,
    ["--require", path.join(tsxDir, "preflight.cjs"), "--import", `file://${path.join(tsxDir, "loader.mjs")}`, path.join(apiDir, "src", "index.ts")],
    {
      cwd: apiDir,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        SINGLE_USER_MODE: "1",
        PORT: String(LOCAL_PORT),
        NODE_ENV: "production",
        WEB_DIST_DIR: webDistDir,
        DATABASE_URL: process.env.DATABASE_URL || "postgres://lifer:lifer@localhost:5432/lifer",
        // The folder chosen in the picker (see ipcMain's "lifer:choose-setup" handler),
        // persisted in config so it's remembered across launches. Only the config.ts
        // fallback default (a repo-relative path that doesn't make sense outside a
        // checked-out repo) is used if somehow unset.
        DATA_DIR: dataDir || process.env.DATA_DIR || path.join(app.getPath("userData"), "data"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  apiProcess.stdout.on("data", (chunk) => process.stdout.write(`[api] ${chunk}`));
  apiProcess.stderr.on("data", (chunk) => process.stderr.write(`[api] ${chunk}`));
  apiProcess.on("exit", (code) => {
    if (code !== 0 && mainWindow) {
      dialog.showErrorBox("Lifer stopped unexpectedly", `The backend process exited with code ${code}.`);
    }
  });
}

function stopApi() {
  if (apiProcess) {
    apiProcess.kill();
    apiProcess = null;
  }
}

async function loadLocal(dataDir) {
  startApi(dataDir);
  try {
    await waitForServer(`http://localhost:${LOCAL_PORT}/health`);
    await mainWindow.loadURL(`http://localhost:${LOCAL_PORT}`);
  } catch (err) {
    dialog.showErrorBox("Lifer failed to start", err.message);
  }
}

async function loadRemote(serverUrl) {
  await mainWindow.loadURL(serverUrl);
}

async function applyConfig(config) {
  stopApi();
  if (config.mode === "local") {
    await loadLocal(config.dataDir);
  } else if (config.mode === "remote" && config.serverUrl) {
    await loadRemote(config.serverUrl);
  } else {
    await showPicker();
  }
}

async function showPicker() {
  stopApi();
  await mainWindow.loadFile(path.join(__dirname, "picker.html"));
}

// The same IPC handler the first-run picker uses is also reachable from the React Settings
// page (see SettingsPage.tsx's ElectronBridgeSection), since the preload script's bridge is
// present on every page this window ever loads, not just picker.html. That means any page
// currently loaded — including, in remote mode, a page served by whatever server URL this
// app is pointed at — could technically call it. Restricting to pages this app is already
// configured to trust (its own local server, or the currently-connected remote server) keeps
// a compromised/untrustworthy remote server from silently reconfiguring this app to point
// somewhere else.
function isTrustedSender(event) {
  const url = event.senderFrame.url;
  if (url.startsWith("file://")) return true;
  if (url.startsWith(`http://localhost:${LOCAL_PORT}`)) return true;
  const config = readConfig();
  if (config && config.mode === "remote" && config.serverUrl && url.startsWith(config.serverUrl)) return true;
  return false;
}

ipcMain.handle("lifer:get-config", (event) => {
  if (!isTrustedSender(event)) return null;
  return readConfig();
});

ipcMain.handle("lifer:choose-setup", async (event, config) => {
  if (!isTrustedSender(event)) return { error: "Not allowed from this page." };

  if (config.mode === "remote") {
    const url = config.serverUrl.replace(/\/+$/, "");
    const reachable = await fetchOk(`${url}/health`);
    if (!reachable) {
      return { error: "Couldn't reach that address. Check the URL and that the server is running." };
    }
    writeConfig({ mode: "remote", serverUrl: url });
    await loadRemote(url);
    return { ok: true };
  }

  // A native folder dialog, not a silent default. Canceling leaves whatever's currently
  // loaded alone rather than forcing a choice.
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Choose where Lifer should store your photos",
    properties: ["openDirectory", "createDirectory"],
  });
  if (result.canceled || result.filePaths.length === 0) return { canceled: true };

  const dataDir = result.filePaths[0];
  writeConfig({ mode: "local", dataDir });
  await loadLocal(dataDir);
  return { ok: true };
});

function buildMenu() {
  const template = [
    {
      label: "Lifer",
      submenu: [
        { role: "about" },
        { type: "separator" },
        {
          label: "Change Server / Library…",
          click: async () => {
            clearConfig();
            await showPicker();
          },
        },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 900,
    title: "Lifer",
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, "preload.js"),
    },
  });

  const config = readConfig();
  if (config && config.mode) {
    await applyConfig(config);
  } else {
    await showPicker();
  }
}

app.whenReady().then(() => {
  buildMenu();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  stopApi();
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  stopApi();
});
