mod api;
mod store;

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Listener, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

const WINDOW_LABEL: &str = "main";

fn app_data_dir(app: &AppHandle) -> std::path::PathBuf {
    app.path().app_data_dir().expect("app data dir must resolve")
}

// The Tauri equivalent of main.js's isTrustedSender: the get_config/choose_setup commands can
// reconfigure this whole app (which server it points at, where it stores photos), so a page
// this window happens to be displaying — including, in remote mode, whatever the currently
// configured remote SERVER'S own pages are — must be verified as one we actually trust before
// honoring either call. Tauri's static capability allowlists can't express "trust whichever
// server URL is currently in our own config file," so that check is done here in the command
// body instead, same as Electron's version.
fn is_trusted_sender(window: &WebviewWindow) -> bool {
    let url = match window.url() {
        Ok(u) => u,
        Err(_) => return false,
    };
    if url.scheme() == "tauri" {
        return true; // our own bundled index.html/picker.html
    }
    if url.host_str() == Some("localhost") && url.port() == Some(api::LOCAL_PORT) {
        return true;
    }
    let config = store::read_config(&app_data_dir(window.app_handle()));
    if let Some(cfg) = config {
        if cfg.mode.as_deref() == Some("remote") {
            if let Some(server_url) = cfg.server_url {
                if let Ok(server) = url::Url::parse(&server_url) {
                    return url.host_str() == server.host_str() && url.scheme() == server.scheme();
                }
            }
        }
    }
    false
}

#[tauri::command]
fn platform() -> &'static str {
    // Node's process.platform naming ("darwin", not Rust's "macos") — apps/web's
    // main.tsx/useDesktopMode check against this exact string, unchanged from Electron.
    if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(target_os = "windows") {
        "win32"
    } else {
        "linux"
    }
}

#[tauri::command]
fn get_config(window: WebviewWindow) -> Option<store::DesktopConfig> {
    if !is_trusted_sender(&window) {
        return None;
    }
    store::read_config(&app_data_dir(window.app_handle()))
}

#[derive(serde::Deserialize)]
struct ChooseSetupInput {
    mode: String,
    #[serde(rename = "serverUrl")]
    server_url: Option<String>,
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
        let Some(server_url) = config.server_url else {
            return ChooseSetupResult { ok: None, canceled: None, error: Some("serverUrl is required".into()) };
        };
        let trimmed = server_url.trim_end_matches('/').to_string();
        if !api::is_reachable(&format!("{trimmed}/health")).await {
            return ChooseSetupResult {
                ok: None,
                canceled: None,
                error: Some("Couldn't reach that address. Check the URL and that the server is running.".into()),
            };
        }
        let data_dir = app_data_dir(&app);
        let _ = store::write_config(
            &data_dir,
            &store::DesktopConfig {
                mode: Some("remote".into()),
                data_dir: None,
                server_url: Some(trimmed.clone()),
                offline_mode: config.offline_mode,
            },
        );
        api::stop_api(&app);
        let _ = window.navigate(trimmed.parse().unwrap());
        return ChooseSetupResult { ok: Some(true), canceled: None, error: None };
    }

    // Local mode — native folder dialog, same as Electron's dialog.showOpenDialog.
    let folder = app.dialog().file().set_title("Choose where Lifer should store your photos").blocking_pick_folder();
    let Some(path) = folder else {
        return ChooseSetupResult { ok: None, canceled: Some(true), error: None };
    };
    let data_dir = path.to_string();
    let app_data = app_data_dir(&app);
    let _ = store::write_config(
        &app_data,
        &store::DesktopConfig {
            mode: Some("local".into()),
            data_dir: Some(data_dir.clone()),
            server_url: None,
            offline_mode: None,
        },
    );
    api::stop_api(&app);
    if let Err(e) = api::start_api(&app, Some(data_dir)) {
        return ChooseSetupResult { ok: None, canceled: None, error: Some(e) };
    }
    let url = format!("http://localhost:{}", api::LOCAL_PORT);
    if let Err(e) = api::wait_for_server(&format!("{url}/health"), 30_000).await {
        return ChooseSetupResult { ok: None, canceled: None, error: Some(e) };
    }
    let _ = window.navigate(url.parse().unwrap());
    ChooseSetupResult { ok: Some(true), canceled: None, error: None }
}

fn build_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let change_server = MenuItem::with_id(app, "change-server", "Change Server / Library…", true, None::<&str>)?;
    let lifer_menu = Submenu::with_items(
        app,
        "Lifer",
        true,
        &[
            &PredefinedMenuItem::about(app, None, None)?,
            &PredefinedMenuItem::separator(app)?,
            &change_server,
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

async fn apply_config(app: AppHandle, window: WebviewWindow) {
    let config = store::read_config(&app_data_dir(&app));
    match config {
        Some(cfg) if cfg.mode.as_deref() == Some("local") => {
            if let Err(e) = api::start_api(&app, cfg.data_dir) {
                app.dialog().message(e).kind(tauri_plugin_dialog::MessageDialogKind::Error).blocking_show();
                return;
            }
            let url = format!("http://localhost:{}", api::LOCAL_PORT);
            match api::wait_for_server(&format!("{url}/health"), 30_000).await {
                Ok(()) => {
                    let _ = window.navigate(url.parse().unwrap());
                }
                Err(e) => {
                    app.dialog().message(e).kind(tauri_plugin_dialog::MessageDialogKind::Error).blocking_show();
                }
            }
        }
        Some(cfg) if cfg.mode.as_deref() == Some("remote") => {
            if let Some(server_url) = cfg.server_url {
                let _ = window.navigate(server_url.parse().unwrap());
            }
        }
        _ => {
            let _ = window.navigate("tauri://localhost/picker.html".parse().unwrap());
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .manage(api::ApiState::default())
        .invoke_handler(tauri::generate_handler![get_config, choose_setup, platform])
        .setup(|app| {
            let handle = app.handle().clone();
            let menu = build_menu(&handle)?;
            app.set_menu(menu)?;
            app.on_menu_event(move |app, event| {
                if event.id() == "change-server" {
                    let _ = store::clear_config(&app_data_dir(app));
                    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
                        api::stop_api(app);
                        let _ = window.navigate("tauri://localhost/picker.html".parse().unwrap());
                    }
                }
            });

            let nav_handle = handle.clone();
            let window = WebviewWindowBuilder::new(app, WINDOW_LABEL, WebviewUrl::App("index.html".into()))
                .title("Lifer")
                .inner_size(1360.0, 900.0)
                .background_color(tauri::webview::Color(0xf6, 0xee, 0xdc, 255))
                // Native macOS traffic lights over our own header (see index.css's
                // [data-mac-app] rules) — direct equivalent of Electron's titleBarStyle:
                // "hidden" + trafficLightPosition. Genuinely native (owned by AppKit), same as
                // Electron's — validated in the Phase 1 spike with no blur-visibility bug.
                .title_bar_style(tauri::TitleBarStyle::Overlay)
                .hidden_title(true)
                .traffic_light_position(tauri::LogicalPosition::new(20.0, 20.0))
                // Injected before ANY page script runs, on every navigation (including once
                // this window later navigates away to http://localhost:4310 or a remote
                // server's own origin) — the one piece apps/web's own Tauri shim (main.tsx)
                // needs synchronously rather than via an async invoke() call. See bridge.js's
                // matching comment for why this can't just be a preload script like Electron's.
                .initialization_script(&format!("window.__LIFER_PLATFORM__ = {:?};", platform()))
                // target=_blank links (e.g. the eBird checklist link) open in the user's real
                // browser instead of navigating this window away — mirrors main.js's
                // setWindowOpenHandler.
                .on_navigation(move |url| {
                    let is_local_asset = url.scheme() == "tauri";
                    let is_local_api = url.host_str() == Some("localhost") && url.port() == Some(api::LOCAL_PORT);
                    let is_configured_remote = store::read_config(&app_data_dir(&nav_handle))
                        .and_then(|cfg| cfg.server_url)
                        .and_then(|s| url::Url::parse(&s).ok())
                        .is_some_and(|server| server.host_str() == url.host_str() && server.scheme() == url.scheme());
                    if is_local_asset || is_local_api || is_configured_remote {
                        return true;
                    }
                    // Anything else (e.g. the eBird checklist link, target="_blank" in the
                    // real app) is an external link — open it in the user's real browser
                    // instead of navigating this window away, and block the in-app navigation.
                    let _ = nav_handle.opener().open_url(url.to_string(), None::<&str>);
                    false
                })
                .build()?;

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
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
