//! Files Lifer can always download again (the matching models, the GPU runtime and the record of
//! which accelerator was chosen) live in the OS cache folder (~/Library/Caches on macOS), where
//! storage tools may clear them. The server finds them through LIFER_CACHE_DIR
//! (packages/core/src/config.ts) and downloads anything missing again.

use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

/// What moves out of app data. Everything here downloads again when it's missing.
const CACHED: [&str; 3] = ["models", "gpu-runtime", "acceleration.json"];

/// The cache folder, with anything earlier versions kept in app data moved into it first.
pub fn prepare(app: &AppHandle) -> Result<PathBuf, String> {
    let paths = app.path();
    let cache = paths
        .app_cache_dir()
        .map_err(|e| format!("Couldn't resolve the cache folder: {e}"))?;
    let app_data = paths
        .app_data_dir()
        .map_err(|e| format!("Couldn't resolve app data dir: {e}"))?
        .join("app-data");
    move_from_app_data(&app_data, &cache);
    Ok(cache)
}

/// Moves each cached file or folder from `app_data` into `cache`, once. One that can't be renamed
/// (another drive), or that the cache already has, is deleted instead of copied: it downloads
/// again, and two copies would only waste space.
pub fn move_from_app_data(app_data: &Path, cache: &Path) {
    for name in CACHED {
        let old = app_data.join(name);
        if !old.exists() {
            continue;
        }
        let new = cache.join(name);
        let moved = !new.exists()
            && std::fs::create_dir_all(cache).is_ok()
            && std::fs::rename(&old, &new).is_ok();
        if !moved {
            let removed = if old.is_dir() {
                std::fs::remove_dir_all(&old)
            } else {
                std::fs::remove_file(&old)
            };
            if let Err(e) = removed {
                eprintln!("[model_cache] couldn't remove {}: {e}", old.display());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("lifer-model-cache-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn moves_models_runtime_and_record_into_the_cache_once() {
        let root = temp("move");
        let app_data = root.join("app-data");
        let cache = root.join("cache");
        std::fs::create_dir_all(app_data.join("models")).unwrap();
        std::fs::write(app_data.join("models").join("bioclip.onnx"), b"model").unwrap();
        std::fs::write(app_data.join("acceleration.json"), b"{}").unwrap();
        std::fs::write(app_data.join("lifer.db-password"), b"secret").unwrap();

        move_from_app_data(&app_data, &cache);

        assert_eq!(
            std::fs::read(cache.join("models").join("bioclip.onnx")).unwrap(),
            b"model"
        );
        assert!(cache.join("acceleration.json").exists());
        assert!(!app_data.join("models").exists());
        // Only the re-downloadable files move.
        assert!(app_data.join("lifer.db-password").exists());
        // A second run has nothing left to do.
        move_from_app_data(&app_data, &cache);
        assert!(cache.join("models").join("bioclip.onnx").exists());
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn drops_the_app_data_copy_when_the_cache_already_has_one() {
        let root = temp("both");
        let app_data = root.join("app-data");
        let cache = root.join("cache");
        std::fs::create_dir_all(app_data.join("models")).unwrap();
        std::fs::write(app_data.join("models").join("old.onnx"), b"old").unwrap();
        std::fs::create_dir_all(cache.join("models")).unwrap();
        std::fs::write(cache.join("models").join("new.onnx"), b"new").unwrap();

        move_from_app_data(&app_data, &cache);

        assert!(!app_data.join("models").exists());
        assert!(cache.join("models").join("new.onnx").exists());
        assert!(!cache.join("models").join("old.onnx").exists());
        std::fs::remove_dir_all(&root).unwrap();
    }
}
