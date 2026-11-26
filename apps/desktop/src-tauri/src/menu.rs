// The app menu: the standard macOS items plus switching library or server, and the menus of the
// embedded app whose page is on screen (set_plugin_menu).
use serde::Deserialize;
use tauri::menu::{CheckMenuItem, Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};
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

// Every chord Lifer's own menu binds, the predefined items' included. A plugin item never takes one.
const LIFER_ACCELERATORS: [&str; 17] = [
    "CmdOrCtrl+Backspace",
    "CmdOrCtrl+F",
    "Ctrl+Cmd+S",
    "Ctrl+Alt+S",
    "CmdOrCtrl+Z",
    "CmdOrCtrl+Shift+Z",
    "Ctrl+Y",
    "CmdOrCtrl+X",
    "CmdOrCtrl+C",
    "CmdOrCtrl+V",
    "CmdOrCtrl+A",
    "CmdOrCtrl+H",
    "Alt+CmdOrCtrl+H",
    "CmdOrCtrl+Q",
    "CmdOrCtrl+M",
    "CmdOrCtrl+W",
    "Ctrl+Cmd+F",
];

/// An embedded app's menus, already checked by the web app (packages/shared pluginProtocol.ts).
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct PluginMenu {
    pub title: String,
    pub menus: Vec<PluginTopMenu>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct PluginTopMenu {
    pub label: String,
    pub items: Vec<PluginEntry>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub(crate) enum PluginEntry {
    Separator,
    Item {
        id: String,
        label: String,
        enabled: bool,
        accelerator: Option<String>,
        checked: Option<bool>,
    },
    Submenu {
        label: String,
        enabled: bool,
        items: Vec<PluginEntry>,
    },
}

const PLUGIN_ID_PREFIX: &str = "plugin:";

// "CmdOrCtrl+Shift+e" and "Shift+Cmd+E" on a Mac are the same chord; None when it doesn't parse.
fn chord(accel: &str, mac: bool) -> Option<(Vec<&'static str>, String)> {
    let (mods, key) = match accel.strip_suffix("++") {
        Some(rest) => (rest, "+"),
        None => accel.rsplit_once('+').unwrap_or(("", accel)),
    };
    let mut set = Vec::new();
    for m in mods.split('+').filter(|m| !m.is_empty()) {
        set.push(match m.trim().to_ascii_lowercase().as_str() {
            "cmdorctrl" | "cmdorcontrol" | "commandorctrl" | "commandorcontrol" => {
                if mac {
                    "meta"
                } else {
                    "ctrl"
                }
            }
            "cmd" | "command" | "super" | "meta" => "meta",
            "ctrl" | "control" => "ctrl",
            "alt" | "option" => "alt",
            "shift" => "shift",
            _ => return None,
        });
    }
    set.sort_unstable();
    set.dedup();
    let key = key.trim().to_ascii_lowercase();
    let key = key
        .strip_prefix("key")
        .or_else(|| key.strip_prefix("digit"))
        .filter(|k| k.len() == 1)
        .map(str::to_string)
        .unwrap_or(key);
    (!key.is_empty()).then_some((set, key))
}

fn lifers_accelerator(accel: &str, mac: bool) -> bool {
    let Some(wanted) = chord(accel, mac) else {
        return true;
    };
    NAV_ITEMS
        .iter()
        .map(|(_, _, a, _)| *a)
        .chain(LIFER_ACCELERATORS)
        .any(|a| chord(a, mac).as_ref() == Some(&wanted))
}

/// Prefixes item ids with `plugin:` and drops accelerators Lifer binds. Off macOS it drops them
/// all: there the window's menu bar could fire a chord the page already handled, so the app's
/// own page handles its keys and the menu only lists the items.
pub(crate) fn prepare_plugin_menu(menu: &mut PluginMenu, mac: bool) {
    fn walk(items: &mut [PluginEntry], mac: bool) {
        for entry in items {
            match entry {
                PluginEntry::Item {
                    id, accelerator, ..
                } => {
                    *id = format!("{PLUGIN_ID_PREFIX}{id}");
                    if !mac
                        || accelerator
                            .as_deref()
                            .is_some_and(|a| lifers_accelerator(a, mac))
                    {
                        *accelerator = None;
                    }
                }
                PluginEntry::Submenu { items, .. } => walk(items, mac),
                PluginEntry::Separator => {}
            }
        }
    }
    for top in &mut menu.menus {
        walk(&mut top.items, mac);
    }
}

fn append_plugin_entries(
    app: &AppHandle,
    parent: &Submenu<tauri::Wry>,
    items: &[PluginEntry],
) -> tauri::Result<()> {
    for entry in items {
        match entry {
            PluginEntry::Separator => parent.append(&PredefinedMenuItem::separator(app)?)?,
            PluginEntry::Item {
                id,
                label,
                enabled,
                accelerator,
                checked: Some(checked),
            } => parent.append(&CheckMenuItem::with_id(
                app,
                id,
                label,
                *enabled,
                *checked,
                accelerator.as_deref(),
            )?)?,
            PluginEntry::Item {
                id,
                label,
                enabled,
                accelerator,
                checked: None,
            } => parent.append(&MenuItem::with_id(
                app,
                id,
                label,
                *enabled,
                accelerator.as_deref(),
            )?)?,
            PluginEntry::Submenu {
                label,
                enabled,
                items,
            } => {
                let sub = Submenu::new(app, label, *enabled)?;
                append_plugin_entries(app, &sub, items)?;
                parent.append(&sub)?;
            }
        }
    }
    Ok(())
}

/// Shows an embedded app's menus between Go and Window while its page is on screen, or removes
/// them (None). Only Lifer's own page in the main window may call it.
#[tauri::command]
pub(crate) fn set_plugin_menu(
    window: WebviewWindow,
    menu: Option<PluginMenu>,
) -> Result<(), String> {
    if window.label() != WINDOW_LABEL || !crate::security::is_app_page(&window) {
        return Err("not allowed".into());
    }
    let mut menu = menu.filter(|m| !m.menus.is_empty());
    if let Some(m) = menu.as_mut() {
        prepare_plugin_menu(m, cfg!(target_os = "macos"));
    }
    let app = window.app_handle().clone();
    window
        .app_handle()
        .run_on_main_thread(move || match build_menu(&app, menu.as_ref()) {
            Ok(bar) => {
                if let Err(e) = app.set_menu(bar) {
                    eprintln!("[lifer] couldn't set the menu bar: {e}");
                }
            }
            Err(e) => eprintln!("[lifer] couldn't build the app's menus: {e}"),
        })
        .map_err(|e| e.to_string())
}

pub(crate) fn build_menu(
    app: &AppHandle,
    plugin: Option<&PluginMenu>,
) -> tauri::Result<Menu<tauri::Wry>> {
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
    let bar = Menu::with_items(
        app,
        &[
            &lifer_menu,
            &file_menu,
            &edit_menu,
            &view_menu,
            &go_menu,
            &window_menu,
        ],
    )?;
    if let Some(plugin) = plugin {
        let slot = Submenu::new(app, &plugin.title, true)?;
        for top in &plugin.menus {
            let sub = Submenu::new(app, &top.label, true)?;
            append_plugin_entries(app, &sub, &top.items)?;
            slot.append(&sub)?;
        }
        // Before Window, the last menu.
        bar.insert(&slot, 5)?;
    }
    Ok(bar)
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
    } else if let Some(id) = event.id().as_ref().strip_prefix(PLUGIN_ID_PREFIX) {
        // Only back to the web app, which posts it to the app's own frame; never one of Lifer's ids.
        let _ = app.emit("menu:plugin", id);
    } else if let Some((.., path)) = NAV_ITEMS.iter().find(|(id, ..)| event.id() == *id) {
        let _ = app.emit("menu:navigate", *path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> PluginMenu {
        serde_json::from_value(serde_json::json!({
            "title": "Example",
            "menus": [{
                "label": "Edit",
                "items": [
                    { "kind": "item", "id": "undo", "label": "Undo", "enabled": true, "accelerator": "CmdOrCtrl+Z", "checked": null },
                    { "kind": "item", "id": "export", "label": "Export", "enabled": true, "accelerator": "CmdOrCtrl+Shift+E", "checked": null },
                    { "kind": "separator" },
                    { "kind": "submenu", "label": "Rating", "enabled": true, "items": [
                        { "kind": "item", "id": "rate-1", "label": "One", "enabled": false, "accelerator": "command+a", "checked": true },
                        { "kind": "item", "id": "zoom", "label": "Zoom", "enabled": true, "accelerator": "CmdOrCtrl+=", "checked": false },
                        { "kind": "item", "id": "bad", "label": "Bad", "enabled": true, "accelerator": "Hyper+Q", "checked": null }
                    ]}
                ]
            }]
        }))
        .expect("the web app's shape")
    }

    fn items(menu: &PluginMenu) -> Vec<(String, Option<String>)> {
        fn walk(entries: &[PluginEntry], out: &mut Vec<(String, Option<String>)>) {
            for e in entries {
                match e {
                    PluginEntry::Item {
                        id, accelerator, ..
                    } => out.push((id.clone(), accelerator.clone())),
                    PluginEntry::Submenu { items, .. } => walk(items, out),
                    PluginEntry::Separator => {}
                }
            }
        }
        let mut out = Vec::new();
        for top in &menu.menus {
            walk(&top.items, &mut out);
        }
        out
    }

    #[test]
    fn deserializes_every_entry_kind() {
        let menu = sample();
        assert_eq!(menu.title, "Example");
        assert!(matches!(menu.menus[0].items[2], PluginEntry::Separator));
        assert!(matches!(
            &menu.menus[0].items[3],
            PluginEntry::Submenu { items, .. } if items.len() == 3
        ));
    }

    #[test]
    fn prefixes_ids_and_drops_lifers_accelerators_on_macos() {
        let mut menu = sample();
        prepare_plugin_menu(&mut menu, true);
        let some = |s: &str| Some(s.to_string());
        assert_eq!(
            items(&menu),
            vec![
                // Lifer's Edit menu has Undo; the item stays, its chord goes.
                ("plugin:undo".into(), None),
                ("plugin:export".into(), some("CmdOrCtrl+Shift+E")),
                // Select All, written another way.
                ("plugin:rate-1".into(), None),
                ("plugin:zoom".into(), some("CmdOrCtrl+=")),
                // Doesn't parse: no chord.
                ("plugin:bad".into(), None),
            ]
        );
    }

    #[test]
    fn registers_no_accelerators_off_macos() {
        let mut menu = sample();
        prepare_plugin_menu(&mut menu, false);
        let all = items(&menu);
        assert!(all
            .iter()
            .all(|(id, a)| id.starts_with("plugin:") && a.is_none()));
    }

    #[test]
    fn compares_chords_normalised() {
        assert!(lifers_accelerator("Cmd+F", true));
        assert!(lifers_accelerator("shift+cmdorctrl+z", true));
        assert!(lifers_accelerator("CmdOrCtrl+Digit1", true));
        assert!(lifers_accelerator("Command+,", true));
        assert!(lifers_accelerator("Ctrl+Y", true));
        assert!(!lifers_accelerator("CmdOrCtrl+O", true));
        assert!(!lifers_accelerator("CmdOrCtrl+Alt+Shift+E", true));
        // Ctrl+F is Lifer's Find off macOS, but a free chord on a Mac.
        assert!(lifers_accelerator("Ctrl+F", false));
        assert!(!lifers_accelerator("Ctrl+F", true));
    }

    #[test]
    fn plugin_ids_never_reach_lifers_own_handlers() {
        // Every id Lifer handles lacks the prefix, so a plugin item can't be one of them.
        for (id, ..) in NAV_ITEMS {
            assert!(!id.starts_with(PLUGIN_ID_PREFIX));
        }
        let mut menu = sample();
        menu.menus[0].items[0] = PluginEntry::Item {
            id: "nav-settings".into(),
            label: "Settings".into(),
            enabled: true,
            accelerator: None,
            checked: None,
        };
        prepare_plugin_menu(&mut menu, true);
        assert_eq!(items(&menu)[0].0, "plugin:nav-settings");
    }
}
