mod api;
mod commands;
mod embedded_db;
mod fsutil;
mod local_credential;
mod local_inference;
mod menu;
mod model_cache;
mod network;
mod offline_cache;
#[cfg(target_os = "macos")]
mod open_panel;
mod pg_upgrade;
mod remove_data;
mod security;
mod server_watch;
mod store;
#[cfg(target_os = "macos")]
mod window_controls;

use tauri::{AppHandle, Listener, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_dialog::DialogExt;
#[cfg(target_os = "macos")]
use tauri_plugin_opener::OpenerExt;

use security::{grant_remote_capabilities, is_configured_server, is_local_api, open_external};
use server_watch::{ensure_server_watcher, reachable_server, STARTUP_SERVER_TRIES};

const WINDOW_LABEL: &str = "main";
const PICKER_URL: &str = "tauri://localhost/picker.html";

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

fn app_data_dir(app: &AppHandle) -> std::path::PathBuf {
    app.path()
        .app_data_dir()
        .expect("app data dir must resolve")
}

async fn apply_config(app: AppHandle, window: WebviewWindow) {
    let config = store::read_config(&app_data_dir(&app));
    match config {
        Some(cfg) if cfg.mode.as_deref() == Some("local") => {
            if let Err(e) = api::start_api(&app, cfg.data_dir).await {
                app.dialog()
                    .message(e)
                    .kind(tauri_plugin_dialog::MessageDialogKind::Error)
                    .blocking_show();
                return;
            }
            let url = format!("http://127.0.0.1:{}", api::LOCAL_PORT);
            match api::wait_for_server(&format!("{url}/health"), 30_000).await {
                Ok(()) => navigate_or_picker(&window, &url),
                Err(e) => {
                    app.dialog()
                        .message(e)
                        .kind(tauri_plugin_dialog::MessageDialogKind::Error)
                        .blocking_show();
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
                None => offline_cache::show_offline_or_local(&app, &window, &cfg).await,
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
    if !commands::install_path().is_some_and(|p| commands::is_translocated(&p)) {
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
        .manage(security::RemoteCapabilities::default())
        .manage(server_watch::ServerFallback::default())
        .manage(local_inference::LocalInferenceState::default())
        .invoke_handler(tauri::generate_handler![
            commands::get_config,
            commands::choose_setup,
            commands::platform,
            commands::set_window_theme_background,
            commands::set_traffic_light_backdrop,
            commands::current_network_info,
            commands::test_endpoint,
            commands::test_login,
            commands::app_install_info,
            commands::set_local_data_dir,
            commands::local_inference_status,
            commands::local_inference_prepare,
            commands::local_embed,
            commands::use_local_library,
            commands::local_api_credential,
            remove_data::remove_all_data,
            offline_cache::offline_cache_begin,
            offline_cache::offline_cache_put_thumb,
            offline_cache::offline_cache_commit,
            offline_cache::offline_cache_clear,
            offline_cache::offline_cache_info,
            offline_cache::set_offline_cache,
            offline_cache::offline_cache_snapshot,
            offline_cache::offline_cache_thumb,
            offline_cache::offline_retry,
            offline_cache::offline_use_local_library
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            let menu = menu::build_menu(&handle)?;
            app.set_menu(menu)?;
            app.on_menu_event(menu::handle_menu_event);

            let nav_handle = handle.clone();
            let new_window_handle = handle.clone();
            #[allow(unused_mut)]
            let mut window_builder =
                WebviewWindowBuilder::new(app, WINDOW_LABEL, WebviewUrl::App("index.html".into()))
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
                .initialization_script(format!(
                    "window.__LIFER_PLATFORM__ = {:?}; window.__LIFER_ARCH__ = {:?};",
                    commands::platform(),
                    commands::arch()
                ))
                // Only app, local API and configured-server pages load in this window.
                .on_navigation(move |url| {
                    let is_local_asset = url.scheme() == "tauri";
                    // Same candidate list as is_trusted_sender.
                    let is_configured_remote = store::read_config(&app_data_dir(&nav_handle))
                        .is_some_and(|cfg| is_configured_server(cfg, url));
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
            // Shows database upgrade progress on the startup page (pg_upgrade.rs).
            pg_upgrade::set_status_window(&window);

            #[cfg(target_os = "macos")]
            let _ = window.with_webview(|webview| open_panel::install(webview.inner()));

            // See api::StopApiOnDrop: runs stop_api before the Windows updater force-exits.
            app.resources_table()
                .add(api::StopApiOnDrop(handle.clone()));

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
                // The payload is the JSON-encoded message api.rs emitted.
                let detail = serde_json::from_str::<String>(event.payload())
                    .unwrap_or_else(|_| event.payload().to_string());
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
