mod api;
mod mac_window;
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

// Backs the custom-drawn traffic lights (see apps/web's TrafficLights.tsx) — native buttons
// have no public API for an exact custom color, so light theme hides them and draws its own
// (see mac_window.rs), which then needs these to actually do anything on click.
#[tauri::command]
fn set_traffic_lights_hidden(window: WebviewWindow, hidden: bool) {
    // AppKit calls (NSWindow.standardWindowButton/setHidden) are only well-defined on the
    // main thread. Tauri commands run on a worker thread pool by default, so calling into
    // mac_window directly here was undefined behavior — it could silently no-op, which reads
    // as the native buttons intermittently still showing through behind the custom dots.
    let _ = window.clone().run_on_main_thread(move || {
        mac_window::set_traffic_lights_hidden(&window, hidden);
    });
}

#[tauri::command]
fn window_control(window: WebviewWindow, action: String) {
    match action.as_str() {
        "close" => {
            let _ = window.close();
        }
        "minimize" => {
            let _ = window.minimize();
        }
        "toggle-maximize" => {
            if let Ok(true) = window.is_maximized() {
                let _ = window.unmaximize();
            } else {
                let _ = window.maximize();
            }
        }
        _ => {}
    }
}

// The webview's own background_color (set once at window-creation below) is what shows
// through during macOS's rubber-band overscroll past the top/bottom of a page — a plain
// browser scroll never reveals it, but AppKit's own bounce animation briefly does. Left at
// its light-mode value, dark theme would bounce into a light-cream flash on every overscroll.
// apps/web's ThemeProvider calls this every time the theme resolves (both on toggle and on
// initial mount), keeping it in sync with index.css's own --color-canvas light/dark values.
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
    if let Err(e) = api::start_api(&app, Some(data_dir)).await {
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
            if let Err(e) = api::start_api(&app, cfg.data_dir).await {
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
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(api::ApiState::default())
        .invoke_handler(tauri::generate_handler![
            get_config,
            choose_setup,
            platform,
            set_traffic_lights_hidden,
            window_control,
            set_window_theme_background
        ])
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
            let new_window_handle = handle.clone();
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
                // Forces AppKit to draw the traffic lights using dark-appearance styling —
                // independent of the app's own light/dark theme (apps/web's ThemeProvider),
                // which only ever affects our own web content, never the native window chrome.
                // Confirmed: dark-mode's inactive/unfocused traffic lights are a genuinely
                // more visible grey than light mode's (which reads as barely-there/near-white
                // no matter what color sits behind them — every header-tint attempt only ever
                // nudged this, never fixed it, because the dots' own color was never the
                // adjustable part). Always using the dark rendering sidesteps that entirely,
                // with no visible side effect since our own header/content still render
                // whatever theme the user actually picked.
                .theme(Some(tauri::Theme::Dark))
                // Tauri intercepts OS-level file drag-and-drop by default and routes it through
                // its own DragDrop event system instead of letting it reach the webview as a
                // normal DOM DragEvent — which left BulkImportPage's onDrop handler seeing an
                // empty dataTransfer.files every time (the browser-side event still fires, just
                // with no file payload). Disabling Tauri's own handler here restores standard
                // HTML5 drag-and-drop for the whole window, matching how it already works when
                // this same page runs in a normal browser.
                .disable_drag_drop_handler()
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
                // on_navigation above only fires for a navigation of THIS window — a real
                // target="_blank" anchor click (like the eBird "Download My Data" link) instead
                // fires window.open(), which goes through this entirely separate hook. Without
                // it registered, WRY has nothing to do with that request and the click is a
                // silent no-op — which is exactly what "the link doesn't do anything" was: the
                // on_navigation comment above always described the intent, but target="_blank"
                // links never actually went through that hook at all.
                .on_new_window(move |url, _features| {
                    let _ = new_window_handle.opener().open_url(url.to_string(), None::<&str>);
                    tauri::webview::NewWindowResponse::Deny
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
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        // Builder::run(context) (what this used to call directly) is actually
        // `self.build(context)?.run(|_, _| {})` under the hood — a no-op app-level event
        // handler. That meant stop_api() only ever had a chance to run via the WindowEvent::
        // Destroyed hook above, which macOS's native Quit (Cmd+Q / the app menu's Quit item)
        // doesn't reliably route through — quitting the whole app isn't the same pipeline as
        // closing a window, so the sidecar could outlive the app indefinitely on an ordinary
        // quit, not just a force-quit. RunEvent::Exit/ExitRequested are the actual "the app is
        // going away, for any reason" signal Tauri guarantees fires on every normal shutdown
        // path, so this is the reliable place to kill the sidecar. (A real force-quit/SIGKILL
        // still bypasses this entirely — that's what the sidecar's own parent-pid watchdog in
        // apps/api/src/index.ts is for.)
        .run(|app_handle, event| {
            if let tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit = event {
                api::stop_api(app_handle);
            }
        });
}
