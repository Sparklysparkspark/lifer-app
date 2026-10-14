// wry's file dialog always lets files be chosen, so a folder input (webkitdirectory) opens a
// panel where double-clicking a folder only enters it and Open then takes just the highlighted
// files. This swaps in the same panel showing folders only for folder inputs, so Open picks the
// folder being shown, like every other macOS folder picker. WebKit then hands the page every file
// inside it, subfolders included.

use block2::Block;
use objc2::rc::Retained;
use objc2::runtime::{AnyObject, Imp, Sel};
use objc2::{msg_send, sel, MainThreadMarker};
use objc2_app_kit::{NSModalResponseOK, NSOpenPanel};
use objc2_foundation::{NSArray, NSURL};
use objc2_web_kit::WKOpenPanelParameters;

extern "C-unwind" fn run_open_panel(
    _this: &AnyObject,
    _sel: Sel,
    _webview: &AnyObject,
    params: &WKOpenPanelParameters,
    _frame: &AnyObject,
    handler: &Block<dyn Fn(*const NSArray<NSURL>)>,
) {
    let Some(mtm) = MainThreadMarker::new() else {
        handler.call((std::ptr::null(),));
        return;
    };
    unsafe {
        let panel = NSOpenPanel::openPanel(mtm);
        let folders = params.allowsDirectories();
        panel.setCanChooseFiles(!folders);
        panel.setCanChooseDirectories(folders);
        panel.setAllowsMultipleSelection(params.allowsMultipleSelection());
        if panel.runModal() == NSModalResponseOK {
            let urls = panel.URLs();
            handler.call((Retained::as_ptr(&urls),));
        } else {
            handler.call((std::ptr::null(),));
        }
    }
}

/// Call once on the main window's webview (`inner()` is its WKWebView).
pub fn install(wk_webview: *mut std::ffi::c_void) {
    unsafe {
        let webview = wk_webview as *mut AnyObject;
        let delegate: *mut AnyObject = msg_send![webview, UIDelegate];
        let Some(delegate) = delegate.as_ref() else { return };
        let class = delegate.class();
        let selector = sel!(webView:runOpenPanelWithParameters:initiatedByFrame:completionHandler:);
        let Some(existing) = class.instance_method(selector) else { return };
        let types = objc2::ffi::method_getTypeEncoding(existing);
        if types.is_null() {
            return;
        }
        let imp: Imp = std::mem::transmute(run_open_panel as *const ());
        objc2::ffi::class_replaceMethod(class as *const _ as *mut _, selector, imp, types);
    }
}

