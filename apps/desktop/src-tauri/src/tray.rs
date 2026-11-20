// The menu bar icon (macOS) or tray icon (Windows, Linux) that keeps Lifer reachable while its
// window is closed (plan: A-05). It exists only while a phone is paired and "keep syncing" is on.
use std::sync::atomic::Ordering;
use std::sync::Mutex;
use std::time::Duration;

use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, Wry};

use crate::companion::{self, CompanionState};

const TRAY_ID: &str = "lifer-companion";

pub struct TrayItems {
    status: MenuItem<Wry>,
    pause: CheckMenuItem<Wry>,
}

#[derive(Default)]
pub struct TrayState(Mutex<Option<TrayItems>>);

/// "Phone synced 2 min ago", or why nothing has.
pub fn status_text(now_ms: i64, last_ms: Option<i64>, paused: bool) -> String {
    if paused {
        return "Syncing paused".into();
    }
    let Some(last) = last_ms else {
        return "No phone has synced yet".into();
    };
    let secs = ((now_ms - last) / 1000).max(0);
    let ago = match secs {
        0..=59 => return "Phone synced just now".into(),
        60..=3599 => format!("{} min", secs / 60),
        3600..=86399 => format!("{} hr", secs / 3600),
        _ if secs / 86400 == 1 => return "Phone synced 1 day ago".into(),
        _ => return format!("Phone synced {} days ago", secs / 86400),
    };
    format!("Phone synced {ago} ago")
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64)
}

pub fn show_main_window(app: &AppHandle) {
    if let Some(w) = crate::window_state::main_window(app) {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

fn build(app: &AppHandle) -> tauri::Result<TrayItems> {
    let status = MenuItem::with_id(
        app,
        "status",
        "No phone has synced yet",
        false,
        None::<&str>,
    )?;
    let open = MenuItem::with_id(app, "open", "Open Lifer", true, None::<&str>)?;
    let pause = CheckMenuItem::with_id(app, "pause", "Pause Syncing", true, false, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Lifer", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &status,
            &PredefinedMenuItem::separator(app)?,
            &open,
            &pause,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;
    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .tooltip("Lifer")
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => show_main_window(app),
            "pause" => companion::set_paused(app, !companion::is_paused(app)),
            // Quitting from here stops the API, database and listener through the normal exit path.
            "quit" => app.exit(0),
            _ => {}
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(TrayItems { status, pause })
}

fn apply(app: &AppHandle) {
    let state = app.state::<TrayState>();
    let Ok(mut items) = state.0.lock() else {
        return;
    };
    let exists = app.tray_by_id(TRAY_ID).is_some();
    if companion::background_wanted(app) {
        if !exists {
            match build(app) {
                Ok(built) => {
                    app.state::<CompanionState>()
                        .tray_ok
                        .store(true, Ordering::Relaxed);
                    *items = Some(built);
                }
                Err(e) => {
                    eprintln!("[lifer] no tray icon available: {e}");
                    app.state::<CompanionState>()
                        .tray_ok
                        .store(false, Ordering::Relaxed);
                }
            }
        }
        if let Some(i) = items.as_ref() {
            let paused = companion::is_paused(app);
            let _ = i
                .status
                .set_text(status_text(now_ms(), companion::last_sync_ms(app), paused));
            let _ = i.pause.set_checked(paused);
        }
    } else if exists {
        app.remove_tray_by_id(TRAY_ID);
        *items = None;
    }
}

/// Brings the tray in line with the settings and the latest sync. Safe from any thread.
pub fn sync(app: &AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || apply(&handle));
}

/// Keeps "synced 2 min ago" current while nothing else changes, and every 5 minutes re-checks
/// the paired phones so removing the last one anywhere stops the listener.
pub fn start_refreshing(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut tick = 0u32;
        loop {
            tokio::time::sleep(Duration::from_secs(30)).await;
            tick = (tick + 1) % 10;
            if tick == 0 {
                companion::reconcile(&app).await;
            } else {
                sync(&app);
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_text_reads_naturally() {
        let now = 10_000_000_000;
        assert_eq!(status_text(now, None, false), "No phone has synced yet");
        assert_eq!(status_text(now, Some(now), true), "Syncing paused");
        assert_eq!(
            status_text(now, Some(now - 5_000), false),
            "Phone synced just now"
        );
        assert_eq!(
            status_text(now, Some(now - 120_000), false),
            "Phone synced 2 min ago"
        );
        assert_eq!(
            status_text(now, Some(now - 3 * 3_600_000), false),
            "Phone synced 3 hr ago"
        );
        assert_eq!(
            status_text(now, Some(now - 86_400_000), false),
            "Phone synced 1 day ago"
        );
        assert_eq!(
            status_text(now, Some(now - 3 * 86_400_000), false),
            "Phone synced 3 days ago"
        );
        assert_eq!(
            status_text(now, Some(now + 9_000), false),
            "Phone synced just now"
        );
    }
}
