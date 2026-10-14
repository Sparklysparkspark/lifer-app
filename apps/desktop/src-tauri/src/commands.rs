// The app's own Tauri commands (permissions/app-commands.toml lists them), and the setup and
// library switching they share with the menu.
use tauri::{AppHandle, Manager, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

use crate::security::{
    grant_remote_capabilities, is_configured_server, is_local_api, is_trusted_sender,
};
use crate::server_watch::{end_server_fallback, ensure_server_watcher};
use crate::{
    api, app_data_dir, local_credential, local_inference, navigate_or_picker, network, store,
};

#[derive(serde::Serialize)]
pub(crate) struct AppInstallInfo {
    path: String,
    translocated: bool,
}

// The .app bundle on macOS, the executable's folder elsewhere.
pub(crate) fn install_path() -> Option<std::path::PathBuf> {
    let exe = std::env::current_exe().ok()?;
    #[cfg(target_os = "macos")]
    if let Some(bundle) = exe
        .ancestors()
        .find(|p| p.extension().is_some_and(|e| e == "app"))
    {
        return Some(bundle.to_path_buf());
    }
    exe.parent().map(|p| p.to_path_buf())
}

pub(crate) fn is_translocated(path: &std::path::Path) -> bool {
    path.to_string_lossy().contains("/AppTranslocation/")
}

// Lets Settings explain a failed in-place update (macOS runs quarantined apps from a read-only
// temporary copy that can't replace itself).
#[tauri::command]
pub(crate) fn app_install_info() -> AppInstallInfo {
    let path = install_path().unwrap_or_default();
    AppInstallInfo {
        translocated: is_translocated(&path),
        path: path.to_string_lossy().into_owned(),
    }
}

#[tauri::command]
pub(crate) fn platform() -> &'static str {
    // Node's process.platform naming ("darwin", not "macos"); apps/web checks these strings.
    if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(target_os = "windows") {
        "win32"
    } else {
        "linux"
    }
}

// Node's process.arch naming ("x64", not "x86_64"), the suffix the release assets use; the
// manual-update link in apps/web picks the macOS zip by it.
pub(crate) fn arch() -> &'static str {
    if cfg!(target_arch = "aarch64") {
        "arm64"
    } else if cfg!(target_arch = "x86_64") {
        "x64"
    } else {
        std::env::consts::ARCH
    }
}

// The window background shows during macOS overscroll bounce. ThemeProvider calls this so dark
// mode doesn't flash light; colors match index.css's --color-canvas.
#[tauri::command]
pub(crate) fn set_window_theme_background(window: WebviewWindow, dark: bool) {
    let color = if dark {
        tauri::webview::Color(0x14, 0x15, 0x16, 255) // matches theme.css's dark --color-canvas
    } else {
        tauri::webview::Color(0xf6, 0xee, 0xdc, 255) // matches theme.css's light --color-canvas
    };
    let _ = window.set_background_color(Some(color));
}

// The round colour behind the traffic lights (window_controls.rs): "active", "inactive" or "off".
// The page calls it as the window gains or loses focus and as the theme changes. Nothing off macOS.
#[tauri::command]
pub(crate) fn set_traffic_light_backdrop(window: WebviewWindow, state: String) {
    #[cfg(target_os = "macos")]
    {
        use crate::window_controls::{set_backdrop, Backdrop};
        let backdrop = match state.as_str() {
            "active" => Backdrop::Active,
            "inactive" => Backdrop::Inactive,
            _ => Backdrop::Off,
        };
        if let Ok(ns_window) = window.ns_window() {
            set_backdrop(ns_window, backdrop);
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (window, state);
}

#[tauri::command]
pub(crate) fn get_config(window: WebviewWindow) -> Option<store::DesktopConfig> {
    if !is_trusted_sender(&window) {
        return None;
    }
    store::read_config(&app_data_dir(window.app_handle()))
}

// Called after Settings > Storage moves the library. start_api passes DATA_DIR from this config
// and the env var beats the API's own settings file, so it must be updated here. Local mode only.
#[tauri::command]
pub(crate) fn set_local_data_dir(window: WebviewWindow, data_dir: String) -> Result<(), String> {
    let url = window.url().map_err(|e| e.to_string())?;
    if !is_local_api(&url) {
        return Err("Not allowed from this page.".into());
    }
    if !std::path::Path::new(&data_dir).is_absolute() {
        return Err("The library folder must be an absolute path.".into());
    }
    let app_data = app_data_dir(window.app_handle());
    let mut config = store::read_config(&app_data).unwrap_or_default();
    if config.mode.as_deref() != Some("local") {
        return Err("This install isn't using a local library.".into());
    }
    config.data_dir = Some(data_dir);
    store::write_config(&app_data, &config).map_err(|e| e.to_string())
}

// Trims and validates a server address typed into setup/Settings.
fn normalize_server_url(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim().trim_end_matches('/');
    match url::Url::parse(trimmed) {
        Ok(u) if matches!(u.scheme(), "http" | "https") && u.host_str().is_some() => Ok(trimmed.to_string()),
        _ => Err(format!("\"{trimmed}\" isn't a valid server address. Use a full address like http://192.168.1.10:4310.")),
    }
}

#[derive(serde::Deserialize)]
pub(crate) struct ChooseSetupInput {
    mode: String,
    #[serde(rename = "serverUrl")]
    server_url: Option<String>,
    // Only present when Automatic URL Switching is on (see picker.html). local_url and a
    // non-empty external_urls come together; setting both is what turns the feature on.
    #[serde(rename = "localUrl")]
    local_url: Option<String>,
    #[serde(rename = "localNetworkName")]
    local_network_name: Option<String>,
    #[serde(rename = "externalUrls")]
    external_urls: Option<Vec<String>>,
    #[serde(rename = "offlineMode")]
    offline_mode: Option<bool>,
}

#[derive(serde::Serialize)]
pub(crate) struct ChooseSetupResult {
    #[serde(skip_serializing_if = "Option::is_none")]
    ok: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    canceled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

impl ChooseSetupResult {
    fn ok() -> Self {
        Self {
            ok: Some(true),
            canceled: None,
            error: None,
        }
    }
    fn canceled() -> Self {
        Self {
            ok: None,
            canceled: Some(true),
            error: None,
        }
    }
    fn error(message: impl Into<String>) -> Self {
        Self {
            ok: None,
            canceled: None,
            error: Some(message.into()),
        }
    }
}

impl From<Result<(), String>> for ChooseSetupResult {
    fn from(result: Result<(), String>) -> Self {
        match result {
            Ok(()) => Self::ok(),
            Err(e) => Self::error(e),
        }
    }
}

const NOT_ALLOWED: &str = "Not allowed from this page.";

fn save_config(app: &AppHandle, config: &store::DesktopConfig) -> Result<(), String> {
    store::write_config(&app_data_dir(app), config)
        .map_err(|e| format!("Couldn't save the connection settings: {e}"))
}

/// The library folder last used in local mode, from the saved config.
pub(crate) fn remembered_local_dir(app: &AppHandle) -> Option<String> {
    let cfg = store::read_config(&app_data_dir(app))?;
    if cfg.mode.as_deref() == Some("local") {
        cfg.data_dir.or(cfg.last_local_data_dir)
    } else {
        cfg.last_local_data_dir
    }
}

/// The server last connected to, from the saved config.
fn remembered_server(app: &AppHandle) -> Option<String> {
    let cfg = store::read_config(&app_data_dir(app))?;
    cfg.server_url.or(cfg.local_url).or(cfg.last_server_url)
}

/// Opens the library on this computer: the folder last used in local mode, else the default one
/// (the same library the offline fallback uses). Remembers the server, so connecting again is one
/// step in Settings, Server. Used by the menu, signing out of a server, and its sign-in page.
pub(crate) async fn switch_to_local_library(
    app: &AppHandle,
    window: &WebviewWindow,
) -> Result<(), String> {
    let data_dir = remembered_local_dir(app);
    let config = store::DesktopConfig {
        mode: Some("local".into()),
        data_dir: data_dir.clone(),
        last_local_data_dir: data_dir.clone(),
        last_server_url: remembered_server(app),
        ..Default::default()
    };
    store::write_config(&app_data_dir(app), &config)
        .map_err(|e| format!("Couldn't save the connection: {e}"))?;
    end_server_fallback(app);
    api::stop_api_async(app).await;
    api::start_api(app, data_dir).await?;
    let url = format!("http://127.0.0.1:{}", api::LOCAL_PORT);
    api::wait_for_server(&format!("{url}/health"), 120_000).await?;
    navigate_or_picker(window, &url);
    Ok(())
}

// Backs "Use the library on this computer" (signing out of a server, its sign-in page).
#[tauri::command]
pub(crate) async fn use_local_library(window: WebviewWindow, app: AppHandle) -> ChooseSetupResult {
    if !is_trusted_sender(&window) {
        return ChooseSetupResult::error(NOT_ALLOWED);
    }
    switch_to_local_library(&app, &window).await.into()
}

/// Saves a remote config, then moves the window to `target` and starts watching the server.
async fn connect_remote(
    app: &AppHandle,
    window: &WebviewWindow,
    config: store::DesktopConfig,
    target: &str,
) -> Result<(), String> {
    save_config(app, &config)?;
    end_server_fallback(app);
    grant_remote_capabilities(app, &config);
    api::stop_api_async(app).await;
    navigate_or_picker(window, target);
    ensure_server_watcher(app, window);
    Ok(())
}

// Automatic URL Switching: connects to the first address that answers, in apply_config's order.
async fn setup_url_switching(
    app: &AppHandle,
    window: &WebviewWindow,
    input: &ChooseSetupInput,
    local_url: &str,
    external_urls: &[String],
) -> Result<(), String> {
    if external_urls.is_empty() {
        return Err("At least one external URL is required.".into());
    }
    let local_trimmed = normalize_server_url(local_url)?;
    let external_trimmed = external_urls
        .iter()
        .map(|u| normalize_server_url(u))
        .collect::<Result<Vec<_>, _>>()?;
    let mut target = None;
    if api::is_reachable(&format!("{local_trimmed}/health")).await {
        target = Some(local_trimmed.clone());
    } else {
        for url in &external_trimmed {
            if api::is_reachable(&format!("{url}/health")).await {
                target = Some(url.clone());
                break;
            }
        }
    }
    let Some(target) = target else {
        return Err(
            "Couldn't reach any of the addresses. Check the URLs and that the server is running."
                .into(),
        );
    };
    let config = store::DesktopConfig {
        mode: Some("remote".into()),
        local_url: Some(local_trimmed.clone()),
        local_network_name: input.local_network_name.clone(),
        external_urls: Some(external_trimmed),
        offline_mode: input.offline_mode,
        last_local_data_dir: remembered_local_dir(app),
        last_server_url: Some(local_trimmed),
        ..Default::default()
    };
    connect_remote(app, window, config, &target).await
}

async fn setup_single_server(
    app: &AppHandle,
    window: &WebviewWindow,
    input: &ChooseSetupInput,
) -> Result<(), String> {
    let server_url = input.server_url.as_deref().ok_or("serverUrl is required")?;
    let trimmed = normalize_server_url(server_url)?;
    if !api::is_reachable(&format!("{trimmed}/health")).await {
        return Err(
            "Couldn't reach that address. Check the URL and that the server is running.".into(),
        );
    }
    let config = store::DesktopConfig {
        mode: Some("remote".into()),
        server_url: Some(trimmed.clone()),
        offline_mode: input.offline_mode,
        last_local_data_dir: remembered_local_dir(app),
        last_server_url: Some(trimmed.clone()),
        ..Default::default()
    };
    connect_remote(app, window, config, &trimmed).await
}

async fn setup_local(app: &AppHandle, window: &WebviewWindow) -> ChooseSetupResult {
    // The native picker blocks until closed, so keep it off the async workers.
    let dialog = app
        .dialog()
        .file()
        .set_title("Choose where Lifer should store your photos");
    let folder = tauri::async_runtime::spawn_blocking(move || dialog.blocking_pick_folder())
        .await
        .ok()
        .flatten();
    let Some(path) = folder else {
        return ChooseSetupResult::canceled();
    };
    let data_dir = path.to_string();
    let config = store::DesktopConfig {
        mode: Some("local".into()),
        data_dir: Some(data_dir.clone()),
        last_local_data_dir: Some(data_dir.clone()),
        last_server_url: remembered_server(app),
        ..Default::default()
    };
    let result: Result<(), String> = async {
        save_config(app, &config)?;
        end_server_fallback(app);
        api::stop_api_async(app).await;
        api::start_api(app, Some(data_dir)).await?;
        let url = format!("http://127.0.0.1:{}", api::LOCAL_PORT);
        api::wait_for_server(&format!("{url}/health"), 30_000).await?;
        navigate_or_picker(window, &url);
        Ok(())
    }
    .await;
    result.into()
}

#[tauri::command]
pub(crate) async fn choose_setup(
    window: WebviewWindow,
    app: AppHandle,
    config: ChooseSetupInput,
) -> ChooseSetupResult {
    if !is_trusted_sender(&window) {
        return ChooseSetupResult::error(NOT_ALLOWED);
    }
    if config.mode != "remote" {
        return setup_local(&app, &window).await;
    }
    match (&config.local_url, &config.external_urls) {
        (Some(local_url), Some(external_urls)) => {
            setup_url_switching(&app, &window, &config, local_url, external_urls).await
        }
        _ => setup_single_server(&app, &window, &config).await,
    }
    .into()
}

#[derive(serde::Serialize)]
pub(crate) struct CurrentNetworkInfo {
    #[serde(rename = "localIp")]
    local_ip: Option<String>,
    #[serde(rename = "wifiName")]
    wifi_name: Option<String>,
}

// Backs Settings' "use current connection" button: autofills the LAN IP and WiFi name.
#[tauri::command]
pub(crate) fn current_network_info(window: WebviewWindow) -> CurrentNetworkInfo {
    if !is_trusted_sender(&window) {
        return CurrentNetworkInfo {
            local_ip: None,
            wifi_name: None,
        };
    }
    CurrentNetworkInfo {
        local_ip: network::current_lan_ip(),
        wifi_name: network::current_wifi_ssid(),
    }
}

// Backs Settings' live reachability checkmark, using the same check as connect time.
#[tauri::command]
pub(crate) async fn test_endpoint(window: WebviewWindow, url: String) -> bool {
    if !is_trusted_sender(&window) {
        return false;
    }
    let trimmed = url.trim_end_matches('/');
    api::is_reachable(&format!("{trimmed}/health")).await
}

// Backs Settings' "Sign in" step for a remote server (see api::test_login).
#[tauri::command]
pub(crate) async fn test_login(
    window: WebviewWindow,
    url: String,
    email: String,
    password: String,
) -> Result<(), String> {
    if !is_trusted_sender(&window) {
        return Err(NOT_ALLOWED.into());
    }
    let trimmed = url.trim_end_matches('/');
    api::test_login(trimmed, &email, &password).await
}

// The desktop credential, for the local library's own pages only: they trade it for the session
// cookie that signs in their requests (apps/web/src/lib/localApiSession.ts). A connected server's
// pages can call this app's commands too, and get nothing.
#[tauri::command]
pub(crate) fn local_api_credential(window: WebviewWindow) -> Option<String> {
    let url = window.url().ok()?;
    is_local_api(&url).then(|| local_credential::launch_token().to_string())
}

// Local matching is only for a connected server's own pages; in local mode the local API already
// runs the models itself.
fn local_inference_allowed(window: &WebviewWindow) -> Result<(), String> {
    let url = window.url().map_err(|_| NOT_ALLOWED.to_string())?;
    let remote = store::read_config(&app_data_dir(window.app_handle())).is_some_and(|cfg| {
        cfg.mode.as_deref() == Some("remote") && is_configured_server(cfg, &url)
    });
    if remote {
        Ok(())
    } else {
        Err("Local matching is only used when connected to a server.".into())
    }
}

#[tauri::command]
pub(crate) async fn local_inference_status(
    window: WebviewWindow,
) -> Result<serde_json::Value, String> {
    local_inference_allowed(&window)?;
    local_inference::status(window.app_handle()).await
}

// `info` is the server's GET /species/matching-info; starts the sidecar and any model download.
#[tauri::command]
pub(crate) async fn local_inference_prepare(
    window: WebviewWindow,
    info: serde_json::Value,
) -> Result<serde_json::Value, String> {
    local_inference_allowed(&window)?;
    local_inference::prepare(window.app_handle(), info).await
}

// The photo arrives as the raw IPC body (no JSON number array); x-lifer-targets names the vectors.
#[tauri::command]
pub(crate) async fn local_embed(
    window: WebviewWindow,
    request: tauri::ipc::Request<'_>,
) -> Result<serde_json::Value, String> {
    local_inference_allowed(&window)?;
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("Expected the photo as raw bytes.".into());
    };
    let targets = request
        .headers()
        .get("x-lifer-targets")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    local_inference::embed(window.app_handle(), bytes.clone(), &targets).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_server_url_trims_and_rejects_non_web_addresses() {
        assert_eq!(
            normalize_server_url("  http://192.168.1.10:4310/ ").unwrap(),
            "http://192.168.1.10:4310"
        );
        assert!(normalize_server_url("192.168.1.10:4310").is_err());
        assert!(normalize_server_url("file:///tmp").is_err());
    }
}
