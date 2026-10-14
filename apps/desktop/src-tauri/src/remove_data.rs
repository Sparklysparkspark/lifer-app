//! Settings > Remove all Lifer data: deletes everything Lifer keeps on this computer (its database,
//! thumbnails, downloads, settings, logs and caches) and quits, so dragging the app to the Trash
//! then leaves nothing behind. Photo libraries are never deleted, including the default one, which
//! lives inside the app data folder.

use std::path::{Component, Path, PathBuf};
use tauri::{AppHandle, Manager, WebviewWindow};

use crate::security::is_local_api;
use crate::{api, local_inference, store};

const NOT_ALLOWED: &str = "Not allowed from this page.";
const WEBVIEW_DIR: &str = "EBWebView";

/// A path with `.` and `..` resolved, through the real path when it exists, so a symlinked or
/// relative spelling of a library folder still counts as inside the folder it's in.
fn normalized(path: &Path) -> PathBuf {
    if let Ok(real) = std::fs::canonicalize(path) {
        return real;
    }
    let mut out = PathBuf::new();
    for part in path.components() {
        match part {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other),
        }
    }
    out
}

/// What to delete so that every `root` goes, except the `keep` folders and what's in them: a root
/// with nothing to keep inside goes whole; otherwise each of its entries is handled the same way.
pub(crate) fn plan(roots: &[PathBuf], keep: &[PathBuf]) -> Vec<PathBuf> {
    let keep: Vec<PathBuf> = keep.iter().map(|k| normalized(k)).collect();
    let mut out = Vec::new();
    let mut seen = Vec::new();
    for root in roots {
        let root = normalized(root);
        if !root.exists() || seen.iter().any(|s: &PathBuf| root.starts_with(s)) {
            continue;
        }
        seen.push(root.clone());
        collect(&root, &keep, &mut out);
    }
    out
}

fn collect(path: &Path, keep: &[PathBuf], out: &mut Vec<PathBuf>) {
    // A kept folder, or one inside a kept folder: leave it alone.
    if keep.iter().any(|k| path.starts_with(k)) {
        return;
    }
    // Nothing to keep inside: it goes whole.
    if !keep.iter().any(|k| k.starts_with(path)) || !path.is_dir() {
        out.push(path.to_path_buf());
        return;
    }
    if let Ok(entries) = std::fs::read_dir(path) {
        for entry in entries.flatten() {
            collect(&entry.path(), keep, out);
        }
    }
}

/// Only the app's own pages (the bundled tauri:// ones and the local library's), never a connected
/// server's: a server, or anyone on its network, must not be able to wipe someone's data.
fn is_own_page(window: &WebviewWindow) -> bool {
    window
        .url()
        .is_ok_and(|url| url.scheme() == "tauri" || is_local_api(&url))
}

/// The `dataDir` in ~/.lifer/settings.json, if the file has one.
fn settings_data_dir(path: &Path) -> Option<PathBuf> {
    let text = std::fs::read_to_string(path).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    value
        .get("dataDir")?
        .as_str()
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
}

#[tauri::command]
pub(crate) async fn remove_all_data(window: WebviewWindow, app: AppHandle) -> Result<(), String> {
    if !is_own_page(&window) {
        return Err(NOT_ALLOWED.into());
    }
    let paths = app.path();
    let resolve =
        |r: tauri::Result<PathBuf>| r.map_err(|e| format!("Couldn't resolve a folder: {e}"));
    let app_data = resolve(paths.app_data_dir())?;
    let mut roots = vec![
        app_data.clone(),
        resolve(paths.app_local_data_dir())?,
        resolve(paths.app_cache_dir())?,
        resolve(paths.app_log_dir())?,
    ];
    let home = paths.home_dir().ok();
    // WKWebView keeps the window's own storage here, named after the bundle identifier.
    if let (Some(home), true) = (&home, cfg!(target_os = "macos")) {
        roots.push(
            home.join("Library")
                .join("WebKit")
                .join(&app.config().identifier),
        );
    }

    // Photo libraries stay: the default one (inside app data) and any the user chose.
    let mut keep = vec![app_data.join("data")];
    if let Some(cfg) = store::read_config(&app_data) {
        keep.extend(cfg.data_dir.into_iter().map(PathBuf::from));
        keep.extend(cfg.last_local_data_dir.into_iter().map(PathBuf::from));
    }
    // The server also reads a library folder from ~/.lifer/settings.json when nothing else sets one.
    if let Some(home) = &home {
        keep.extend(settings_data_dir(
            &home.join(".lifer").join("settings.json"),
        ));
    }
    let doomed = plan(&roots, &keep);

    // Nothing may hold these files open: the local server, its database and local matching.
    api::stop_api_async(&app).await;
    local_inference::stop(&app);

    let mut failed = Vec::new();
    for path in doomed {
        remove(&path, &mut failed);
    }
    if let Some(home) = home {
        // Only the settings file: ~/.lifer is also the recovery folder of a library kept in the
        // home folder itself.
        let dot_lifer = home.join(".lifer");
        let _ = std::fs::remove_file(dot_lifer.join("settings.json"));
        let _ = std::fs::remove_dir(&dot_lifer);
        // The database engine versions before 0.10 downloaded.
        let _ = std::fs::remove_dir_all(home.join(".theseus").join("postgresql"));
    }
    // WebView2 locks its EBWebView folder while the window is open; it holds nothing of the user's.
    let left: Vec<String> = failed
        .iter()
        .filter(|p| p.file_name().is_none_or(|n| n != WEBVIEW_DIR))
        .map(|p| p.display().to_string())
        .collect();
    if !left.is_empty() {
        return Err(format!(
            "Lifer couldn't remove everything. Quit Lifer, then delete these yourself: {}",
            left.join(", ")
        ));
    }
    app.exit(0);
    Ok(())
}

/// Deletes `path`, a folder entry by entry so one that can't go doesn't stop its siblings, and
/// adds what couldn't be deleted to `failed`.
fn remove(path: &Path, failed: &mut Vec<PathBuf>) {
    let entries = match std::fs::read_dir(path) {
        Ok(entries) if !path.is_symlink() => entries,
        _ => return remove_one(path, failed),
    };
    let before = failed.len();
    for entry in entries.flatten() {
        remove_one(&entry.path(), failed);
    }
    // A folder still holding something that failed is already reported through that entry.
    if failed.len() == before {
        if let Err(e) = std::fs::remove_dir(path) {
            eprintln!("[remove_data] couldn't remove {}: {e}", path.display());
            failed.push(path.to_path_buf());
        }
    }
}

fn remove_one(path: &Path, failed: &mut Vec<PathBuf>) {
    let removed = if path.is_dir() {
        std::fs::remove_dir_all(path)
    } else {
        std::fs::remove_file(path)
    };
    if let Err(e) = removed {
        eprintln!("[remove_data] couldn't remove {}: {e}", path.display());
        failed.push(path.to_path_buf());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("lifer-remove-data-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn touch(path: &Path) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, b"x").unwrap();
    }

    #[test]
    fn deletes_everything_but_the_default_library_inside_app_data() {
        let root = temp("default");
        let app_data = root.join("app.lifer.desktop");
        touch(
            &app_data
                .join("app-data")
                .join("postgres-data")
                .join("PG_VERSION"),
        );
        touch(&app_data.join("desktop-config.json"));
        touch(&app_data.join("data").join("Birds").join("heron.jpg"));

        let mut doomed = plan(std::slice::from_ref(&app_data), &[app_data.join("data")]);
        doomed.sort();
        let app_data = normalized(&app_data);
        assert_eq!(
            doomed,
            vec![
                app_data.join("app-data"),
                app_data.join("desktop-config.json")
            ]
        );
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn keeps_a_chosen_library_nested_deeper_inside_a_deleted_folder() {
        let root = temp("nested");
        let cache = root.join("cache");
        touch(&cache.join("models").join("bioclip.onnx"));
        touch(&cache.join("odd").join("place").join("photos").join("a.jpg"));
        touch(&cache.join("odd").join("other.txt"));

        let mut doomed = plan(
            std::slice::from_ref(&cache),
            &[cache.join("odd").join("place").join("photos")],
        );
        doomed.sort();
        let cache = normalized(&cache);
        assert_eq!(
            doomed,
            vec![cache.join("models"), cache.join("odd").join("other.txt")]
        );
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn a_library_outside_every_root_leaves_the_roots_whole_and_missing_roots_are_skipped() {
        let root = temp("outside");
        let app_data = root.join("app-data");
        touch(&app_data.join("desktop-config.json"));
        let library = root.join("Pictures").join("Wildlife");
        touch(&library.join("a.jpg"));

        let doomed = plan(
            &[app_data.clone(), root.join("never-created")],
            std::slice::from_ref(&library),
        );
        assert_eq!(doomed, vec![normalized(&app_data)]);
        assert!(library.join("a.jpg").exists());
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn a_library_that_is_the_root_itself_keeps_the_whole_root() {
        let root = temp("same");
        touch(&root.join("a.jpg"));
        assert!(plan(std::slice::from_ref(&root), std::slice::from_ref(&root)).is_empty());
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn an_entry_that_cant_be_deleted_doesnt_stop_its_siblings() {
        use std::os::unix::fs::PermissionsExt;
        let root = temp("locked");
        let dir = root.join("cache");
        touch(&dir.join("EBWebView").join("lock"));
        touch(&dir.join("models").join("bioclip.onnx"));
        touch(&dir.join("gpu-runtime").join("lib.so"));
        let locked = dir.join("EBWebView");
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o500)).unwrap();

        let mut failed = Vec::new();
        remove(&dir, &mut failed);
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o700)).unwrap();
        assert_eq!(failed, vec![locked.clone()]);
        assert!(!dir.join("models").exists() && !dir.join("gpu-runtime").exists());
        assert!(locked.exists());

        // Once nothing is held, the emptied folder goes too.
        let mut failed = Vec::new();
        remove(&dir, &mut failed);
        assert!(failed.is_empty() && !dir.exists());
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn reads_the_library_folder_from_the_settings_file() {
        let root = temp("settings");
        let settings = root.join("settings.json");
        assert_eq!(settings_data_dir(&settings), None);
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(
            &settings,
            r#"{"dataDir":"/Volumes/Photos/Lifer","other":1}"#,
        )
        .unwrap();
        assert_eq!(
            settings_data_dir(&settings),
            Some(PathBuf::from("/Volumes/Photos/Lifer"))
        );
        std::fs::write(&settings, r#"{"dataDir":""}"#).unwrap();
        assert_eq!(settings_data_dir(&settings), None);
        std::fs::write(&settings, "not json").unwrap();
        assert_eq!(settings_data_dir(&settings), None);
        std::fs::remove_dir_all(&root).unwrap();
    }
}
