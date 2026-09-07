// Tauri equivalent of apps/desktop/src/store.js — same shape, same idea (a plain JSON file
// under the app's own per-install data directory, so it survives updates), just using Tauri's
// app_data_dir() instead of Electron's app.getPath("userData").
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct DesktopConfig {
    pub mode: Option<String>,
    #[serde(rename = "dataDir", skip_serializing_if = "Option::is_none")]
    pub data_dir: Option<String>,
    // Single-URL remote mode (IP switching off) — unchanged from before. When IP switching is
    // on, local_url/external_url are used instead and this stays None; kept around rather than
    // repurposed so an existing single-URL config (from before this feature existed) keeps
    // working exactly as it did, with no migration step.
    #[serde(rename = "serverUrl", skip_serializing_if = "Option::is_none")]
    pub server_url: Option<String>,
    // Immich-style dual-endpoint switching: local_url is tried first (short timeout) at
    // launch/reconnect, falling back to external_url if it doesn't answer — see apply_config in
    // lib.rs. Both are only ever set together (the setup form requires both once "Enable IP
    // switching" is checked); either being None means switching isn't configured.
    #[serde(rename = "localUrl", skip_serializing_if = "Option::is_none")]
    pub local_url: Option<String>,
    #[serde(rename = "externalUrl", skip_serializing_if = "Option::is_none")]
    pub external_url: Option<String>,
    #[serde(rename = "offlineMode", skip_serializing_if = "Option::is_none")]
    pub offline_mode: Option<bool>,
}

fn config_path(app_data_dir: &PathBuf) -> PathBuf {
    app_data_dir.join("desktop-config.json")
}

pub fn read_config(app_data_dir: &PathBuf) -> Option<DesktopConfig> {
    let contents = fs::read_to_string(config_path(app_data_dir)).ok()?;
    serde_json::from_str(&contents).ok()
}

pub fn write_config(app_data_dir: &PathBuf, config: &DesktopConfig) -> std::io::Result<()> {
    fs::create_dir_all(app_data_dir)?;
    let json = serde_json::to_string_pretty(config)?;
    fs::write(config_path(app_data_dir), json)
}

pub fn clear_config(app_data_dir: &PathBuf) -> std::io::Result<()> {
    fs::create_dir_all(app_data_dir)?;
    fs::write(config_path(app_data_dir), "{}")
}
