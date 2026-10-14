// Desktop config as a JSON file in the app data dir, so it survives updates.
use crate::fsutil::write_atomic;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct DesktopConfig {
    pub mode: Option<String>,
    #[serde(rename = "dataDir", skip_serializing_if = "Option::is_none")]
    pub data_dir: Option<String>,
    // Single-URL remote mode. None when Automatic URL Switching is configured.
    #[serde(rename = "serverUrl", skip_serializing_if = "Option::is_none")]
    pub server_url: Option<String>,
    // Automatic URL Switching: local_url is tried first when on local_network_name's WiFi, then
    // external_urls in order (see reachable_server in server_watch.rs). None means switching isn't configured.
    #[serde(rename = "localUrl", skip_serializing_if = "Option::is_none")]
    pub local_url: Option<String>,
    // WiFi network local_url is meant for, compared against the current SSID. None means always
    // try local first.
    #[serde(rename = "localNetworkName", skip_serializing_if = "Option::is_none")]
    pub local_network_name: Option<String>,
    // External addresses in try order.
    #[serde(rename = "externalUrls", skip_serializing_if = "Option::is_none")]
    pub external_urls: Option<Vec<String>>,
    #[serde(rename = "offlineMode", skip_serializing_if = "Option::is_none")]
    pub offline_mode: Option<bool>,
    // The library folder last used in local mode and the server last used, remembered across a
    // switch so either is one click away again (switch_to_local_library in commands.rs).
    #[serde(rename = "lastLocalDataDir", skip_serializing_if = "Option::is_none")]
    pub last_local_data_dir: Option<String>,
    #[serde(rename = "lastServerUrl", skip_serializing_if = "Option::is_none")]
    pub last_server_url: Option<String>,
}

fn config_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("desktop-config.json")
}

pub fn read_config(app_data_dir: &Path) -> Option<DesktopConfig> {
    let contents = fs::read_to_string(config_path(app_data_dir)).ok()?;
    serde_json::from_str(&contents).ok()
}

pub fn write_config(app_data_dir: &Path, config: &DesktopConfig) -> std::io::Result<()> {
    let json = serde_json::to_string_pretty(config)?;
    write_atomic(&config_path(app_data_dir), json.as_bytes())?;
    // Every connection change passes through here: drop an offline cache that no longer applies.
    crate::offline_cache::reconcile(app_data_dir, config);
    Ok(())
}

pub fn clear_config(app_data_dir: &Path) -> std::io::Result<()> {
    write_atomic(&config_path(app_data_dir), b"{}")?;
    crate::offline_cache::reconcile(app_data_dir, &DesktopConfig::default());
    Ok(())
}
