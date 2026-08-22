// This app has two distinct modes, picked once and remembered: run its own local library
// (spawns the API itself, see main.js), or just be a native window onto a Lifer server
// running elsewhere (a Docker/NAS deployment) — no local API spawned at all in that case,
// since the remote server already has its own. Stored outside the app bundle
// (app.getPath("userData")) so it survives updates.
const { app } = require("electron");
const { readFileSync, writeFileSync, mkdirSync } = require("node:fs");
const path = require("node:path");

const CONFIG_PATH = path.join(app.getPath("userData"), "desktop-config.json");

function readConfig() {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
  } catch {
    return null;
  }
}

function writeConfig(config) {
  mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

function clearConfig() {
  writeFileSync(CONFIG_PATH, "{}");
}

module.exports = { readConfig, writeConfig, clearConfig };
