// Crash-safe file writes shared by the config, the offline cache and the database upgrade.
use std::fs;
use std::io::Write;
use std::path::Path;

/// Writes `contents` to a temp file beside `path`, fsyncs it, renames it over `path`, then
/// fsyncs the folder, so a crash or power loss leaves either the old file or the new one.
pub fn write_atomic(path: &Path, contents: &[u8]) -> std::io::Result<()> {
    write_via_temp(path, contents, true)
}

/// Like `write_atomic` without the fsyncs: a crash can lose the write, but never leaves a torn
/// file. For re-syncable caches written in bulk, where a disk flush per file is too slow.
pub fn write_replace(path: &Path, contents: &[u8]) -> std::io::Result<()> {
    write_via_temp(path, contents, false)
}

fn write_via_temp(path: &Path, contents: &[u8], durable: bool) -> std::io::Result<()> {
    let dir = path
        .parent()
        .ok_or_else(|| std::io::Error::other("path has no parent folder"))?;
    fs::create_dir_all(dir)?;
    let tmp = dir.join(format!(
        ".{}.{}.tmp",
        path.file_name().unwrap_or_default().to_string_lossy(),
        std::process::id()
    ));
    let result = (|| {
        let mut file = fs::File::create(&tmp)?;
        file.write_all(contents)?;
        if durable {
            file.sync_all()?;
        }
        drop(file);
        fs::rename(&tmp, path)?;
        if durable {
            fsync_dir(dir);
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

/// Renames `from` to `to` and persists the rename in both parent folders.
pub fn rename_durable(from: &Path, to: &Path) -> std::io::Result<()> {
    fs::rename(from, to)?;
    if let Some(dir) = to.parent() {
        fsync_dir(dir);
    }
    if let Some(dir) = from.parent().filter(|d| Some(*d) != to.parent()) {
        fsync_dir(dir);
    }
    Ok(())
}

/// Persists renames and creations inside `dir`. Best effort: a folder can't be fsynced on
/// Windows, and a failure here doesn't undo the rename itself.
pub fn fsync_dir(dir: &Path) {
    #[cfg(unix)]
    if let Ok(handle) = fs::File::open(dir) {
        let _ = handle.sync_all();
    }
    #[cfg(not(unix))]
    let _ = dir;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn write_atomic_replaces_the_file_and_leaves_no_temp_file() {
        let dir = std::env::temp_dir().join(format!("lifer-fsutil-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let path = dir.join("nested").join("file.json");
        write_atomic(&path, b"one").unwrap();
        write_atomic(&path, b"two").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"two");
        write_replace(&path, b"three").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"three");
        let entries: Vec<_> = fs::read_dir(path.parent().unwrap())
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(entries, vec![std::ffi::OsString::from("file.json")]);
        let moved = dir.join("moved.json");
        rename_durable(&path, &moved).unwrap();
        assert!(!path.exists() && moved.exists());
        let _ = fs::remove_dir_all(&dir);
    }
}
