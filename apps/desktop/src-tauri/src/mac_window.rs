// Hides/shows the native traffic light buttons directly via AppKit — no Tauri-level API
// exposes this (only setDecorations, which removes the whole title bar area, not just the
// buttons), so this reaches through window.ns_window()'s raw pointer instead. Backs the
// custom-drawn traffic lights (see apps/web's TrafficLights.tsx): native buttons genuinely
// can't be recolored to an exact hex when unfocused (no public API), so light theme hides them
// and draws its own; dark theme leaves them native, since forcing the window's overall
// appearance to dark (see lib.rs's .theme(Some(Theme::Dark))) already gives dark-appearance's
// own inactive-button grey, which was confirmed to look fine as-is.
#[cfg(target_os = "macos")]
pub fn set_traffic_lights_hidden(window: &tauri::WebviewWindow, hidden: bool) {
    use objc2_app_kit::{NSWindow, NSWindowButton};

    let Ok(ns_window_ptr) = window.ns_window() else { return };
    if ns_window_ptr.is_null() {
        return;
    }
    // SAFETY: ns_window() hands back a valid, live NSWindow* for as long as this window
    // exists, which it does here (we're handling a command/event on it). Only ever read from
    // (standardWindowButton) and call setHidden on the returned NSButton — no ownership taken.
    unsafe {
        let ns_window: &NSWindow = &*(ns_window_ptr as *const NSWindow);
        for button_type in [NSWindowButton::CloseButton, NSWindowButton::MiniaturizeButton, NSWindowButton::ZoomButton] {
            if let Some(button) = ns_window.standardWindowButton(button_type) {
                button.setHidden(hidden);
            }
        }
    }
}

#[cfg(not(target_os = "macos"))]
pub fn set_traffic_lights_hidden(_window: &tauri::WebviewWindow, _hidden: bool) {}
