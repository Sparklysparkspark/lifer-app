// When the remote server is unreachable, open the library on this computer instead of a blank window.
// Once the server answers again, offer to push local additions or switch back. The saved mode stays remote.
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Manager, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

use crate::commands::remembered_local_dir;
use crate::{api, app_data_dir, navigate_or_picker, network, offline_cache, store};

pub(crate) const STARTUP_SERVER_TRIES: u32 = 3;
const SERVER_CHECK_INTERVAL_SECS: u64 = 15;
// About a minute of failed checks, so a brief network drop or waking from sleep doesn't switch.
const SERVER_FAILURES_BEFORE_FALLBACK: u32 = 4;
const PUSH_BUTTON: &str = "Push My Photos";
const SWITCH_BUTTON: &str = "Switch to Server";

#[derive(Default)]
pub(crate) struct ServerFallback {
    active: AtomicBool,
    // The watcher runs (one at a time) while connected to a server.
    watching: AtomicBool,
    // Asked "switch back?" already this time; not asked again until the next disconnect.
    offered: AtomicBool,
}

// A new connection or library replaces the offline fallback, so its watcher must not offer
// to switch back.
pub(crate) fn end_server_fallback(app: &AppHandle) {
    app.state::<ServerFallback>()
        .active
        .store(false, Ordering::SeqCst);
}

/// The configured server address that answers now, in Automatic URL Switching's order (its
/// local address on its own Wi-Fi, then the external ones), or None when none does.
pub(crate) async fn reachable_server(cfg: &store::DesktopConfig) -> Option<String> {
    if let Some(local_url) = &cfg.local_url {
        let on_local_network = match &cfg.local_network_name {
            // Reading the SSID runs a system tool (nmcli can rescan), so keep it off the async workers.
            Some(name) => {
                let ssid = tauri::async_runtime::spawn_blocking(network::current_wifi_ssid)
                    .await
                    .ok()
                    .flatten();
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
    api::is_reachable(&format!("{server_url}/health"))
        .await
        .then(|| server_url.clone())
}

fn server_label(cfg: &store::DesktopConfig) -> String {
    cfg.server_url
        .clone()
        .or_else(|| cfg.local_url.clone())
        .unwrap_or_else(|| "your server".into())
}

pub(crate) async fn use_local_while_offline(
    app: &AppHandle,
    window: &WebviewWindow,
    cfg: &store::DesktopConfig,
) {
    let state = app.state::<ServerFallback>();
    state.active.store(true, Ordering::SeqCst);
    state.offered.store(false, Ordering::SeqCst);
    app.dialog()
        .message(format!(
            "Lifer can't reach your server at {}.\n\nYou can keep working in the library on this computer. When the server is back, Lifer will offer to push what you've added to it.",
            server_label(cfg)
        ))
        .title("Server disconnected")
        .kind(tauri_plugin_dialog::MessageDialogKind::Warning)
        .show(|_| {});
    // The library "Use This Computer's Library" opens, so work done offline lands in it.
    if let Err(e) = api::start_api(
        app,
        cfg.data_dir.clone().or_else(|| remembered_local_dir(app)),
    )
    .await
    {
        app.dialog()
            .message(e)
            .kind(tauri_plugin_dialog::MessageDialogKind::Error)
            .show(|_| {});
        return;
    }
    let url = format!("http://127.0.0.1:{}", api::LOCAL_PORT);
    // The first time, the library on this computer is created and its species catalog loaded.
    match api::wait_for_server(&format!("{url}/health"), 120_000).await {
        Ok(()) => navigate_or_picker(window, &url),
        Err(e) => {
            app.dialog()
                .message(e)
                .kind(tauri_plugin_dialog::MessageDialogKind::Error)
                .show(|_| {});
        }
    }
}

/// Checks the server while in remote mode: switches to this computer's library after a minute
/// without an answer, and offers to switch back when it answers again. Stops once the app leaves
/// remote mode.
/// Starts watching the server unless a watcher already is: at launch, and whenever the app
/// connects to a server later.
pub(crate) fn ensure_server_watcher(app: &AppHandle, window: &WebviewWindow) {
    if !app
        .state::<ServerFallback>()
        .watching
        .swap(true, Ordering::SeqCst)
    {
        tauri::async_runtime::spawn(watch_server(app.clone(), window.clone()));
    }
}

async fn watch_server(app: AppHandle, window: WebviewWindow) {
    let mut failures = 0;
    loop {
        tokio::time::sleep(std::time::Duration::from_secs(SERVER_CHECK_INTERVAL_SECS)).await;
        let Some(cfg) =
            store::read_config(&app_data_dir(&app)).filter(|c| c.mode.as_deref() == Some("remote"))
        else {
            app.state::<ServerFallback>()
                .watching
                .store(false, Ordering::SeqCst);
            return;
        };
        let reachable = reachable_server(&cfg).await;
        let state = app.state::<ServerFallback>();
        // Showing the offline cache: back to the server as soon as it answers.
        if offline_cache::showing(&window) {
            if let Some(url) = reachable {
                failures = 0;
                navigate_or_picker(&window, &url);
            }
            continue;
        }
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
                offline_cache::show_offline_or_local(&app, &window, &cfg).await;
            }
        }
    }
}
