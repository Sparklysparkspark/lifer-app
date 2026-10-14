// The app menu: the standard macOS items plus switching library or server.
use tauri::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_dialog::DialogExt;

use crate::commands::switch_to_local_library;
use crate::{api, app_data_dir, navigate_or_picker, store, PICKER_URL, WINDOW_LABEL};

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
    let window_menu = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;
    Menu::with_items(app, &[&lifer_menu, &edit_menu, &window_menu])
}

pub(crate) fn handle_menu_event(app: &AppHandle, event: MenuEvent) {
    if event.id() == "change-server" {
        if let Err(e) = store::clear_config(&app_data_dir(app)) {
            eprintln!("[lifer] couldn't clear the saved config: {e}");
        }
        if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
            api::stop_api(app);
            navigate_or_picker(&window, PICKER_URL);
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
    }
}
