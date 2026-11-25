mod api;
mod commands;
mod companion;
mod companion_listener;
mod crash_report;
mod editors;
mod embedded_db;
mod fsutil;
mod local_credential;
mod local_inference;
mod menu;
mod model_cache;
mod network;
#[cfg(target_os = "macos")]
mod open_panel;
mod pg_upgrade;
mod plugin_install;
mod plugins;
mod remove_data;
mod security;
mod server_link;
mod server_paths;
mod server_watch;
mod store;
mod sync;
mod tray;
mod window_state;

use tauri::{AppHandle, Listener, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_dialog::DialogExt;
#[cfg(target_os = "macos")]
use tauri_plugin_opener::OpenerExt;

use security::{
    bundled_page_url, grant_remote_capabilities, is_bundled_page, is_configured_server,
    is_local_api, open_external,
};
use server_watch::{ensure_server_watcher, reachable_server, STARTUP_SERVER_TRIES};

const WINDOW_LABEL: &str = "main";
const PICKER_PAGE: &str = "picker.html";

// A saved or typed address that doesn't parse must never panic the shell.
fn navigate_or_picker(window: &WebviewWindow, target: &str) {
    match target.parse() {
        Ok(url) => {
            let _ = window.navigate(url);
        }
        Err(e) => {
            eprintln!("[lifer] invalid server address {target:?}: {e}, showing setup");
            if let Ok(picker) = bundled_page_url(window.app_handle(), PICKER_PAGE).parse() {
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
            match api::start_api(&app, cfg.data_dir).await {
                Ok(()) => {
                    navigate_or_picker(&window, &format!("http://127.0.0.1:{}", api::LOCAL_PORT));
                    // Phones paired earlier can sync again, with or without the window.
                    companion::reconcile(&app).await;
                }
                Err(e) => {
                    app.dialog()
                        .message(e)
                        .kind(tauri_plugin_dialog::MessageDialogKind::Error)
                        .blocking_show();
                    // The setup choice, to try the library again or pick another setup.
                    navigate_or_picker(&window, &bundled_page_url(&app, "picker.html#choose"));
                }
            }
        }
        Some(cfg) if cfg.mode.as_deref() == Some("remote") => {
            if cfg.server_url.is_none() && cfg.local_url.is_none() {
                navigate_or_picker(&window, &bundled_page_url(&app, PICKER_PAGE));
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
                Some(url) => {
                    navigate_or_picker(&window, &url);
                    // This computer's library runs alongside: it keeps packs (and later the
                    // collection) in step with the server in the background (sync.rs).
                    sync::kick(&app);
                }
                None => server_watch::use_local_while_offline(&app, &window, &cfg).await,
            }
            ensure_server_watcher(&app, &window);
        }
        _ => navigate_or_picker(&window, &bundled_page_url(&app, PICKER_PAGE)),
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
        // Off until the user turns on "Start at login" in Settings > Connect phone.
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--hidden"]),
        ))
        .manage(api::ApiState::default())
        .manage(companion::CompanionState::default())
        .manage(tray::TrayState::default())
        .manage(security::RemoteCapabilities::default())
        .manage(server_watch::ServerFallback::default())
        .manage(local_inference::LocalInferenceState::default())
        .manage(plugins::PluginRegistry::default())
        .manage(plugins::PluginHost::default())
        .manage(plugin_install::PluginInstalls::default())
        .invoke_handler(tauri::generate_handler![
            commands::get_config,
            commands::choose_setup,
            commands::platform,
            commands::set_window_theme_background,
            commands::current_network_info,
            commands::test_endpoint,
            commands::test_login,
            commands::app_install_info,
            commands::set_local_data_dir,
            commands::local_inference_status,
            commands::local_inference_prepare,
            commands::local_embed,
            commands::use_local_library,
            commands::return_to_setup,
            commands::local_api_credential,
            commands::pick_import_files,
            companion::companion_status,
            companion::companion_open_pairing,
            companion::companion_set_paired,
            companion::companion_set_keep_syncing,
            companion::companion_set_autostart,
            remove_data::remove_all_data,
            server_link::server_link_needed,
            server_link::store_server_link,
            server_link::forget_server_link,
            editors::editors_list,
            editors::open_in,
            editors::editor_pick_other,
            server_paths::server_root_on_this_mac,
            server_paths::reveal_server_file,
            sync::sync_status,
            sync::sync_set_derivative,
            sync::sync_adopt,
            sync::sync_now,
            plugins::plugins_list,
            plugins::plugin_start,
            plugins::plugin_status,
            plugins::plugin_stop,
            plugins::plugin_offered_imports,
            plugins::plugin_export_import,
            plugin_install::plugin_install,
            plugin_install::plugin_install_progress,
            plugin_install::plugin_install_cancel,
            plugin_install::plugin_target,
            plugin_install::plugin_detect,
            plugin_install::plugin_open_installed
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            crash_report::install_panic_hook(app_data_dir(&handle));
            // Keys an earlier launch couldn't revoke on a server it switched away from.
            server_link::retry_pending_revokes(&app_data_dir(&handle));
            plugins::start_watching(&handle);
            let menu = menu::build_menu(&handle)?;
            app.set_menu(menu)?;
            app.on_menu_event(menu::handle_menu_event);

            let nav_handle = handle.clone();
            let new_window_handle = handle.clone();
            let saved = window_state::read(&app_data_dir(&handle));
            let screens = window_state::screens(&handle);
            let (width, height) =
                window_state::fitted_size(&saved, &screens).unwrap_or((1360.0, 900.0));
            // Matches theme.css's --color-canvas, so the window is the right colour before the page loads.
            let canvas = if saved.dark == Some(true) {
                tauri::webview::Color(0x14, 0x15, 0x16, 255)
            } else {
                tauri::webview::Color(0xf6, 0xee, 0xdc, 255)
            };
            #[allow(unused_mut)]
            let mut window_builder =
                WebviewWindowBuilder::new(app, WINDOW_LABEL, WebviewUrl::App("index.html".into()))
                    .title("Lifer")
                    .inner_size(width, height)
                    .maximized(saved.maximized)
                    .background_color(canvas)
                    // Started by "Start at login" with a phone paired: stay in the menu bar or tray.
                    .visible(
                        !(companion::started_hidden() && companion::background_wanted(&handle)),
                    );
            window_builder = match window_state::visible_position(&saved, &screens) {
                Some((x, y)) => window_builder.position(x, y),
                None => window_builder.center(),
            };

            // These builder methods only compile on macOS. Windows and Linux keep Tauri's normal
            // decorated window.
            #[cfg(target_os = "macos")]
            {
                window_builder = window_builder
                    // Native traffic lights over our own header (see index.css's [data-mac-app] rules).
                    .title_bar_style(tauri::TitleBarStyle::Overlay)
                    .hidden_title(true)
                    // Measured: each point of y moves the buttons' centre about 0.86px, from 18px
                    // at y 20. y 29 centres them 26px down, level with the 52px toolbar's middle
                    // (AppSidebar.tsx).
                    .traffic_light_position(tauri::LogicalPosition::new(20.0, 29.0));
            }

            let window = window_builder
                // Tauri's drag-drop handler empties DOM dataTransfer.files; disable it for HTML5 drops.
                .disable_drag_drop_handler()
                // Runs before page scripts on every origin; main.tsx's shim needs the platform
                // synchronously.
                // __LIFER_STORE_UPDATES__: Flathub updates a Flatpak, so the web app hides Lifer's
                // own updater there.
                .initialization_script(format!(
                    "window.__LIFER_PLATFORM__ = {:?}; window.__LIFER_ARCH__ = {:?}; window.__LIFER_STORE_UPDATES__ = {};",
                    commands::platform(),
                    commands::arch(),
                    std::env::var_os("FLATPAK_ID").is_some()
                ))
                // Only app, local API and configured-server pages load in this window.
                .on_navigation(move |url| {
                    let is_local_asset = is_bundled_page(&nav_handle, url);
                    // Same candidate list as is_trusted_sender.
                    let is_configured_remote = store::read_config(&app_data_dir(&nav_handle))
                        .is_some_and(|cfg| is_configured_server(cfg, url));
                    // A plugin's frame navigates too, and must not be sent to the browser.
                    let is_plugin_frame = plugins::is_plugin_origin(&nav_handle, url);
                    if is_local_asset
                        || is_local_api(url)
                        || is_configured_remote
                        || is_plugin_frame
                    {
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
            // No saved theme yet: the page follows the OS, so the window colour does too.
            if saved.dark.is_none() && window.theme().is_ok_and(|t| t == tauri::Theme::Dark) {
                let _ = window.set_background_color(Some(tauri::webview::Color(0x14, 0x15, 0x16, 255)));
            }
            // Shows database upgrade progress on the startup page (pg_upgrade.rs).
            pg_upgrade::set_status_window(&window);

            #[cfg(target_os = "macos")]
            let _ = window.with_webview(|webview| open_panel::install(webview.inner()));

            // See api::StopApiOnDrop: runs stop_api before the Windows updater force-exits.
            app.resources_table()
                .add(api::StopApiOnDrop(handle.clone()));
            app.resources_table()
                .add(plugins::StopPluginsOnDrop(handle.clone()));

            #[cfg(target_os = "macos")]
            warn_if_translocated(&handle);

            if let Some(cfg) = store::read_config(&app_data_dir(&handle)) {
                grant_remote_capabilities(&handle, &cfg);
            }

            tray::start_refreshing(&handle);

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
            let app = window.app_handle();
            match event {
                tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_)
                    if window.label() == WINDOW_LABEL =>
                {
                    if let Some(w) = window_state::main_window(app) {
                        window_state::save_soon(&w, app_data_dir(app));
                    }
                }
                tauri::WindowEvent::CloseRequested { api: close, .. }
                    if window.label() == WINDOW_LABEL =>
                {
                    if let Some(w) = window_state::main_window(app) {
                        window_state::save_now(&w, &app_data_dir(app));
                        // A paired phone keeps syncing while the window is closed.
                        if companion::keep_running_on_close(app, &w) {
                            close.prevent_close();
                        }
                    }
                }
                tauri::WindowEvent::Destroyed => api::stop_api(app),
                _ => {}
            }
        })
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        // Cmd+Q doesn't reliably fire WindowEvent::Destroyed, so stop the sidecar on every normal
        // exit here. A force-quit is covered by the sidecar's parent-pid watchdog.
        .run(|app_handle, event| {
            // Clicking the Dock icon brings back a window the tray kept hidden.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen {
                has_visible_windows: false,
                ..
            } = event
            {
                tray::show_main_window(app_handle);
            }
            if let tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit = event {
                companion::stop(app_handle);
                api::stop_api(app_handle);
                local_inference::stop(app_handle);
                app_handle.state::<plugins::PluginHost>().stop_all();
            }
        });
}

#[cfg(test)]
mod tests {
    // Tauri's ACL denies a registered command that no permission allows, with only a runtime
    // "not allowed" error, so every command in generate_handler! must be in permissions/.
    #[test]
    fn every_registered_command_is_permitted() {
        let lib = include_str!("lib.rs");
        let start =
            lib.find("generate_handler![").expect("the handler list") + "generate_handler![".len();
        let list = &lib[start..start + lib[start..].find(']').expect("its end")];
        let permitted = include_str!("../permissions/app-commands.toml");
        let missing: Vec<&str> = list
            .split(',')
            .map(|entry| entry.trim().rsplit("::").next().unwrap_or("").trim())
            .filter(|name| !name.is_empty() && !permitted.contains(&format!("\"{name}\"")))
            .collect();
        assert!(
            missing.is_empty(),
            "not in permissions/app-commands.toml: {missing:?}"
        );
    }
}
