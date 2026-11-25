// The app's own Tauri commands (permissions/app-commands.toml lists them), and the setup and
// library switching they share with the menu.
use tauri::{AppHandle, Manager, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

use crate::security::{
    grant_remote_capabilities, is_app_page, is_configured_server, is_local_api, is_trusted_sender,
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

// The window background shows during macOS overscroll bounce and before the first page paints.
// ThemeProvider calls this so dark mode doesn't flash light; colors match index.css's --color-canvas.
#[tauri::command]
pub(crate) fn set_window_theme_background(window: WebviewWindow, dark: bool) {
    // Remembered so the next launch opens in the right colour (window_state.rs).
    crate::window_state::save_dark(window.app_handle(), dark);
    let color = if dark {
        tauri::webview::Color(0x14, 0x15, 0x16, 255) // matches theme.css's dark --color-canvas
    } else {
        tauri::webview::Color(0xf6, 0xee, 0xdc, 255) // matches theme.css's light --color-canvas
    };
    let _ = window.set_background_color(Some(color));
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
const OTHER_SERVER: &str =
    "That address is a different server. To change servers, use the library on this computer.";

/// None for the app's own pages. For a connected server's page, the instance id of that server:
/// such a page may only change how the app reaches it, never point the app somewhere else.
fn server_page_instance(window: &WebviewWindow) -> Option<Result<String, String>> {
    if is_app_page(window) {
        return None;
    }
    Some(
        store::read_config(&app_data_dir(window.app_handle()))
            .and_then(|cfg| cfg.server_instance_id)
            .ok_or_else(|| NOT_ALLOWED.to_string()),
    )
}

fn same_instance(required: Option<&str>, reported: Option<&str>) -> bool {
    required.is_none_or(|id| reported == Some(id))
}

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
    navigate_or_picker(window, &format!("http://127.0.0.1:{}", api::LOCAL_PORT));
    Ok(())
}

// Onboarding's Back on its first step: forget the choice just made and show the setup choice
// again. The library folder and its database stay where they are; choosing it again reopens them.
#[tauri::command]
pub(crate) async fn return_to_setup(window: WebviewWindow, app: AppHandle) -> ChooseSetupResult {
    if !is_trusted_sender(&window) {
        return ChooseSetupResult::error(NOT_ALLOWED);
    }
    let mut config = store::read_config(&app_data_dir(&app)).unwrap_or_default();
    // Remembered, so the folder is one click away again.
    config.last_local_data_dir = config.data_dir.take().or(config.last_local_data_dir);
    config.mode = None;
    if let Err(e) = save_config(&app, &config) {
        return ChooseSetupResult::error(e);
    }
    end_server_fallback(&app);
    navigate_or_picker(
        &window,
        &crate::security::bundled_page_url(&app, "picker.html#choose"),
    );
    api::stop_api_async(&app).await;
    ChooseSetupResult::ok()
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
    navigate_or_picker(window, target);
    ensure_server_watcher(app, window);
    // The local library stays up alongside the server window, for the sync jobs (sync.rs). A
    // first connection has no link yet; store_server_link kicks the sync once the page makes one.
    crate::sync::kick(app);
    Ok(())
}

// Automatic URL Switching: connects to the first address that answers, in apply_config's order.
async fn setup_url_switching(
    app: &AppHandle,
    window: &WebviewWindow,
    input: &ChooseSetupInput,
    local_url: &str,
    external_urls: &[String],
    only_instance: Option<&str>,
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
    let mut other_server = false;
    for url in std::iter::once(&local_trimmed).chain(external_trimmed.iter()) {
        if let Some(health) = api::health_info(&format!("{url}/health")).await {
            if !same_instance(only_instance, health.instance_id.as_deref()) {
                other_server = true;
                continue;
            }
            target = Some((url.clone(), health.instance_id));
            break;
        }
    }
    let Some((target, instance_id)) = target else {
        if other_server {
            return Err(OTHER_SERVER.into());
        }
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
        server_instance_id: instance_id,
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
    only_instance: Option<&str>,
) -> Result<(), String> {
    let server_url = input.server_url.as_deref().ok_or("serverUrl is required")?;
    let trimmed = normalize_server_url(server_url)?;
    let Some(health) = api::health_info(&format!("{trimmed}/health")).await else {
        return Err(
            "Couldn't reach that address. Check the URL and that the server is running.".into(),
        );
    };
    if !same_instance(only_instance, health.instance_id.as_deref()) {
        return Err(OTHER_SERVER.into());
    }
    let config = store::DesktopConfig {
        mode: Some("remote".into()),
        server_url: Some(trimmed.clone()),
        server_instance_id: health.instance_id,
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
        // Straight to setup's next step; onboarding sends a library that already has regions on to
        // the collection, so the collection never flashes up first.
        navigate_or_picker(window, &format!("{url}/onboarding"));
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
    let only_instance = match server_page_instance(&window) {
        None => None,
        Some(Ok(id)) if config.mode == "remote" => Some(id),
        Some(_) => return ChooseSetupResult::error(NOT_ALLOWED),
    };
    let only_instance = only_instance.as_deref();
    if config.mode != "remote" {
        return setup_local(&app, &window).await;
    }
    match (&config.local_url, &config.external_urls) {
        (Some(local_url), Some(external_urls)) => {
            setup_url_switching(
                &app,
                &window,
                &config,
                local_url,
                external_urls,
                only_instance,
            )
            .await
        }
        _ => setup_single_server(&app, &window, &config, only_instance).await,
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

// Backs Settings' live reachability checkmark, using the same check as connect time. A server's
// page only learns whether the address reaches that same server, so it can't probe the network.
#[tauri::command]
pub(crate) async fn test_endpoint(window: WebviewWindow, url: String) -> bool {
    if !is_trusted_sender(&window) {
        return false;
    }
    let health = format!("{}/health", url.trim_end_matches('/'));
    match server_page_instance(&window) {
        None => api::is_reachable(&health).await,
        Some(Ok(id)) => {
            let reported = api::health_info(&health).await.and_then(|h| h.instance_id);
            same_instance(Some(&id), reported.as_deref())
        }
        Some(Err(_)) => false,
    }
}

// Backs Settings' "Sign in" step for a remote server (see api::test_login).
#[tauri::command]
pub(crate) async fn test_login(
    window: WebviewWindow,
    url: String,
    email: String,
    password: String,
) -> Result<(), String> {
    if !is_app_page(&window) {
        return Err(NOT_ALLOWED.into());
    }
    let trimmed = url.trim_end_matches('/');
    let cookies = api::test_login(trimmed, &email, &password).await?;
    // The session the check made goes into the window's own cookie store, so the server's page
    // is already signed in when connect_remote navigates there.
    let host = url::Url::parse(trimmed)
        .ok()
        .and_then(|u| u.host_str().map(str::to_owned));
    for raw in cookies {
        if let (Ok(mut cookie), Some(host)) =
            (tauri::webview::cookie::Cookie::parse(raw), host.clone())
        {
            // WKWebView drops a cookie with no domain.
            cookie.set_domain(host);
            if let Err(e) = window.set_cookie(cookie) {
                eprintln!("[lifer] couldn't carry the sign-in over to the window: {e}");
            }
        }
    }
    Ok(())
}

// The desktop credential, for the local library's own pages only: they trade it for the session
// cookie that signs in their requests (apps/web/src/lib/localApiSession.ts). A connected server's
// pages can call this app's commands too, and get nothing.
#[tauri::command]
pub(crate) fn local_api_credential(window: WebviewWindow) -> Option<String> {
    let url = window.url().ok()?;
    is_local_api(&url).then(|| local_credential::launch_token().to_string())
}

#[derive(serde::Serialize)]
pub(crate) struct PickedFile {
    path: String,
    #[serde(rename = "mtimeMs")]
    mtime_ms: f64,
}

// The Import page's Choose files on the local library: the shell's own dialog, so the paths are
// the user's choice and not a page's claim. The shell tells the local API with its own secret
// (apps/api/src/uploads/pickedFiles.ts), which lets the page read these files and, with Move on,
// send them to the Trash once imported. None when cancelled; Err when it can't vouch for them.
#[tauri::command]
pub(crate) async fn pick_import_files(
    app: AppHandle,
    window: WebviewWindow,
) -> Result<Option<Vec<PickedFile>>, String> {
    if !window.url().is_ok_and(|u| is_local_api(&u)) {
        return Err("Not allowed".into());
    }
    let dialog = app.dialog().file().set_parent(&window);
    let picked = tauri::async_runtime::spawn_blocking(move || dialog.blocking_pick_files())
        .await
        .ok()
        .flatten();
    let Some(picked) = picked else {
        return Ok(None);
    };
    let paths: Vec<String> = picked
        .into_iter()
        .filter_map(|p| p.into_path().ok())
        .map(|p| p.to_string_lossy().into_owned())
        .collect();
    api::report_picked_files(&paths).await?;
    Ok(Some(
        paths
            .into_iter()
            .map(|path| {
                let mtime_ms = std::fs::metadata(&path)
                    .and_then(|m| m.modified())
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map_or(0.0, |d| d.as_millis() as f64);
                PickedFile { path, mtime_ms }
            })
            .collect(),
    ))
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
    // A camera RAW: the sidecar matches its embedded preview, as the server would.
    let raw = request
        .headers()
        .get("x-lifer-raw")
        .is_some_and(|v| v == "1");
    local_inference::embed(window.app_handle(), bytes.clone(), &targets, raw).await
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

    #[test]
    fn a_server_page_may_only_target_its_own_server() {
        assert!(
            same_instance(None, None),
            "the app's own pages may pick any server"
        );
        assert!(same_instance(None, Some("b")));
        assert!(same_instance(Some("a"), Some("a")));
        assert!(!same_instance(Some("a"), Some("b")));
        assert!(!same_instance(Some("a"), None));
    }
}
