// The app menu: the standard macOS items plus switching library or server.
use tauri::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_dialog::DialogExt;

use crate::commands::switch_to_local_library;
use crate::{api, app_data_dir, navigate_or_picker, store, PICKER_PAGE, WINDOW_LABEL};

// Menu items that take the window to a page, by id, with their shortcut. menu:navigate tells the
// web app (App.tsx MenuCommands) where to go.
const NAV_ITEMS: [(&str, &str, &str, &str); 7] = [
    ("nav-settings", "Settings…", "CmdOrCtrl+,", "/settings"),
    (
        "nav-import",
        "Import Photos…",
        "CmdOrCtrl+Shift+I",
        "/import",
    ),
    ("nav-collection", "Collection", "CmdOrCtrl+1", "/"),
    ("nav-gallery", "Gallery", "CmdOrCtrl+2", "/gallery"),
    ("nav-map", "Map", "CmdOrCtrl+3", "/gallery?view=map"),
    ("nav-albums", "Albums", "CmdOrCtrl+4", "/albums"),
    ("nav-stats", "Stats", "CmdOrCtrl+5", "/stats"),
];

fn nav_item(app: &AppHandle, id: &str) -> tauri::Result<MenuItem<tauri::Wry>> {
    let (id, label, accelerator, _) = NAV_ITEMS
        .iter()
        .find(|(item, ..)| *item == id)
        .expect("a known menu item");
    MenuItem::with_id(app, *id, *label, true, Some(*accelerator))
}

pub(crate) fn build_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let change_server = MenuItem::with_id(
        app,
        "change-server",
        "Change Server / Library…",
        true,
        None::<&str>,
    )?;
    let use_local = MenuItem::with_id(
        app,
        "use-local",
        "Use This Computer's Library",
        true,
        None::<&str>,
    )?;
    // Finder-style CmdOrCtrl+Backspace; bare Backspace/Delete stay for text editing. Fires the
    // same frontend handler as the Delete keyboard shortcut.
    let delete_selected = MenuItem::with_id(
        app,
        "delete-selected",
        "Delete",
        true,
        Some("CmdOrCtrl+Backspace"),
    )?;
    let lifer_menu = Submenu::with_items(
        app,
        "Lifer",
        true,
        &[
            &PredefinedMenuItem::about(app, None, None)?,
            &PredefinedMenuItem::separator(app)?,
            &nav_item(app, "nav-settings")?,
            &PredefinedMenuItem::separator(app)?,
            &change_server,
            &use_local,
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
    let file_menu = Submenu::with_items(app, "File", true, &[&nav_item(app, "nav-import")?])?;
    let find = MenuItem::with_id(app, "search", "Find…", true, Some("CmdOrCtrl+F"))?;
    // Mail and Finder's shortcut for the sidebar.
    let toggle_sidebar = MenuItem::with_id(
        app,
        "toggle-sidebar",
        "Show or Hide Sidebar",
        true,
        Some(if cfg!(target_os = "macos") {
            "Ctrl+Cmd+S"
        } else {
            "Ctrl+Alt+S"
        }),
    )?;
    // Sidebar order, so Cmd or Ctrl plus the position matches (web lib/mainPages.ts).
    let go_menu = Submenu::with_items(
        app,
        "Go",
        true,
        &[
            &nav_item(app, "nav-collection")?,
            &nav_item(app, "nav-gallery")?,
            &nav_item(app, "nav-map")?,
            &nav_item(app, "nav-albums")?,
            &nav_item(app, "nav-stats")?,
        ],
    )?;
    let view_menu = Submenu::with_items(
        app,
        "View",
        true,
        &[
            &find,
            &PredefinedMenuItem::separator(app)?,
            &toggle_sidebar,
            &PredefinedMenuItem::fullscreen(app, None)?,
        ],
    )?;
    let window_menu = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;
    Menu::with_items(
        app,
        &[
            &lifer_menu,
            &file_menu,
            &edit_menu,
            &view_menu,
            &go_menu,
            &window_menu,
        ],
    )
}

pub(crate) fn handle_menu_event(app: &AppHandle, event: MenuEvent) {
    if event.id() == "change-server" {
        if let Err(e) = store::clear_config(&app_data_dir(app)) {
            eprintln!("[lifer] couldn't clear the saved config: {e}");
        }
        if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
            navigate_or_picker(
                &window,
                &crate::security::bundled_page_url(window.app_handle(), PICKER_PAGE),
            );
            // Off the UI thread: stopping can take up to 10 s.
            let app = app.clone();
            tauri::async_runtime::spawn(async move { api::stop_api_async(&app).await });
        }
    } else if event.id() == "use-local" {
        if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = switch_to_local_library(&app, &window).await {
                    app.dialog()
                        .message(e)
                        .kind(tauri_plugin_dialog::MessageDialogKind::Error)
                        .show(|_| {});
                }
            });
        }
    } else if event.id() == "delete-selected" {
        let _ = app.emit("menu:delete-selected", ());
    } else if event.id() == "search" {
        let _ = app.emit("menu:search", ());
    } else if event.id() == "toggle-sidebar" {
        let _ = app.emit("menu:toggle-sidebar", ());
    } else if let Some((.., path)) = NAV_ITEMS.iter().find(|(id, ..)| event.id() == *id) {
        let _ = app.emit("menu:navigate", *path);
    }
}
