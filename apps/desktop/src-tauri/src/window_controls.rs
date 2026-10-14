// A round colour behind each traffic light, set on the native buttons' own layers. macOS greys the
// buttons out while the window is in the background, which on the app's white title bar leaves
// them nearly invisible, and their see-through edges look uneven even in colour. A layer's
// background draws beneath the button's own drawing, so macOS's edge and shading stay, and being
// part of the button it never moves with the page (a rubber-band bounce moves the web content).

use objc2::msg_send;
use objc2::runtime::{AnyObject, Bool};

// NSWindowButton values: close, minimize, zoom.
const BUTTONS: [usize; 3] = [0, 1, 2];
// macOS's own traffic light colours, in the same order.
const ACTIVE: [[u8; 3]; 3] = [[0xff, 0x5f, 0x57], [0xfe, 0xbc, 0x2e], [0x28, 0xc8, 0x40]];
// Apple's systemGray5.
const INACTIVE: [u8; 3] = [0xe5, 0xe5, 0xea];

pub enum Backdrop {
    /// The window is active: each button's own colour.
    Active,
    /// The window is in the background: a light grey.
    Inactive,
    /// None (dark mode, where the buttons already stand out).
    Off,
}

pub fn set_backdrop(ns_window: *mut std::ffi::c_void, backdrop: Backdrop) {
    unsafe {
        let Some(window) = (ns_window as *mut AnyObject).as_ref() else {
            return;
        };
        for (i, &kind) in BUTTONS.iter().enumerate() {
            let button: *mut AnyObject = msg_send![window, standardWindowButton: kind];
            let Some(button) = button.as_ref() else {
                continue;
            };
            let _: () = msg_send![button, setWantsLayer: Bool::YES];
            let layer: *mut AnyObject = msg_send![button, layer];
            let Some(layer) = layer.as_ref() else {
                continue;
            };
            let rgb = match backdrop {
                Backdrop::Active => Some(ACTIVE[i]),
                Backdrop::Inactive => Some(INACTIVE),
                Backdrop::Off => None,
            };
            let color: *const std::ffi::c_void = match rgb {
                Some([r, g, b]) => {
                    let ns_color: *mut AnyObject = msg_send![
                        objc2::class!(NSColor),
                        colorWithSRGBRed: r as f64 / 255.0,
                        green: g as f64 / 255.0,
                        blue: b as f64 / 255.0,
                        alpha: 1.0f64
                    ];
                    msg_send![ns_color, CGColor]
                }
                None => std::ptr::null(),
            };
            let _: () = msg_send![layer, setBackgroundColor: color];
            let bounds: objc2_foundation::NSRect = msg_send![button, bounds];
            let _: () = msg_send![layer, setCornerRadius: bounds.size.width / 2.0];
        }
    }
}
