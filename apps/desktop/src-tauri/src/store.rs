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
    // "Automatic URL Switching" (previously "Enable IP switching"): local_url is tried first at
    // launch/reconnect — gated on whether the machine is CURRENTLY on the WiFi network named by
    // local_network_name (see apply_config in lib.rs) — falling back to the first reachable
    // entry in external_urls if not on that network, or if the local address doesn't answer
    // despite matching. Both local_url and external_urls are only ever set together (the setup
    // form requires at least one external entry once this is enabled); local_url being None
    // means switching isn't configured (server_url above is used instead).
    #[serde(rename = "localUrl", skip_serializing_if = "Option::is_none")]
    pub local_url: Option<String>,
    // A human-readable label for whichever WiFi network local_url is meant for (e.g. "HomeWiFi")
    // — compared against the machine's CURRENT SSID at switch-decision time (see
    // network::current_network_info), not just stored as a cosmetic label. None means "always
    // try local first regardless of network" (matches this feature's pre-redesign behavior, for
    // a config saved before this field existed).
    #[serde(rename = "localNetworkName", skip_serializing_if = "Option::is_none")]
    pub local_network_name: Option<String>,
    // Ordered list of external addresses — array position IS try-order (top to bottom in the
    // Settings UI, user-reorderable there). Replaces the old singular `external_url`, kept below
    // for exactly one purpose: reading an already-saved pre-redesign config so it isn't silently
    // dropped — read_config below promotes a lone external_url into this list on load, and
    // external_url itself is never written by current code (skip_serializing_if keeps it out of
    // any config this app itself writes from here on).
    #[serde(rename = "externalUrls", skip_serializing_if = "Option::is_none")]
    pub external_urls: Option<Vec<String>>,
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
    let mut config: DesktopConfig = serde_json::from_str(&contents).ok()?;
    // A config saved before this redesign has a lone `external_url` and no `external_urls` at
    // all — promote it into a one-element list here, on read, rather than needing a one-time
    // migration step or leaving every pre-redesign install's saved fallback address silently
    // unused by the new (list-based) switching logic below.
    if config.external_urls.is_none() {
        if let Some(url) = config.external_url.take() {
            config.external_urls = Some(vec![url]);
        }
    }
    Some(config)
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
