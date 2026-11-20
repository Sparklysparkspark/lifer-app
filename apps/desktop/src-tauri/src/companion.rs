// Phone companion on the desktop: when the LAN listener runs, what the Settings > Connect phone
// page can ask, and what closing the window does (plan: mobile-implementation-plan.md, A-03, A-05).
//
// The listener runs only while a phone is paired or a pairing code is on screen, only in local
// mode (a desktop linked to a server pairs phones with the server), and not while paused.
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Manager, WebviewWindow};
use tauri_plugin_autostart::ManagerExt as _;
use tauri_plugin_dialog::DialogExt;

use crate::companion_listener::{self as listener, Hooks, Running};
use crate::security::is_app_page;
use crate::{api, app_data_dir, store, tray};

// Longer than the 5 minutes a pairing code lives, so a code shown late still has a listener.
const PAIRING_WINDOW: Duration = Duration::from_secs(6 * 60);
const NOT_ALLOWED: &str = "Not allowed from this page.";

#[derive(Default)]
pub struct CompanionState {
    running: tokio::sync::Mutex<Option<Running>>,
    pairing_until: Mutex<Option<Instant>>,
    paused: AtomicBool,
    // Milliseconds since the epoch of the last request a phone's key got through; 0 for none.
    last_sync_ms: AtomicI64,
    // Set by tray.rs: false where the system has no tray area.
    pub(crate) tray_ok: AtomicBool,
    pairing_generation: AtomicU64,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64)
}

fn is_local_mode(app: &AppHandle) -> bool {
    store::read_config(&app_data_dir(app)).is_some_and(|c| c.mode.as_deref() == Some("local"))
}

pub fn is_paused(app: &AppHandle) -> bool {
    app.state::<CompanionState>().paused.load(Ordering::Relaxed)
}

pub fn last_sync_ms(app: &AppHandle) -> Option<i64> {
    Some(
        app.state::<CompanionState>()
            .last_sync_ms
            .load(Ordering::Relaxed),
    )
    .filter(|&m| m > 0)
}

/// Whether the shell should outlive its window: a phone is paired and the setting is on.
pub fn background_wanted(app: &AppHandle) -> bool {
    let s = store::read_companion(&app_data_dir(app));
    is_local_mode(app) && s.paired && s.keep_syncing
}

/// How many phones the library has paired; None when its API can't be asked.
async fn paired_count() -> Option<usize> {
    let res = crate::sync::local_client()
        .await
        .ok()?
        .get(format!(
            "http://127.0.0.1:{}/api/companion/v1/devices",
            api::LOCAL_PORT
        ))
        .header(
            "x-lifer-launch-token",
            crate::local_credential::launch_token(),
        )
        .send()
        .await
        .ok()?
        .error_for_status()
        .ok()?;
    let body: serde_json::Value = res.json().await.ok()?;
    Some(body["devices"].as_array()?.len())
}

/// Starts or stops the listener to match the settings, and the tray to match. Whether a phone is
/// paired comes from the API, so a phone removed anywhere stops the listener.
pub async fn reconcile(app: &AppHandle) {
    let dir = app_data_dir(app);
    let mut settings = store::read_companion(&dir);
    if is_local_mode(app) {
        if let Some(n) = paired_count().await {
            if settings.paired != (n > 0) {
                settings.paired = n > 0;
                let _ = store::write_companion(&dir, &settings);
            }
        }
    }
    let state = app.state::<CompanionState>();
    let mut running = state.running.lock().await;
    let pairing_open = state
        .pairing_until
        .lock()
        .is_ok_and(|p| p.is_some_and(|t| t > Instant::now()));
    let want = is_local_mode(app) && !is_paused(app) && (settings.paired || pairing_open);
    if want && running.is_none() {
        // The id comes from the API's own /health; without it the phone still has the QR addresses.
        let instance_id = api::health_info(&format!("http://127.0.0.1:{}/health", api::LOCAL_PORT))
            .await
            .and_then(|h| h.instance_id);
        let (paired_app, synced_app) = (app.clone(), app.clone());
        let hooks = Hooks {
            on_paired: Box::new(move || note_paired(&paired_app)),
            on_synced: Box::new(move || note_synced(&synced_app)),
        };
        match listener::start(
            &app_data_dir(app),
            api::LOCAL_PORT,
            instance_id.as_deref(),
            listener::PREFERRED_PORT,
            hooks,
        ) {
            Ok(r) => *running = Some(r),
            Err(e) => eprintln!("[lifer] phone listener didn't start: {e}"),
        }
    } else if !want {
        if let Some(r) = running.take() {
            r.stop();
        }
    }
    drop(running);
    tray::sync(app);
}

pub fn stop(app: &AppHandle) {
    let state = app.state::<CompanionState>();
    if let Ok(mut running) = state.running.try_lock() {
        if let Some(r) = running.take() {
            r.stop();
        }
    };
}

fn note_paired(app: &AppHandle) {
    let dir = app_data_dir(app);
    let mut s = store::read_companion(&dir);
    if !s.paired {
        s.paired = true;
        let _ = store::write_companion(&dir, &s);
    }
    note_synced(app);
    tray::sync(app);
}

fn note_synced(app: &AppHandle) {
    app.state::<CompanionState>()
        .last_sync_ms
        .store(now_ms(), Ordering::Relaxed);
}

pub fn set_paused(app: &AppHandle, paused: bool) {
    app.state::<CompanionState>()
        .paused
        .store(paused, Ordering::Relaxed);
    let app = app.clone();
    tauri::async_runtime::spawn(async move { reconcile(&app).await });
}

/// Handles the main window's close. Returns true when the window should only be hidden because
/// the shell keeps syncing; the first time, explains that and offers to turn it off.
pub fn keep_running_on_close(app: &AppHandle, window: &WebviewWindow) -> bool {
    if !background_wanted(app) {
        return false;
    }
    // Without a tray area (some Linux desktops) the window is minimised so it can be found again.
    if app
        .state::<CompanionState>()
        .tray_ok
        .load(Ordering::Relaxed)
    {
        let _ = window.hide();
    } else {
        let _ = window.minimize();
    }
    let dir = app_data_dir(app);
    let mut s = store::read_companion(&dir);
    if !s.close_notice_shown {
        s.close_notice_shown = true;
        let _ = store::write_companion(&dir, &s);
        let (app, window) = (app.clone(), window.clone());
        app.dialog()
            .message("Lifer keeps running in the menu bar or system tray so your phone can sync. You can turn this off in Settings > Connect phone.")
            .title("Lifer is still syncing")
            .buttons(tauri_plugin_dialog::MessageDialogButtons::OkCancelCustom(
                "Keep Syncing".into(),
                "Turn Off and Quit".into(),
            ))
            .show({
                let app = app.clone();
                move |keep| {
                    if !keep {
                        let mut s = store::read_companion(&app_data_dir(&app));
                        s.keep_syncing = false;
                        let _ = store::write_companion(&app_data_dir(&app), &s);
                        let _ = window.close();
                    }
                }
            });
    }
    true
}

// ---- Commands for Settings > Connect phone (local library page only) ----------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    listening: bool,
    paired: bool,
    keep_syncing: bool,
    paused: bool,
    last_synced_at: Option<i64>,
    autostart: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingInfo {
    addresses: Vec<String>,
    cert_sha256: String,
}

fn check(window: &WebviewWindow) -> Result<(), String> {
    is_app_page(window)
        .then_some(())
        .ok_or_else(|| NOT_ALLOWED.to_string())
}

#[tauri::command]
pub(crate) async fn companion_status(
    app: AppHandle,
    window: WebviewWindow,
) -> Result<Status, String> {
    check(&window)?;
    let s = store::read_companion(&app_data_dir(&app));
    let listening = app.state::<CompanionState>().running.lock().await.is_some();
    Ok(Status {
        listening,
        paired: s.paired,
        keep_syncing: s.keep_syncing,
        paused: is_paused(&app),
        last_synced_at: last_sync_ms(&app),
        autostart: app.autolaunch().is_enabled().unwrap_or(false),
    })
}

/// Starts the listener for the pairing window and says where a phone can reach it.
#[tauri::command]
pub(crate) async fn companion_open_pairing(
    app: AppHandle,
    window: WebviewWindow,
) -> Result<PairingInfo, String> {
    check(&window)?;
    if !is_local_mode(&app) {
        return Err("This computer isn't running its own library.".into());
    }
    let state = app.state::<CompanionState>();
    state.paused.store(false, Ordering::Relaxed);
    if let Ok(mut until) = state.pairing_until.lock() {
        *until = Some(Instant::now() + PAIRING_WINDOW);
    }
    // Close the window again after a new pairing window passes without a phone pairing.
    let generation = state.pairing_generation.fetch_add(1, Ordering::Relaxed) + 1;
    let timer_app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(PAIRING_WINDOW + Duration::from_secs(1)).await;
        if timer_app
            .state::<CompanionState>()
            .pairing_generation
            .load(Ordering::Relaxed)
            == generation
        {
            reconcile(&timer_app).await;
        }
    });
    reconcile(&app).await;
    let running = state.running.lock().await;
    let r = running
        .as_ref()
        .ok_or("Couldn't start listening for your phone.")?;
    let addresses = listener::lan_addresses(r.port);
    if addresses.is_empty() {
        return Err("This computer isn't on a network your phone can reach.".into());
    }
    Ok(PairingInfo {
        addresses,
        cert_sha256: r.sha256.clone(),
    })
}

/// The page calls this after its phone list changes; the count comes from the API, not the page.
#[tauri::command]
pub(crate) async fn companion_set_paired(
    app: AppHandle,
    window: WebviewWindow,
) -> Result<(), String> {
    check(&window)?;
    reconcile(&app).await;
    Ok(())
}

#[tauri::command]
pub(crate) async fn companion_set_keep_syncing(
    app: AppHandle,
    window: WebviewWindow,
    enabled: bool,
) -> Result<(), String> {
    check(&window)?;
    let dir = app_data_dir(&app);
    let mut s = store::read_companion(&dir);
    s.keep_syncing = enabled;
    store::write_companion(&dir, &s).map_err(|e| e.to_string())?;
    tray::sync(&app);
    Ok(())
}

/// "Start at login" is off until the user turns it on here.
#[tauri::command]
pub(crate) fn companion_set_autostart(
    app: AppHandle,
    window: WebviewWindow,
    enabled: bool,
) -> Result<(), String> {
    check(&window)?;
    let launch = app.autolaunch();
    if enabled {
        launch.enable()
    } else {
        launch.disable()
    }
    .map_err(|e| e.to_string())
}

/// True when the app was started by "Start at login" and should stay out of the way.
pub fn started_hidden() -> bool {
    std::env::args().any(|a| a == "--hidden")
}
