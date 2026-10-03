// Desktop config as a JSON file in the app data dir, so it survives updates.
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
    // external_urls in order (see apply_config in lib.rs). None means switching isn't configured.
    #[serde(rename = "localUrl", skip_serializing_if = "Option::is_none")]
    pub local_url: Option<String>,
    // WiFi network local_url is meant for, compared against the current SSID. None means always
    // try local first.
    #[serde(rename = "localNetworkName", skip_serializing_if = "Option::is_none")]
    pub local_network_name: Option<String>,
    // External addresses in try order. The legacy singular external_url is only read, never
    // written, and read_config promotes it into this list.
    #[serde(rename = "externalUrls", skip_serializing_if = "Option::is_none")]
    pub external_urls: Option<Vec<String>>,
    #[serde(rename = "externalUrl", skip_serializing_if = "Option::is_none")]
    pub external_url: Option<String>,
    #[serde(rename = "offlineMode", skip_serializing_if = "Option::is_none")]
    pub offline_mode: Option<bool>,
    // The library folder last used in local mode and the server last used, remembered across a
    // switch so either is one click away again (switch_to_local_library in lib.rs).
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
    let mut config: DesktopConfig = serde_json::from_str(&contents).ok()?;
    // Promote a lone legacy external_url into the list.
    if config.external_urls.is_none() {
        if let Some(url) = config.external_url.take() {
            config.external_urls = Some(vec![url]);
        }
    }
    Some(config)
}

pub fn write_config(app_data_dir: &Path, config: &DesktopConfig) -> std::io::Result<()> {
    let json = serde_json::to_string_pretty(config)?;
    write_atomic(app_data_dir, json.as_bytes())
}

pub fn clear_config(app_data_dir: &Path) -> std::io::Result<()> {
    write_atomic(app_data_dir, b"{}")
}

// Temp file in the same dir, fsync, then rename, so a crash never leaves a half-written config.
fn write_atomic(app_data_dir: &Path, contents: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    fs::create_dir_all(app_data_dir)?;
    let target = config_path(app_data_dir);
    let tmp = app_data_dir.join(format!("desktop-config.json.{}.tmp", std::process::id()));
    let result = (|| {
        let mut file = fs::File::create(&tmp)?;
        file.write_all(contents)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&tmp, &target)?;
        // Persist the rename itself (directory fsync isn't possible on Windows).
        #[cfg(unix)]
        if let Ok(dir) = fs::File::open(app_data_dir) {
            let _ = dir.sync_all();
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}
