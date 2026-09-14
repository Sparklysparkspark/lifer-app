mod api;
mod embedded_db;
mod network;
mod store;

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Listener, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
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
    if url.host_str() == Some("127.0.0.1") && url.port() == Some(api::LOCAL_PORT) {
        return true;
    }
    let config = store::read_config(&app_data_dir(window.app_handle()));
    if let Some(cfg) = config {
        if cfg.mode.as_deref() == Some("remote") {
            // Either the single-URL config or, with Automatic URL Switching on, whichever of
            // local_url/external_urls we're currently pointed at — a window navigated to any one
            // of them is equally "our own configured server," not just whichever URL happens to
            // be stored under the legacy single-field name.
            let mut candidates = vec![cfg.server_url, cfg.local_url];
            candidates.extend(cfg.external_urls.unwrap_or_default().into_iter().map(Some));
            for candidate in candidates.into_iter().flatten() {
                if let Ok(server) = url::Url::parse(&candidate) {
                    if url.host_str() == server.host_str() && url.scheme() == server.scheme() {
                        return true;
                    }
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
    // Only present when "Automatic URL Switching" is on — see picker.html. local_url and
    // external_urls (at least one entry) are required together in that case; the feature being
    // on isn't persisted as its own flag, its presence is implied by both being set in the saved
    // config.
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
        // Automatic URL Switching: local_url + at least one external URL present means it's on.
        // Validate the local address and every external one (a network can genuinely only reach
        // some of them right now — e.g. setting this up while at home, an nginx-forwarded
        // address may not resolve at all) and navigate to whichever answered first, same
        // local-then-ordered-externals preference apply_config uses on every later launch.
        if let (Some(local_url), Some(external_urls)) = (&config.local_url, &config.external_urls) {
            if external_urls.is_empty() {
                return ChooseSetupResult { ok: None, canceled: None, error: Some("At least one external URL is required.".into()) };
            }
            let local_trimmed = local_url.trim_end_matches('/').to_string();
            let external_trimmed: Vec<String> = external_urls.iter().map(|u| u.trim_end_matches('/').to_string()).collect();
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
            let data_dir = app_data_dir(&app);
            let _ = store::write_config(
                &data_dir,
                &store::DesktopConfig {
                    mode: Some("remote".into()),
                    data_dir: None,
                    server_url: None,
                    local_url: Some(local_trimmed),
                    local_network_name: config.local_network_name.clone(),
                    external_urls: Some(external_trimmed),
                    external_url: None,
                    offline_mode: config.offline_mode,
                },
            );
            api::stop_api(&app);
            let _ = window.navigate(target.parse().unwrap());
            return ChooseSetupResult { ok: Some(true), canceled: None, error: None };
        }

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
                local_url: None,
                local_network_name: None,
                external_urls: None,
                external_url: None,
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
            local_url: None,
            local_network_name: None,
            external_urls: None,
            external_url: None,
            offline_mode: None,
        },
    );
    api::stop_api(&app);
    if let Err(e) = api::start_api(&app, Some(data_dir)).await {
        return ChooseSetupResult { ok: None, canceled: None, error: Some(e) };
    }
    let url = format!("http://127.0.0.1:{}", api::LOCAL_PORT);
    if let Err(e) = api::wait_for_server(&format!("{url}/health"), 30_000).await {
        return ChooseSetupResult { ok: None, canceled: None, error: Some(e) };
    }
    let _ = window.navigate(url.parse().unwrap());
    ChooseSetupResult { ok: Some(true), canceled: None, error: None }
}

#[derive(serde::Serialize)]
struct CurrentNetworkInfo {
    #[serde(rename = "localIp")]
    local_ip: Option<String>,
    #[serde(rename = "wifiName")]
    wifi_name: Option<String>,
}

// Backs Settings' "use current connection" button for Automatic URL Switching's local-network
// fields — autofills the local URL (from the LAN IP, still requiring the user to add the
// server's port/scheme) and the network-name field (from the live WiFi SSID) in one click
// instead of asking the user to go find either value themselves.
#[tauri::command]
fn current_network_info(window: WebviewWindow) -> CurrentNetworkInfo {
    if !is_trusted_sender(&window) {
        return CurrentNetworkInfo { local_ip: None, wifi_name: None };
    }
    CurrentNetworkInfo { local_ip: network::current_lan_ip(), wifi_name: network::current_wifi_ssid() }
}

// Backs the live green-checkmark test fired the moment a URL is added/edited in Settings —
// reuses the exact same reachability check apply_config/choose_setup use at connect time, so
// "tested reachable here" means the same thing it will at the next real launch.
#[tauri::command]
async fn test_endpoint(window: WebviewWindow, url: String) -> bool {
    if !is_trusted_sender(&window) {
        return false;
    }
    let trimmed = url.trim_end_matches('/');
    api::is_reachable(&format!("{trimmed}/health")).await
}

// Backs Settings' "Sign in" step for connecting to a remote server — see api::test_login's own
// comment for why this check runs natively instead of as a renderer fetch().
#[tauri::command]
async fn test_login(window: WebviewWindow, url: String, email: String, password: String) -> Result<(), String> {
    if !is_trusted_sender(&window) {
        return Err("Not allowed from this page.".into());
    }
    let trimmed = url.trim_end_matches('/');
    api::test_login(trimmed, &email, &password).await
}

fn build_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let change_server = MenuItem::with_id(app, "change-server", "Change Server / Library…", true, None::<&str>)?;
    // Finder-style delete accelerator (CmdOrCtrl+Backspace, not bare Backspace/Delete — those
    // stay reserved for text-field editing everywhere else in the app). Fires the exact same
    // frontend handler as the `Delete` DOM keyboard shortcut (see useKeyboardShortcuts usage in
    // GalleryPage) — one action, two triggers.
    let delete_selected = MenuItem::with_id(app, "delete-selected", "Delete", true, Some("CmdOrCtrl+Backspace"))?;
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
                Ok(()) => {
                    let _ = window.navigate(url.parse().unwrap());
                }
                Err(e) => {
                    app.dialog().message(e).kind(tauri_plugin_dialog::MessageDialogKind::Error).blocking_show();
                }
            }
        }
        Some(cfg) if cfg.mode.as_deref() == Some("remote") => {
            // Automatic URL Switching on: prefer the local address only when we're actually on
            // its designated Wi-Fi network right now (cfg.local_network_name being None means a
            // config saved before this field existed — keep its old "always try local first"
            // behavior rather than breaking it). Reachability is still checked even on a network
            // match, as a safety net for "right network, server's just down right now" — falling
            // through to the ordered external list either way. Nothing here answering just
            // navigates to the last external one anyway (same permissive "let the webview show
            // its own connection error" behavior the single-URL path below already had) rather
            // than blocking setup on a dialog — a transient network hiccup shouldn't be harder to
            // get past than it was before this feature existed.
            if let Some(local_url) = &cfg.local_url {
                let on_local_network = match &cfg.local_network_name {
                    Some(name) => network::current_wifi_ssid().as_deref() == Some(name.as_str()),
                    None => true,
                };
                let external_urls = cfg.external_urls.clone().unwrap_or_default();
                let mut target = None;
                if on_local_network && api::is_reachable(&format!("{local_url}/health")).await {
                    target = Some(local_url.clone());
                }
                if target.is_none() {
                    for url in &external_urls {
                        if api::is_reachable(&format!("{url}/health")).await {
                            target = Some(url.clone());
                            break;
                        }
                    }
                }
                let target = target.or_else(|| external_urls.last().cloned()).unwrap_or_else(|| local_url.clone());
                let _ = window.navigate(target.parse().unwrap());
            } else if let Some(server_url) = cfg.server_url {
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
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(api::ApiState::default())
        .invoke_handler(tauri::generate_handler![
            get_config,
            choose_setup,
            platform,
            set_window_theme_background,
            current_network_info,
            test_endpoint,
            test_login
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

            // title_bar_style/hidden_title/traffic_light_position are macOS-only builder
            // methods (calling them unconditionally fails to COMPILE on Windows/Linux, not
            // just a runtime no-op — confirmed against the tauri crate source) — this whole
            // block only makes sense on macOS's frameless-with-native-traffic-lights window
            // anyway. Windows/Linux get Tauri's normal decorated window with no special
            // handling. Standard native traffic lights, no custom override, no forced
            // appearance — same as any other native macOS app.
            #[cfg(target_os = "macos")]
            {
                window_builder = window_builder
                    // Native macOS traffic lights over our own header (see index.css's
                    // [data-mac-app] rules) — direct equivalent of Electron's titleBarStyle:
                    // "hidden" + trafficLightPosition. Genuinely native (owned by AppKit), same as
                    // Electron's — validated in the Phase 1 spike with no blur-visibility bug.
                    .title_bar_style(tauri::TitleBarStyle::Overlay)
                    .hidden_title(true)
                    .traffic_light_position(tauri::LogicalPosition::new(20.0, 20.0));
            }

            let window = window_builder
                // Tauri intercepts OS-level file drag-and-drop by default and routes it through
                // its own DragDrop event system instead of letting it reach the webview as a
                // normal DOM DragEvent — which left BulkImportPage's onDrop handler seeing an
                // empty dataTransfer.files every time (the browser-side event still fires, just
                // with no file payload). Disabling Tauri's own handler here restores standard
                // HTML5 drag-and-drop for the whole window, matching how it already works when
                // this same page runs in a normal browser.
                .disable_drag_drop_handler()
                // Injected before ANY page script runs, on every navigation (including once
                // this window later navigates away to http://127.0.0.1:4310 or a remote
                // server's own origin) — the one piece apps/web's own Tauri shim (main.tsx)
                // needs synchronously rather than via an async invoke() call. See bridge.js's
                // matching comment for why this can't just be a preload script like Electron's.
                .initialization_script(&format!("window.__LIFER_PLATFORM__ = {:?};", platform()))
                // target=_blank links (e.g. the eBird checklist link) open in the user's real
                // browser instead of navigating this window away — mirrors main.js's
                // setWindowOpenHandler.
                .on_navigation(move |url| {
                    eprintln!("[lifer-debug] on_navigation fired for: {url}");
                    let is_local_asset = url.scheme() == "tauri";
                    let is_local_api = url.host_str() == Some("127.0.0.1") && url.port() == Some(api::LOCAL_PORT);
                    // Any of server_url/local_url/external_urls counts as "our own configured
                    // server" here — matches is_trusted_sender's own candidate list, since a
                    // window mid-navigation to any of them is just as legitimate as one already
                    // sitting on it (Automatic URL Switching's whole point is that this window
                    // moves between these addresses over its lifetime, not just at launch).
                    let is_configured_remote = store::read_config(&app_data_dir(&nav_handle)).is_some_and(|cfg| {
                        let mut candidates = vec![cfg.server_url, cfg.local_url];
                        candidates.extend(cfg.external_urls.unwrap_or_default().into_iter().map(Some));
                        candidates.into_iter().flatten().any(|s| {
                            url::Url::parse(&s).is_ok_and(|server| server.host_str() == url.host_str() && server.scheme() == url.scheme())
                        })
                    });
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
                    eprintln!("[lifer-debug] on_new_window fired for: {url}");
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
