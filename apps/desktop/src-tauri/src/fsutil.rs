// Crash-safe file writes shared by the config, the offline cache and the database upgrade.
use std::fs;
use std::io::Write;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

/// Writes `contents` to a temp file beside `path`, fsyncs it, renames it over `path`, then
/// fsyncs the folder, so a crash or power loss leaves either the old file or the new one.
/// `mode` (Unix only, e.g. 0o600 for secrets) applies from creation, so the file is never
/// briefly readable by others.
pub fn write_atomic(path: &Path, contents: &[u8], mode: Option<u32>) -> std::io::Result<()> {
    write_via_temp(path, contents, true, mode)
}

fn write_via_temp(
    path: &Path,
    contents: &[u8],
    durable: bool,
    mode: Option<u32>,
) -> std::io::Result<()> {
    // Unique per write, so two threads saving the same file never share a temp file.
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let dir = path
        .parent()
        .ok_or_else(|| std::io::Error::other("path has no parent folder"))?;
    fs::create_dir_all(dir)?;
    let tmp = dir.join(format!(
        ".{}.{}.{}.tmp",
        path.file_name().unwrap_or_default().to_string_lossy(),
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    let result = (|| {
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        if let Some(mode) = mode {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(mode);
        }
        #[cfg(not(unix))]
        let _ = mode;
        let mut file = options.open(&tmp)?;
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
        write_atomic(&path, b"one", None).unwrap();
        write_atomic(&path, b"two", None).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"two");
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

    #[cfg(unix)]
    #[test]
    fn write_atomic_applies_the_mode() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("lifer-fsutil-mode-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let path = dir.join("secret");
        write_atomic(&path, b"s3cret", Some(0o600)).unwrap();
        let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        assert_eq!(fs::read(&path).unwrap(), b"s3cret");
        let _ = fs::remove_dir_all(&dir);
    }
}
