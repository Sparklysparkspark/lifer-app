// Reveal in the file manager for a connected server's files. The server's library folder is often
// a NAS share that's also mounted on this computer (under /Volumes on a Mac, /media or /run/media
// on Linux, a drive letter or the same UNC path on Windows), at a different path; it's found by
// looking for a file the server knows is there, with the same size. Those sample files come from
// the server itself (GET /originals/reveal-samples with the app's link key), never from the page,
// so a page can only ask about the server's own library folders.
use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

use serde::Deserialize;
use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;

use crate::{app_data_dir, server_link};

// A share's root and up to three folders inside it.
const MAX_DEPTH: usize = 4;
// Keeps a search over a very large share to a few seconds.
const MAX_DIRS: usize = 2000;

/// Where shares show up on this computer. On a Mac and Linux each folder in `dirs` holds mounted
/// shares; on Windows each entry is a drive root that can be a share itself.
pub(crate) struct Mounts {
    dirs: Vec<PathBuf>,
    dirs_are_shares: bool,
}

impl Mounts {
    pub(crate) fn current() -> Self {
        #[cfg(target_os = "macos")]
        let (dirs, dirs_are_shares) = (vec![PathBuf::from("/Volumes")], false);
        #[cfg(target_os = "linux")]
        let (dirs, dirs_are_shares) = {
            let user = std::env::var("USER").unwrap_or_default();
            let mut dirs = Vec::new();
            for base in ["/media", "/run/media"] {
                if !user.is_empty() {
                    dirs.push(Path::new(base).join(&user));
                }
            }
            dirs.push(PathBuf::from("/mnt"));
            dirs.push(PathBuf::from("/media"));
            (dirs, false)
        };
        // C: is the system drive, never a NAS.
        #[cfg(windows)]
        let (dirs, dirs_are_shares) = (
            ('D'..='Z')
                .map(|l| PathBuf::from(format!("{l}:\\")))
                .filter(|p| p.exists())
                .collect(),
            true,
        );
        #[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
        let (dirs, dirs_are_shares) = (Vec::new(), false);
        Self {
            dirs,
            dirs_are_shares,
        }
    }

    /// The folder that holds `sample` at `size` bytes, nearest the top first.
    pub(crate) fn find(&self, sample: &Path, size: u64) -> Option<PathBuf> {
        self.dirs.iter().find_map(|dir| {
            (self.dirs_are_shares && holds(dir, sample, size))
                .then(|| dir.clone())
                .or_else(|| find_prefix(dir, sample, size))
        })
    }
}

// Server library folder -> where it's mounted here.
static FOUND: Mutex<Option<HashMap<String, PathBuf>>> = Mutex::new(None);
// The server's library folders, each with a file known to be there, as it last listed them.
static SAMPLES: Mutex<Option<Vec<Sample>>> = Mutex::new(None);

#[derive(Debug, Clone, Deserialize)]
struct Sample {
    root: String,
    #[serde(rename = "relativePath")]
    relative_path: String,
    size: u64,
}

#[derive(Deserialize)]
struct SamplesBody {
    roots: Vec<Sample>,
}

// Only plain relative paths, so a page can't point outside the mounted folder.
fn relative(path: &str) -> Option<PathBuf> {
    let p = Path::new(path);
    let plain = !path.is_empty() && p.components().all(|c| matches!(c, Component::Normal(_)));
    plain.then(|| p.to_path_buf())
}

fn holds(prefix: &Path, sample: &Path, size: u64) -> bool {
    std::fs::metadata(prefix.join(sample)).is_ok_and(|m| m.is_file() && m.len() == size)
}

/// The folder under `volumes` that holds `sample` at `size` bytes, nearest the top first.
pub(crate) fn find_prefix(volumes: &Path, sample: &Path, size: u64) -> Option<PathBuf> {
    let mut level = vec![volumes.to_path_buf()];
    let mut visited = 0;
    for depth in 1..=MAX_DEPTH {
        let mut next = Vec::new();
        for dir in &level {
            let Ok(entries) = std::fs::read_dir(dir) else {
                continue;
            };
            for entry in entries.flatten() {
                // file_type doesn't follow links, so "Macintosh HD" (a link to /) is skipped.
                let is_dir = entry.file_type().is_ok_and(|t| t.is_dir());
                if !is_dir || entry.file_name().to_string_lossy().starts_with('.') {
                    continue;
                }
                let path = entry.path();
                if holds(&path, sample, size) {
                    return Some(path);
                }
                visited += 1;
                if visited >= MAX_DIRS {
                    return None;
                }
                if depth < MAX_DEPTH {
                    next.push(path);
                }
            }
        }
        level = next;
    }
    None
}

// The cached folder while it still holds the sample, else a fresh search (the share may have
// been remounted elsewhere).
fn mapped(server_root: &str, sample: &Path, size: u64, mounts: &Mounts) -> Option<PathBuf> {
    let cached = FOUND
        .lock()
        .ok()
        .and_then(|m| m.as_ref()?.get(server_root).cloned());
    if let Some(prefix) = cached.filter(|p| holds(p, sample, size)) {
        return Some(prefix);
    }
    // The server's own path first: a UNC path, or a share mounted at the same path here.
    let found = Some(PathBuf::from(server_root))
        .filter(|p| holds(p, sample, size))
        .or_else(|| mounts.find(sample, size));
    if let Ok(mut guard) = FOUND.lock() {
        let map = guard.get_or_insert_with(HashMap::new);
        match &found {
            Some(prefix) => map.insert(server_root.to_string(), prefix.clone()),
            None => map.remove(server_root),
        };
    }
    found
}

/// The sample the server named for `server_root`; nothing for a folder it didn't name.
fn sample_for(samples: &[Sample], server_root: &str) -> Option<(PathBuf, u64)> {
    let s = samples.iter().find(|s| s.root == server_root)?;
    Some((relative(&s.relative_path)?, s.size))
}

async fn fetch_samples(app: &AppHandle) -> Option<Vec<Sample>> {
    let link = server_link::read(&app_data_dir(app))?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        // The key goes only to the server's own addresses, never on to a redirect.
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .ok()?;
    for url in &link.urls {
        let Some(base) = server_link::trusted_base(&link, url).await else {
            continue;
        };
        let Ok(res) = client
            .get(format!("{base}/api/originals/reveal-samples"))
            .header("x-api-key", &link.token)
            .send()
            .await
        else {
            continue;
        };
        if let Ok(body) = res.error_for_status().map(|r| r.json::<SamplesBody>()) {
            if let Ok(body) = body.await {
                return Some(body.roots);
            }
        }
    }
    None
}

/// The server's sample for `server_root`, from the last listing unless `fresh` (a reveal that
/// missed, or a folder not listed yet), which asks the server again.
async fn sample(app: &AppHandle, server_root: &str, fresh: bool) -> Option<(PathBuf, u64)> {
    if !fresh {
        let cached = SAMPLES
            .lock()
            .ok()
            .and_then(|s| s.as_ref().and_then(|s| sample_for(s, server_root)));
        if cached.is_some() {
            return cached;
        }
    }
    let samples = fetch_samples(app).await?;
    let found = sample_for(&samples, server_root);
    if let Ok(mut guard) = SAMPLES.lock() {
        *guard = Some(samples);
    }
    found
}

/// Where `server_root` is mounted here. A miss asks the server for a fresh sample once (the
/// sample file may have been moved or replaced) before giving up.
async fn local_root(app: &AppHandle, server_root: &str) -> Option<PathBuf> {
    for fresh in [false, true] {
        let Some((sample, size)) = sample(app, server_root, fresh).await else {
            continue;
        };
        let root = server_root.to_string();
        let found = tauri::async_runtime::spawn_blocking(move || {
            mapped(&root, &sample, size, &Mounts::current())
        })
        .await
        .ok()
        .flatten();
        if found.is_some() {
            return found;
        }
    }
    None
}

/// Whether the server's library folder is mounted on this computer.
#[tauri::command]
pub async fn server_root_on_this_mac(app: AppHandle, server_root: String) -> bool {
    local_root(&app, &server_root).await.is_some()
}

/// Shows one of the server's files in the file manager, at its path on this computer.
#[tauri::command]
pub async fn reveal_server_file(
    app: AppHandle,
    server_root: String,
    relative_path: String,
) -> Result<(), String> {
    let file = relative(&relative_path).ok_or("Not a file in this library")?;
    let local = local_root(&app, &server_root)
        .await
        .map(|root| root.join(file))
        .filter(|p| p.exists())
        .ok_or("This file isn't on a drive connected to this computer")?;
    app.opener()
        .reveal_item_in_dir(local)
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn scratch(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("lifer-server-paths-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn parents(dir: &Path) -> Mounts {
        Mounts {
            dirs: vec![dir.to_path_buf()],
            dirs_are_shares: false,
        }
    }

    #[test]
    fn a_drive_root_can_be_the_share_itself() {
        let drive = scratch("drive");
        fs::create_dir_all(drive.join("originals")).unwrap();
        fs::write(drive.join("originals/a.NEF"), b"12345").unwrap();
        let sample = Path::new("originals/a.NEF");
        let drives = Mounts {
            dirs: vec![drive.clone()],
            dirs_are_shares: true,
        };
        assert_eq!(drives.find(sample, 5), Some(drive.clone()));
        // As a parent of shares it isn't a match: the share would be a folder inside it.
        assert_eq!(parents(&drive).find(sample, 5), None);
        fs::remove_dir_all(&drive).unwrap();
    }

    #[test]
    fn the_servers_own_path_wins_when_it_exists_here() {
        let share = scratch("same-path");
        fs::write(share.join("s.jpg"), b"xy").unwrap();
        let none = Mounts {
            dirs: Vec::new(),
            dirs_are_shares: false,
        };
        assert_eq!(
            mapped(share.to_str().unwrap(), Path::new("s.jpg"), 2, &none),
            Some(share.clone())
        );
        fs::remove_dir_all(&share).unwrap();
    }

    #[test]
    fn finds_the_share_a_few_folders_down() {
        let volumes = scratch("find");
        let share = volumes.join("NAS/photos/lifer");
        fs::create_dir_all(share.join("originals/2024")).unwrap();
        fs::write(share.join("originals/2024/a.NEF"), b"12345").unwrap();
        fs::create_dir_all(volumes.join("Other/originals/2024")).unwrap();
        // Same path, different size: not the same file.
        fs::write(volumes.join("Other/originals/2024/a.NEF"), b"123").unwrap();
        let sample = Path::new("originals/2024/a.NEF");
        assert_eq!(find_prefix(&volumes, sample, 5), Some(share));
        assert_eq!(find_prefix(&volumes, sample, 4), None);
        fs::remove_dir_all(&volumes).unwrap();
    }

    #[test]
    fn re_searches_when_the_share_moves() {
        let volumes = scratch("moved");
        fs::create_dir_all(volumes.join("A/lib")).unwrap();
        fs::write(volumes.join("A/lib/s.jpg"), b"xy").unwrap();
        let sample = Path::new("s.jpg");
        assert_eq!(
            mapped("/data-moved", sample, 2, &parents(&volumes)),
            Some(volumes.join("A/lib"))
        );
        fs::rename(volumes.join("A"), volumes.join("B")).unwrap();
        assert_eq!(
            mapped("/data-moved", sample, 2, &parents(&volumes)),
            Some(volumes.join("B/lib"))
        );
        fs::remove_dir_all(&volumes).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn skips_links_and_hidden_folders() {
        let volumes = scratch("links");
        let real = scratch("links-target");
        fs::write(real.join("s.jpg"), b"x").unwrap();
        std::os::unix::fs::symlink(&real, volumes.join("Macintosh HD")).unwrap();
        fs::create_dir_all(volumes.join(".hidden")).unwrap();
        fs::write(volumes.join(".hidden/s.jpg"), b"x").unwrap();
        assert_eq!(find_prefix(&volumes, Path::new("s.jpg"), 1), None);
        fs::remove_dir_all(&volumes).unwrap();
        fs::remove_dir_all(&real).unwrap();
    }

    #[test]
    fn probes_only_the_samples_the_server_named() {
        let samples = vec![
            Sample {
                root: "/data".into(),
                relative_path: "originals/a.NEF".into(),
                size: 5,
            },
            Sample {
                root: "/odd".into(),
                relative_path: "../escape.jpg".into(),
                size: 1,
            },
        ];
        assert_eq!(
            sample_for(&samples, "/data"),
            Some((PathBuf::from("originals/a.NEF"), 5))
        );
        // A folder the server didn't list, or a sample that isn't a plain relative path, gives
        // nothing to probe.
        assert_eq!(sample_for(&samples, "/Users/someone"), None);
        assert_eq!(sample_for(&samples, "/odd"), None);
        assert_eq!(sample_for(&[], "/data"), None);
    }

    #[test]
    fn only_takes_plain_relative_paths() {
        assert!(relative("2024/a.jpg").is_some());
        for bad in ["", "/etc/hosts", "../a.jpg", "2024/../../a.jpg", "./a.jpg"] {
            assert!(relative(bad).is_none(), "{bad}");
        }
    }
}
