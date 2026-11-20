// Remembers the main window's size, position and theme background between launches, so it reopens
// where it was and its background already matches the theme before the first page paints.
use crate::fsutil::write_atomic;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Manager, WebviewWindow};

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, Default)]
pub struct WindowState {
    // Logical pixels, so a change of display scale doesn't resize the window.
    pub x: Option<f64>,
    pub y: Option<f64>,
    pub width: Option<f64>,
    pub height: Option<f64>,
    pub maximized: bool,
    // None until the web app first reports its theme; the window then follows the OS.
    pub dark: Option<bool>,
}

/// A monitor's top-left and size in logical pixels.
pub type Screen = (f64, f64, f64, f64);

// Enough of the title bar must stay on a screen to grab and drag the window back.
const GRAB_PX: f64 = 80.0;

fn path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("window-state.json")
}

pub fn read(app_data_dir: &Path) -> WindowState {
    std::fs::read_to_string(path(app_data_dir))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn write(app_data_dir: &Path, state: &WindowState) {
    if let Ok(json) = serde_json::to_string(state) {
        let _ = write_atomic(&path(app_data_dir), json.as_bytes(), None);
    }
}

/// The saved position, or None when it no longer lands on any screen (a display was unplugged),
/// in which case the window opens centred.
pub fn visible_position(state: &WindowState, screens: &[Screen]) -> Option<(f64, f64)> {
    let (x, y, w) = (state.x?, state.y?, state.width?);
    screens
        .iter()
        .any(|&(sx, sy, sw, sh)| {
            x + w > sx + GRAB_PX && x < sx + sw - GRAB_PX && y >= sy - 1.0 && y < sy + sh - GRAB_PX
        })
        .then_some((x, y))
}

/// The saved size, kept inside the largest screen so it can never open bigger than the display.
pub fn fitted_size(state: &WindowState, screens: &[Screen]) -> Option<(f64, f64)> {
    let (w, h) = (state.width?, state.height?);
    let max_w = screens.iter().map(|s| s.2).fold(0.0, f64::max);
    let max_h = screens.iter().map(|s| s.3).fold(0.0, f64::max);
    if max_w <= 0.0 {
        return Some((w, h));
    }
    Some((w.min(max_w), h.min(max_h)))
}

pub fn screens(app: &AppHandle) -> Vec<Screen> {
    app.available_monitors()
        .unwrap_or_default()
        .iter()
        .map(|m| {
            let s = m.scale_factor();
            let (p, z) = (m.position(), m.size());
            (
                p.x as f64 / s,
                p.y as f64 / s,
                z.width as f64 / s,
                z.height as f64 / s,
            )
        })
        .collect()
}

static SAVE_GENERATION: AtomicU64 = AtomicU64::new(0);

/// Writes the window's current geometry. Skipped while minimized or full screen, whose geometry
/// isn't the window's normal one.
pub fn save_now(window: &WebviewWindow, app_data_dir: &Path) {
    if window.is_minimized().unwrap_or(false) || window.is_fullscreen().unwrap_or(false) {
        return;
    }
    let mut state = read(app_data_dir);
    state.maximized = window.is_maximized().unwrap_or(false);
    if !state.maximized {
        let scale = window.scale_factor().unwrap_or(1.0);
        if let (Ok(p), Ok(s)) = (window.outer_position(), window.inner_size()) {
            state.x = Some(p.x as f64 / scale);
            state.y = Some(p.y as f64 / scale);
            state.width = Some(s.width as f64 / scale);
            state.height = Some(s.height as f64 / scale);
        }
    }
    write(app_data_dir, &state);
}

/// Saves shortly after the last move or resize, so a force-quit loses at most a moment of dragging.
pub fn save_soon(window: &WebviewWindow, app_data_dir: PathBuf) {
    let generation = SAVE_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    let window = window.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(600));
        if SAVE_GENERATION.load(Ordering::SeqCst) == generation {
            save_now(&window, &app_data_dir);
        }
    });
}

pub fn save_dark(app: &AppHandle, dark: bool) {
    let dir = crate::app_data_dir(app);
    let mut state = read(&dir);
    if state.dark != Some(dark) {
        state.dark = Some(dark);
        write(&dir, &state);
    }
}

pub fn main_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(crate::WINDOW_LABEL)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SCREEN: Screen = (0.0, 0.0, 1920.0, 1080.0);
    fn at(x: f64, y: f64) -> WindowState {
        WindowState {
            x: Some(x),
            y: Some(y),
            width: Some(1000.0),
            height: Some(700.0),
            ..Default::default()
        }
    }

    #[test]
    fn keeps_a_visible_position() {
        assert_eq!(
            visible_position(&at(100.0, 50.0), &[SCREEN]),
            Some((100.0, 50.0))
        );
    }

    #[test]
    fn drops_a_position_on_a_removed_display() {
        assert_eq!(visible_position(&at(2500.0, 50.0), &[SCREEN]), None);
        assert_eq!(visible_position(&at(100.0, 1200.0), &[SCREEN]), None);
    }

    #[test]
    fn keeps_a_position_on_a_second_display_left_of_the_first() {
        let left: Screen = (-1920.0, 0.0, 1920.0, 1080.0);
        assert_eq!(
            visible_position(&at(-1800.0, 20.0), &[left, SCREEN]),
            Some((-1800.0, 20.0))
        );
    }

    #[test]
    fn caps_the_size_to_the_largest_screen() {
        let mut s = at(0.0, 0.0);
        s.width = Some(5000.0);
        assert_eq!(fitted_size(&s, &[SCREEN]), Some((1920.0, 700.0)));
    }

    #[test]
    fn nothing_saved_gives_defaults() {
        assert_eq!(visible_position(&WindowState::default(), &[SCREEN]), None);
        assert_eq!(fitted_size(&WindowState::default(), &[SCREEN]), None);
    }
}
