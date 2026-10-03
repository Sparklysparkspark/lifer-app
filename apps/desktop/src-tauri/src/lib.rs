mod api;
mod embedded_db;
mod local_inference;
mod network;
mod store;

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use std::collections::HashSet;
use std::sync::Mutex;
use tauri::ipc::CapabilityBuilder;
use tauri::{AppHandle, Emitter, Listener, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

const WINDOW_LABEL: &str = "main";
const PICKER_URL: &str = "tauri://localhost/picker.html";

fn is_local_api(url: &url::Url) -> bool {
    url.scheme() == "http"
        && matches!(url.host_str(), Some("127.0.0.1") | Some("localhost"))
        && url.port() == Some(api::LOCAL_PORT)
}

// Full origin (scheme + host + port), so a different service on the same host isn't trusted.
fn is_configured_server(cfg: store::DesktopConfig, url: &url::Url) -> bool {
    let mut candidates = vec![cfg.server_url, cfg.local_url];
    candidates.extend(cfg.external_urls.unwrap_or_default().into_iter().map(Some));
    candidates
        .into_iter()
        .flatten()
        .any(|s| url::Url::parse(&s).is_ok_and(|server| server.origin() == url.origin()))
}

// What a connected server's pages may call. Registered at runtime for the configured origins
// only (see grant_remote_capabilities); there is deliberately no static wildcard capability.
// fs writes are limited to paths the user picked in a save dialog (the dialog plugin adds them
// to the fs scope); updater installs are signature-checked against the pubkey in tauri.conf.json.
const REMOTE_PERMISSIONS: &[&str] = &[
    "core:default",
    "core:window:allow-start-dragging",
    "core:window:allow-set-fullscreen",
    "core:window:allow-is-fullscreen",
    "allow-app-commands",
    "opener:default",
    "dialog:default",
    // downloadFile.ts and the Stats CSV export save through a native Save As dialog.
    "fs:allow-write-file",
    "fs:allow-write-text-file",
    // Settings > Updates and the update banner update the desktop app itself in remote mode too.
    "updater:allow-check",
    "updater:allow-download",
    "updater:allow-install",
    // Relaunch after installing an update. No process exit.
    "process:allow-restart",
];

// Origins already granted this run. Tauri can add capabilities at runtime but not remove them,
// so a server dropped from the config keeps its grant until relaunch; on_navigation still
// refuses to load it.
#[derive(Default)]
struct RemoteCapabilities(Mutex<HashSet<String>>);

fn configured_origins(cfg: &store::DesktopConfig) -> Vec<String> {
    let mut candidates = vec![cfg.server_url.clone(), cfg.local_url.clone()];
    candidates.extend(cfg.external_urls.clone().unwrap_or_default().into_iter().map(Some));
    let mut origins: Vec<String> = candidates
        .into_iter()
        .flatten()
        .filter_map(|s| url::Url::parse(&s).ok())
        .filter(|u| matches!(u.scheme(), "http" | "https") && !is_local_api(u))
        .map(|u| u.origin().ascii_serialization())
        .collect();
    origins.sort();
    origins.dedup();
    origins
}

fn grant_remote_capabilities(app: &AppHandle, cfg: &store::DesktopConfig) {
    if cfg.mode.as_deref() != Some("remote") {
        return;
    }
    let state = app.state::<RemoteCapabilities>();
    let mut granted = state.0.lock().unwrap();
    for origin in configured_origins(cfg) {
        if granted.contains(&origin) {
            continue;
        }
        // Tauri panics on a pattern it can't parse, so check it first.
        if origin.parse::<tauri::utils::acl::RemoteUrlPattern>().is_err() {
            eprintln!("[lifer] skipping IPC grant for unparseable origin {origin:?}");
            continue;
        }
        let capability = REMOTE_PERMISSIONS.iter().fold(
            CapabilityBuilder::new(format!("remote-server-{}", granted.len()))
                .window(WINDOW_LABEL)
                .local(false)
                .remote(origin.clone()),
            |cap, permission| cap.permission(*permission),
        );
        match app.add_capability(capability) {
            Ok(()) => {
                granted.insert(origin);
            }
            Err(e) => eprintln!("[lifer] couldn't grant IPC access to {origin}: {e}"),
        }
    }
}

// Only hand safe schemes to the OS; file:// or custom schemes could launch local programs.
fn open_external(app: &AppHandle, url: &url::Url) {
    if matches!(url.scheme(), "http" | "https" | "mailto") {
        let _ = app.opener().open_url(url.to_string(), None::<&str>);
    } else {
        eprintln!("[lifer] blocked opening {} URL", url.scheme());
    }
}

// A saved or typed address that doesn't parse must never panic the shell.
fn navigate_or_picker(window: &WebviewWindow, target: &str) {
    match target.parse() {
        Ok(url) => {
            let _ = window.navigate(url);
        }
        Err(e) => {
            eprintln!("[lifer] invalid server address {target:?}: {e}, showing setup");
            if let Ok(picker) = PICKER_URL.parse() {
                let _ = window.navigate(picker);
            }
        }
    }
}

// Trims and validates a server address typed into setup/Settings.
fn normalize_server_url(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim().trim_end_matches('/');
    match url::Url::parse(trimmed) {
        Ok(u) if matches!(u.scheme(), "http" | "https") && u.host_str().is_some() => Ok(trimmed.to_string()),
        _ => Err(format!("\"{trimmed}\" isn't a valid server address. Use a full address like http://192.168.1.10:4310.")),
    }
}

fn app_data_dir(app: &AppHandle) -> std::path::PathBuf {
    app.path().app_data_dir().expect("app data dir must resolve")
}

// Setup commands can reconfigure the app, so only honor them from trusted pages. Capability
// allowlists can't express "the server currently in our config," so it's checked here.
fn is_trusted_sender(window: &WebviewWindow) -> bool {
    let url = match window.url() {
        Ok(u) => u,
        Err(_) => return false,
    };
    if url.scheme() == "tauri" {
        return true; // our own bundled index.html/picker.html
    }
    if is_local_api(&url) {
        return true;
    }
    // Any of server_url/local_url/external_urls counts: Automatic URL Switching moves this
    // window between them.
    store::read_config(&app_data_dir(window.app_handle()))
        .is_some_and(|cfg| cfg.mode.as_deref() == Some("remote") && is_configured_server(cfg, &url))
}

#[derive(serde::Serialize)]
struct AppInstallInfo {
    path: String,
    translocated: bool,
}

// The .app bundle on macOS, the executable's folder elsewhere.
fn install_path() -> Option<std::path::PathBuf> {
    let exe = std::env::current_exe().ok()?;
    #[cfg(target_os = "macos")]
    if let Some(bundle) = exe.ancestors().find(|p| p.extension().is_some_and(|e| e == "app")) {
        return Some(bundle.to_path_buf());
    }
    exe.parent().map(|p| p.to_path_buf())
}

fn is_translocated(path: &std::path::Path) -> bool {
    path.to_string_lossy().contains("/AppTranslocation/")
}

// Lets Settings explain a failed in-place update (macOS runs quarantined apps from a read-only
// temporary copy that can't replace itself).
#[tauri::command]
fn app_install_info() -> AppInstallInfo {
    let path = install_path().unwrap_or_default();
    AppInstallInfo { translocated: is_translocated(&path), path: path.to_string_lossy().into_owned() }
}

#[tauri::command]
fn platform() -> &'static str {
    // Node's process.platform naming ("darwin", not "macos"); apps/web checks these strings.
    if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(target_os = "windows") {
        "win32"
    } else {
        "linux"
    }
}

// The window background shows during macOS overscroll bounce. ThemeProvider calls this so dark
// mode doesn't flash light; colors match index.css's --color-canvas.
#[tauri::command]
fn set_window_theme_background(window: WebviewWindow, dark: bool) {
    let color = if dark {
        tauri::webview::Color(0x24, 0x2c, 0x34, 255) // matches index.css's dark --color-canvas
    } else {
        tauri::webview::Color(0xf6, 0xee, 0xdc, 255) // matches index.css's light --color-canvas
    };
    let _ = window.set_background_color(Some(color));
}

#[tauri::command]
fn get_config(window: WebviewWindow) -> Option<store::DesktopConfig> {
    if !is_trusted_sender(&window) {
        return None;
    }
    store::read_config(&app_data_dir(window.app_handle()))
}

// Called after Settings > Storage moves the library. start_api passes DATA_DIR from this config
// and the env var beats the API's own settings file, so it must be updated here. Local mode only.
#[tauri::command]
fn set_local_data_dir(window: WebviewWindow, data_dir: String) -> Result<(), String> {
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

#[derive(serde::Deserialize)]
struct ChooseSetupInput {
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
struct ChooseSetupResult {
    #[serde(skip_serializing_if = "Option::is_none")]
    ok: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    canceled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

fn setup_error(message: String) -> ChooseSetupResult {
    ChooseSetupResult { ok: None, canceled: None, error: Some(message) }
}

fn save_config(app: &AppHandle, config: &store::DesktopConfig) -> Result<(), ChooseSetupResult> {
    store::write_config(&app_data_dir(app), config)
        .map_err(|e| setup_error(format!("Couldn't save the connection settings: {e}")))
}

/// The library folder last used in local mode, from the saved config.
fn remembered_local_dir(app: &AppHandle) -> Option<String> {
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
async fn switch_to_local_library(app: &AppHandle, window: &WebviewWindow) -> Result<(), String> {
    let data_dir = remembered_local_dir(app);
    let config = store::DesktopConfig {
        mode: Some("local".into()),
        data_dir: data_dir.clone(),
        last_local_data_dir: data_dir.clone(),
        last_server_url: remembered_server(app),
        ..Default::default()
    };
    store::write_config(&app_data_dir(app), &config).map_err(|e| format!("Couldn't save the connection: {e}"))?;
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
async fn use_local_library(window: WebviewWindow, app: AppHandle) -> ChooseSetupResult {
    if !is_trusted_sender(&window) {
        return ChooseSetupResult { ok: None, canceled: None, error: Some("Not allowed from this page.".into()) };
    }
    match switch_to_local_library(&app, &window).await {
        Ok(()) => ChooseSetupResult { ok: Some(true), canceled: None, error: None },
        Err(e) => ChooseSetupResult { ok: None, canceled: None, error: Some(e) },
    }
}

#[tauri::command]
async fn choose_setup(window: WebviewWindow, app: AppHandle, config: ChooseSetupInput) -> ChooseSetupResult {
    if !is_trusted_sender(&window) {
        return ChooseSetupResult {
            ok: None,
            canceled: None,
            error: Some("Not allowed from this page.".into()),
        };
    }

    if config.mode == "remote" {
        // Automatic URL Switching: navigate to the first address that answers, in apply_config's order.
        if let (Some(local_url), Some(external_urls)) = (&config.local_url, &config.external_urls) {
            if external_urls.is_empty() {
                return ChooseSetupResult { ok: None, canceled: None, error: Some("At least one external URL is required.".into()) };
            }
            let local_trimmed = match normalize_server_url(local_url) {
                Ok(u) => u,
                Err(e) => return ChooseSetupResult { ok: None, canceled: None, error: Some(e) },
            };
            let external_trimmed = match external_urls.iter().map(|u| normalize_server_url(u)).collect::<Result<Vec<_>, _>>() {
                Ok(v) => v,
                Err(e) => return ChooseSetupResult { ok: None, canceled: None, error: Some(e) },
            };
            let local_ok = api::is_reachable(&format!("{local_trimmed}/health")).await;
            let mut target = if local_ok { Some(local_trimmed.clone()) } else { None };
            if target.is_none() {
                for url in &external_trimmed {
                    if api::is_reachable(&format!("{url}/health")).await {
                        target = Some(url.clone());
                        break;
                    }
                }
            }
            let Some(target) = target else {
                return ChooseSetupResult {
                    ok: None,
                    canceled: None,
                    error: Some("Couldn't reach any of the addresses. Check the URLs and that the server is running.".into()),
                };
            };
            let new_config = store::DesktopConfig {
                mode: Some("remote".into()),
                data_dir: None,
                server_url: None,
                local_url: Some(local_trimmed.clone()),
                local_network_name: config.local_network_name.clone(),
                external_urls: Some(external_trimmed),
                external_url: None,
                offline_mode: config.offline_mode,
                last_local_data_dir: remembered_local_dir(&app),
                last_server_url: Some(local_trimmed),
            };
            if let Err(e) = save_config(&app, &new_config) {
                return e;
            }
            end_server_fallback(&app);
            grant_remote_capabilities(&app, &new_config);
            api::stop_api_async(&app).await;
            navigate_or_picker(&window, &target);
            ensure_server_watcher(&app, &window);
            return ChooseSetupResult { ok: Some(true), canceled: None, error: None };
        }

        let Some(server_url) = config.server_url else {
            return ChooseSetupResult { ok: None, canceled: None, error: Some("serverUrl is required".into()) };
        };
        let trimmed = match normalize_server_url(&server_url) {
            Ok(u) => u,
            Err(e) => return ChooseSetupResult { ok: None, canceled: None, error: Some(e) },
        };
        if !api::is_reachable(&format!("{trimmed}/health")).await {
            return ChooseSetupResult {
                ok: None,
                canceled: None,
                error: Some("Couldn't reach that address. Check the URL and that the server is running.".into()),
            };
        }
        let new_config = store::DesktopConfig {
            mode: Some("remote".into()),
            data_dir: None,
            server_url: Some(trimmed.clone()),
            local_url: None,
            local_network_name: None,
            external_urls: None,
            external_url: None,
            offline_mode: config.offline_mode,
            last_local_data_dir: remembered_local_dir(&app),
            last_server_url: Some(trimmed.clone()),
        };
        if let Err(e) = save_config(&app, &new_config) {
            return e;
        }
        end_server_fallback(&app);
        grant_remote_capabilities(&app, &new_config);
        api::stop_api_async(&app).await;
        navigate_or_picker(&window, &trimmed);
        ensure_server_watcher(&app, &window);
        return ChooseSetupResult { ok: Some(true), canceled: None, error: None };
    }

    let folder = app.dialog().file().set_title("Choose where Lifer should store your photos").blocking_pick_folder();
    let Some(path) = folder else {
        return ChooseSetupResult { ok: None, canceled: Some(true), error: None };
    };
    let data_dir = path.to_string();
    if let Err(e) = save_config(
        &app,
        &store::DesktopConfig {
            mode: Some("local".into()),
            data_dir: Some(data_dir.clone()),
            server_url: None,
            local_url: None,
            local_network_name: None,
            external_urls: None,
            external_url: None,
            offline_mode: None,
            last_local_data_dir: Some(data_dir.clone()),
            last_server_url: remembered_server(&app),
        },
    ) {
        return e;
    }
    end_server_fallback(&app);
    api::stop_api_async(&app).await;
    if let Err(e) = api::start_api(&app, Some(data_dir)).await {
        return ChooseSetupResult { ok: None, canceled: None, error: Some(e) };
    }
    let url = format!("http://127.0.0.1:{}", api::LOCAL_PORT);
    if let Err(e) = api::wait_for_server(&format!("{url}/health"), 30_000).await {
        return ChooseSetupResult { ok: None, canceled: None, error: Some(e) };
    }
    navigate_or_picker(&window, &url);
    ChooseSetupResult { ok: Some(true), canceled: None, error: None }
}

#[derive(serde::Serialize)]
struct CurrentNetworkInfo {
    #[serde(rename = "localIp")]
    local_ip: Option<String>,
    #[serde(rename = "wifiName")]
    wifi_name: Option<String>,
}

// Backs Settings' "use current connection" button: autofills the LAN IP and WiFi name.
#[tauri::command]
fn current_network_info(window: WebviewWindow) -> CurrentNetworkInfo {
    if !is_trusted_sender(&window) {
        return CurrentNetworkInfo { local_ip: None, wifi_name: None };
    }
    CurrentNetworkInfo { local_ip: network::current_lan_ip(), wifi_name: network::current_wifi_ssid() }
}

// Backs Settings' live reachability checkmark, using the same check as connect time.
#[tauri::command]
async fn test_endpoint(window: WebviewWindow, url: String) -> bool {
    if !is_trusted_sender(&window) {
        return false;
    }
    let trimmed = url.trim_end_matches('/');
    api::is_reachable(&format!("{trimmed}/health")).await
}

// Backs Settings' "Sign in" step for a remote server (see api::test_login).
#[tauri::command]
async fn test_login(window: WebviewWindow, url: String, email: String, password: String) -> Result<(), String> {
    if !is_trusted_sender(&window) {
        return Err("Not allowed from this page.".into());
    }
    let trimmed = url.trim_end_matches('/');
    api::test_login(trimmed, &email, &password).await
}

// Local matching is only for a connected server's own pages; in local mode the local API already
// runs the models itself.
fn local_inference_allowed(window: &WebviewWindow) -> Result<(), String> {
    let url = window.url().map_err(|_| "Not allowed from this page.".to_string())?;
    let remote = store::read_config(&app_data_dir(window.app_handle()))
        .is_some_and(|cfg| cfg.mode.as_deref() == Some("remote") && is_configured_server(cfg, &url));
    if remote { Ok(()) } else { Err("Local matching is only used when connected to a server.".into()) }
}

#[tauri::command]
async fn local_inference_status(window: WebviewWindow) -> Result<serde_json::Value, String> {
    local_inference_allowed(&window)?;
    local_inference::status(window.app_handle()).await
}

// `info` is the server's GET /species/matching-info; starts the sidecar and any model download.
#[tauri::command]
async fn local_inference_prepare(window: WebviewWindow, info: serde_json::Value) -> Result<serde_json::Value, String> {
    local_inference_allowed(&window)?;
    local_inference::prepare(window.app_handle(), info).await
}

// The photo arrives as the raw IPC body (no JSON number array); x-lifer-targets names the vectors.
#[tauri::command]
async fn local_embed(window: WebviewWindow, request: tauri::ipc::Request<'_>) -> Result<serde_json::Value, String> {
    local_inference_allowed(&window)?;
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("Expected the photo as raw bytes.".into());
    };
    let targets = request.headers().get("x-lifer-targets").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    local_inference::embed(window.app_handle(), bytes.clone(), &targets).await
}

fn build_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let change_server = MenuItem::with_id(app, "change-server", "Change Server / Library…", true, None::<&str>)?;
    let use_local = MenuItem::with_id(app, "use-local", "Use This Computer's Library", true, None::<&str>)?;
    // Finder-style CmdOrCtrl+Backspace; bare Backspace/Delete stay for text editing. Fires the
    // same frontend handler as the Delete keyboard shortcut.
    let delete_selected = MenuItem::with_id(app, "delete-selected", "Delete", true, Some("CmdOrCtrl+Backspace"))?;
    let lifer_menu = Submenu::with_items(
        app,
        "Lifer",
        true,
        &[
            &PredefinedMenuItem::about(app, None, None)?,
            &PredefinedMenuItem::separator(app)?,
            &change_server,
            &use_local,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;
    let edit_menu = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &delete_selected,
        ],
    )?;
    let window_menu = Submenu::with_items(
        app,
        "Window",
        true,
        &[&PredefinedMenuItem::minimize(app, None)?, &PredefinedMenuItem::close_window(app, None)?],
    )?;
    Menu::with_items(app, &[&lifer_menu, &edit_menu, &window_menu])
}

// When the remote server is unreachable, open the library on this computer instead of a blank window.
// Once the server answers again, offer to push local additions or switch back. The saved mode stays remote.
const STARTUP_SERVER_TRIES: u32 = 3;
const SERVER_CHECK_INTERVAL_SECS: u64 = 15;
// About a minute of failed checks, so a brief network drop or waking from sleep doesn't switch.
const SERVER_FAILURES_BEFORE_FALLBACK: u32 = 4;
const PUSH_BUTTON: &str = "Push My Photos";
const SWITCH_BUTTON: &str = "Switch to Server";

#[derive(Default)]
struct ServerFallback {
    active: std::sync::atomic::AtomicBool,
    // The watcher runs (one at a time) while connected to a server.
    watching: std::sync::atomic::AtomicBool,
    // Asked "switch back?" already this time; not asked again until the next disconnect.
    offered: std::sync::atomic::AtomicBool,
}

// A new connection or library replaces the offline fallback, so its watcher must not offer
// to switch back.
fn end_server_fallback(app: &AppHandle) {
    app.state::<ServerFallback>().active.store(false, std::sync::atomic::Ordering::SeqCst);
}

/// The configured server address that answers now, in Automatic URL Switching's order (its
/// local address on its own Wi-Fi, then the external ones), or None when none does.
async fn reachable_server(cfg: &store::DesktopConfig) -> Option<String> {
    if let Some(local_url) = &cfg.local_url {
        let on_local_network = match &cfg.local_network_name {
            // Reading the SSID runs a system tool (nmcli can rescan), so keep it off the async workers.
            Some(name) => {
                let ssid = tauri::async_runtime::spawn_blocking(network::current_wifi_ssid).await.ok().flatten();
                ssid.as_deref() == Some(name.as_str())
            }
            None => true,
        };
        if on_local_network && api::is_reachable(&format!("{local_url}/health")).await {
            return Some(local_url.clone());
        }
        for url in cfg.external_urls.clone().unwrap_or_default() {
            if api::is_reachable(&format!("{url}/health")).await {
                return Some(url);
            }
        }
        return None;
    }
    let server_url = cfg.server_url.as_ref()?;
    api::is_reachable(&format!("{server_url}/health")).await.then(|| server_url.clone())
}

fn server_label(cfg: &store::DesktopConfig) -> String {
    cfg.server_url
        .clone()
        .or_else(|| cfg.local_url.clone())
        .unwrap_or_else(|| "your server".into())
}

async fn use_local_while_offline(app: &AppHandle, window: &WebviewWindow, cfg: &store::DesktopConfig) {
    let state = app.state::<ServerFallback>();
    state.active.store(true, std::sync::atomic::Ordering::SeqCst);
    state.offered.store(false, std::sync::atomic::Ordering::SeqCst);
    app.dialog()
        .message(format!(
            "Lifer can't reach your server at {}.\n\nYou can keep working in the library on this computer. When the server is back, Lifer will offer to push what you've added to it.",
            server_label(cfg)
        ))
        .title("Server disconnected")
        .kind(tauri_plugin_dialog::MessageDialogKind::Warning)
        .show(|_| {});
    // The library "Use This Computer's Library" opens, so work done offline lands in it.
    if let Err(e) = api::start_api(app, cfg.data_dir.clone().or_else(|| remembered_local_dir(app))).await {
        app.dialog().message(e).kind(tauri_plugin_dialog::MessageDialogKind::Error).show(|_| {});
        return;
    }
    let url = format!("http://127.0.0.1:{}", api::LOCAL_PORT);
    // The first time, the library on this computer is created and its species catalog loaded.
    match api::wait_for_server(&format!("{url}/health"), 120_000).await {
        Ok(()) => navigate_or_picker(window, &url),
        Err(e) => {
            app.dialog().message(e).kind(tauri_plugin_dialog::MessageDialogKind::Error).show(|_| {});
        }
    }
}

/// Checks the server while in remote mode: switches to this computer's library after a minute
/// without an answer, and offers to switch back when it answers again. Stops once the app leaves
/// remote mode.
/// Starts watching the server unless a watcher already is: at launch, and whenever the app
/// connects to a server later.
fn ensure_server_watcher(app: &AppHandle, window: &WebviewWindow) {
    if !app.state::<ServerFallback>().watching.swap(true, std::sync::atomic::Ordering::SeqCst) {
        tauri::async_runtime::spawn(watch_server(app.clone(), window.clone()));
    }
}

async fn watch_server(app: AppHandle, window: WebviewWindow) {
    use std::sync::atomic::Ordering;
    let mut failures = 0;
    loop {
        tokio::time::sleep(std::time::Duration::from_secs(SERVER_CHECK_INTERVAL_SECS)).await;
        let Some(cfg) = store::read_config(&app_data_dir(&app)).filter(|c| c.mode.as_deref() == Some("remote")) else {
            app.state::<ServerFallback>().watching.store(false, Ordering::SeqCst);
            return;
        };
        let reachable = reachable_server(&cfg).await;
        let state = app.state::<ServerFallback>();
        if state.active.load(Ordering::SeqCst) {
            let Some(url) = reachable else { continue };
            if state.offered.swap(true, Ordering::SeqCst) {
                continue;
            }
            let app2 = app.clone();
            let window2 = window.clone();
            app.dialog()
                .message(format!(
                    "Your server at {} is back.\n\nPush the photos you added on this computer to it first, or switch straight to the server. Anything you don't push stays in the library on this computer, and you can push it later from Settings, Server.",
                    server_label(&cfg)
                ))
                .title("Server reconnected")
                .buttons(tauri_plugin_dialog::MessageDialogButtons::YesNoCancelCustom(
                    PUSH_BUTTON.into(),
                    SWITCH_BUTTON.into(),
                    "Not Now".into(),
                ))
                .show_with_result(move |choice| {
                    use tauri_plugin_dialog::MessageDialogResult;
                    // The user may have switched library or server while this dialog was open.
                    if !app2.state::<ServerFallback>().active.load(Ordering::SeqCst) {
                        return;
                    }
                    let picked = |label: &str, standard: MessageDialogResult| choice == standard || choice == MessageDialogResult::Custom(label.into());
                    if picked(PUSH_BUTTON, MessageDialogResult::Yes) {
                        // Settings, Server in this computer's library: connecting there shows "Migrate
                        // your library to a server", which sends only what isn't on it yet.
                        navigate_or_picker(&window2, &format!("http://127.0.0.1:{}/settings/server", api::LOCAL_PORT));
                    } else if picked(SWITCH_BUTTON, MessageDialogResult::No) {
                        end_server_fallback(&app2);
                        navigate_or_picker(&window2, &url);
                        // The library on this computer isn't needed while on the server.
                        let app3 = app2.clone();
                        tauri::async_runtime::spawn(async move { api::stop_api_async(&app3).await });
                    }
                });
        } else if reachable.is_some() {
            failures = 0;
        } else {
            failures += 1;
            if failures >= SERVER_FAILURES_BEFORE_FALLBACK {
                failures = 0;
                use_local_while_offline(&app, &window, &cfg).await;
            }
        }
    }
}

async fn apply_config(app: AppHandle, window: WebviewWindow) {
    let config = store::read_config(&app_data_dir(&app));
    match config {
        Some(cfg) if cfg.mode.as_deref() == Some("local") => {
            if let Err(e) = api::start_api(&app, cfg.data_dir).await {
                app.dialog().message(e).kind(tauri_plugin_dialog::MessageDialogKind::Error).blocking_show();
                return;
            }
            let url = format!("http://127.0.0.1:{}", api::LOCAL_PORT);
            match api::wait_for_server(&format!("{url}/health"), 30_000).await {
                Ok(()) => navigate_or_picker(&window, &url),
                Err(e) => {
                    app.dialog().message(e).kind(tauri_plugin_dialog::MessageDialogKind::Error).blocking_show();
                }
            }
        }
        Some(cfg) if cfg.mode.as_deref() == Some("remote") => {
            if cfg.server_url.is_none() && cfg.local_url.is_none() {
                navigate_or_picker(&window, PICKER_URL);
                return;
            }
            // A server that's just restarting can take a few seconds to answer.
            let mut target = None;
            for attempt in 0..STARTUP_SERVER_TRIES {
                if attempt > 0 {
                    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                }
                target = reachable_server(&cfg).await;
                if target.is_some() {
                    break;
                }
            }
            match target {
                Some(url) => navigate_or_picker(&window, &url),
                None => use_local_while_offline(&app, &window, &cfg).await,
            }
            ensure_server_watcher(&app, &window);
        }
        _ => navigate_or_picker(&window, PICKER_URL),
    }
}

// Gatekeeper runs a quarantined app from a read-only temporary copy, where updates can't
// install and folder permissions reset. We can't move the app ourselves, so explain the fix.
#[cfg(target_os = "macos")]
fn warn_if_translocated(app: &AppHandle) {
    if !install_path().is_some_and(|p| is_translocated(&p)) {
        return;
    }
    let opener_handle = app.clone();
    app.dialog()
        .message(
            "Lifer is running from a temporary location, so updates can't install.\n\nQuit Lifer, drag Lifer.app into your Applications folder, then open it from there.",
        )
        .title("Move Lifer to Applications")
        .kind(tauri_plugin_dialog::MessageDialogKind::Warning)
        .buttons(tauri_plugin_dialog::MessageDialogButtons::OkCancelCustom(
            "Open Applications Folder".into(),
            "Not Now".into(),
        ))
        .show(move |open| {
            if open {
                let _ = opener_handle.opener().open_path("/Applications", None::<&str>);
            }
        });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(api::ApiState::default())
        .manage(RemoteCapabilities::default())
        .manage(ServerFallback::default())
        .manage(local_inference::LocalInferenceState::default())
        .invoke_handler(tauri::generate_handler![
            get_config,
            choose_setup,
            platform,
            set_window_theme_background,
            current_network_info,
            test_endpoint,
            test_login,
            app_install_info,
            set_local_data_dir,
            local_inference_status,
            local_inference_prepare,
            local_embed,
            use_local_library
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            let menu = build_menu(&handle)?;
            app.set_menu(menu)?;
            app.on_menu_event(move |app, event| {
                if event.id() == "change-server" {
                    if let Err(e) = store::clear_config(&app_data_dir(app)) {
                        eprintln!("[lifer] couldn't clear the saved config: {e}");
                    }
                    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
                        api::stop_api(app);
                        navigate_or_picker(&window, PICKER_URL);
                    }
                } else if event.id() == "use-local" {
                    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
                        let app = app.clone();
                        tauri::async_runtime::spawn(async move {
                            if let Err(e) = switch_to_local_library(&app, &window).await {
                                app.dialog().message(e).kind(tauri_plugin_dialog::MessageDialogKind::Error).show(|_| {});
                            }
                        });
                    }
                } else if event.id() == "delete-selected" {
                    let _ = app.emit("menu:delete-selected", ());
                }
            });

            let nav_handle = handle.clone();
            let new_window_handle = handle.clone();
            #[allow(unused_mut)]
            let mut window_builder = WebviewWindowBuilder::new(app, WINDOW_LABEL, WebviewUrl::App("index.html".into()))
                .title("Lifer")
                .inner_size(1360.0, 900.0)
                .background_color(tauri::webview::Color(0xf6, 0xee, 0xdc, 255));

            // These builder methods only compile on macOS. Windows and Linux keep Tauri's normal
            // decorated window.
            #[cfg(target_os = "macos")]
            {
                window_builder = window_builder
                    // Native traffic lights over our own header (see index.css's [data-mac-app] rules).
                    .title_bar_style(tauri::TitleBarStyle::Overlay)
                    .hidden_title(true)
                    .traffic_light_position(tauri::LogicalPosition::new(20.0, 20.0));
            }

            let window = window_builder
                // Tauri's drag-drop handler empties DOM dataTransfer.files; disable it for HTML5 drops.
                .disable_drag_drop_handler()
                // Runs before page scripts on every origin; main.tsx's shim needs the platform
                // synchronously.
                .initialization_script(format!("window.__LIFER_PLATFORM__ = {:?};", platform()))
                // Only app, local API and configured-server pages load in this window.
                .on_navigation(move |url| {
                    let is_local_asset = url.scheme() == "tauri";
                    // Same candidate list as is_trusted_sender.
                    let is_configured_remote =
                        store::read_config(&app_data_dir(&nav_handle)).is_some_and(|cfg| is_configured_server(cfg, url));
                    if is_local_asset || is_local_api(url) || is_configured_remote {
                        return true;
                    }
                    // Anything else is external: open it in the user's browser instead.
                    open_external(&nav_handle, url);
                    false
                })
                // target="_blank" clicks go through window.open, not on_navigation.
                .on_new_window(move |url, _features| {
                    open_external(&new_window_handle, &url);
                    tauri::webview::NewWindowResponse::Deny
                })
                .build()?;

            // See api::StopApiOnDrop: runs stop_api before the Windows updater force-exits.
            app.resources_table().add(api::StopApiOnDrop(handle.clone()));

            #[cfg(target_os = "macos")]
            warn_if_translocated(&handle);

            if let Some(cfg) = store::read_config(&app_data_dir(&handle)) {
                grant_remote_capabilities(&handle, &cfg);
            }

            let handle2 = handle.clone();
            let window2 = window.clone();
            tauri::async_runtime::spawn(async move {
                apply_config(handle2, window2).await;
            });

            let handle3 = handle.clone();
            app.listen("api-crashed", move |event| {
                let detail = event.payload().trim_matches('"').replace("\\n", "\n");
                handle3
                    .dialog()
                    .message(format!("Lifer stopped unexpectedly.\n\n{detail}"))
                    .kind(tauri_plugin_dialog::MessageDialogKind::Error)
                    .blocking_show();
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                api::stop_api(window.app_handle());
            }
        })
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        // Cmd+Q doesn't reliably fire WindowEvent::Destroyed, so stop the sidecar on every normal
        // exit here. A force-quit is covered by the sidecar's parent-pid watchdog.
        .run(|app_handle, event| {
            if let tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit = event {
                api::stop_api(app_handle);
                local_inference::stop(app_handle);
            }
        });
}
