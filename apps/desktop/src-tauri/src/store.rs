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
    // The server's own id (GET /health instanceId), learned when connecting. A configured address
    // only counts as this server while it reports the same id, so a changed address or a
    // reinstalled server is never mistaken for the one the app knows.
    #[serde(rename = "serverInstanceId", skip_serializing_if = "Option::is_none")]
    pub server_instance_id: Option<String>,
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
    write_atomic(&config_path(app_data_dir), json.as_bytes(), None)?;
    // Every connection change passes through here: drop a server link that no longer applies.
    crate::server_link::reconcile(app_data_dir, config);
    Ok(())
}

pub fn clear_config(app_data_dir: &Path) -> std::io::Result<()> {
    write_atomic(&config_path(app_data_dir), b"{}", None)?;
    crate::server_link::reconcile(app_data_dir, &DesktopConfig::default());
    Ok(())
}

// Phone companion settings (companion.rs), beside the desktop config.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CompanionSettings {
    // At least one phone is paired: the LAN listener runs while this is true.
    #[serde(default)]
    pub paired: bool,
    // Closing the window keeps the shell, API and database running in the menu bar or tray.
    #[serde(rename = "keepSyncing", default = "default_true")]
    pub keep_syncing: bool,
    // The one-time "Lifer keeps syncing" notice has been shown.
    #[serde(rename = "closeNoticeShown", default)]
    pub close_notice_shown: bool,
}

fn default_true() -> bool {
    true
}

impl Default for CompanionSettings {
    fn default() -> Self {
        Self {
            paired: false,
            keep_syncing: true,
            close_notice_shown: false,
        }
    }
}

fn companion_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("companion.json")
}

pub fn read_companion(app_data_dir: &Path) -> CompanionSettings {
    fs::read_to_string(companion_path(app_data_dir))
        .ok()
        .and_then(|c| serde_json::from_str(&c).ok())
        .unwrap_or_default()
}

pub fn write_companion(app_data_dir: &Path, settings: &CompanionSettings) -> std::io::Result<()> {
    let json = serde_json::to_string_pretty(settings)?;
    write_atomic(&companion_path(app_data_dir), json.as_bytes(), None)
}

#[cfg(test)]
mod companion_tests {
    use super::*;

    #[test]
    fn companion_settings_default_to_keep_syncing_and_survive_a_round_trip() {
        let dir =
            std::env::temp_dir().join(format!("lifer-store-companion-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        assert_eq!(read_companion(&dir), CompanionSettings::default());
        assert!(read_companion(&dir).keep_syncing && !read_companion(&dir).paired);
        let s = CompanionSettings {
            paired: true,
            keep_syncing: false,
            close_notice_shown: true,
        };
        write_companion(&dir, &s).unwrap();
        assert_eq!(read_companion(&dir), s);
        fs::write(companion_path(&dir), "{}").unwrap();
        assert!(read_companion(&dir).keep_syncing);
        let _ = fs::remove_dir_all(&dir);
    }
}
