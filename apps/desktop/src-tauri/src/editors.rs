// "Open in" for photo editors: finds the ones installed in their usual places and opens files in a
// chosen one. Only the app's own pages may ask; the page names an editor id from this list, never
// a program path, and every file must exist.
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use tauri::{AppHandle, WebviewWindow};
use tauri_plugin_opener::OpenerExt;

use crate::security::is_app_page;

/// The system's own handler for the file type, offered beside the editors found.
const SYSTEM: &str = "system";
const MAX_FILES: usize = 200;
// Keeps a scan of a big Applications or Program Files folder to a moment.
const MAX_DEPTH: usize = 3;
const MAX_ENTRIES: usize = 3000;

#[derive(Clone, Copy, PartialEq, Debug)]
enum Os {
    Mac,
    Windows,
    Linux,
}

fn current_os() -> Os {
    if cfg!(target_os = "macos") {
        Os::Mac
    } else if cfg!(windows) {
        Os::Windows
    } else {
        Os::Linux
    }
}

struct Editor {
    id: &'static str,
    name: &'static str,
    /// macOS: start of the .app name.
    mac: &'static str,
    /// Windows: a folder name the program sits under, and the start of its .exe name.
    win_dir: &'static str,
    win_exe: &'static str,
    /// Linux: the command on PATH.
    bin: &'static str,
}

const EDITORS: [Editor; 8] = [
    Editor {
        id: "lightroom-classic",
        name: "Lightroom Classic",
        mac: "Adobe Lightroom Classic",
        win_dir: "lightroom classic",
        win_exe: "lightroom",
        bin: "",
    },
    Editor {
        id: "photoshop",
        name: "Photoshop",
        mac: "Adobe Photoshop",
        win_dir: "adobe photoshop",
        win_exe: "photoshop",
        bin: "",
    },
    Editor {
        id: "capture-one",
        name: "Capture One",
        mac: "Capture One",
        win_dir: "capture one",
        win_exe: "captureone",
        bin: "",
    },
    Editor {
        id: "dxo",
        name: "DxO PhotoLab",
        mac: "DxO PhotoLab",
        win_dir: "dxo",
        win_exe: "dxo.photolab",
        bin: "",
    },
    Editor {
        id: "darktable",
        name: "darktable",
        mac: "darktable",
        win_dir: "darktable",
        win_exe: "darktable",
        bin: "darktable",
    },
    Editor {
        id: "rawtherapee",
        name: "RawTherapee",
        mac: "RawTherapee",
        win_dir: "rawtherapee",
        win_exe: "rawtherapee",
        bin: "rawtherapee",
    },
    Editor {
        id: "affinity",
        name: "Affinity",
        mac: "Affinity",
        win_dir: "affinity",
        win_exe: "photo",
        bin: "",
    },
    Editor {
        id: "gimp",
        name: "GIMP",
        mac: "GIMP",
        win_dir: "gimp",
        win_exe: "gimp-",
        bin: "gimp",
    },
];

#[derive(Serialize, Debug, PartialEq)]
pub struct EditorInfo {
    id: String,
    name: String,
}

/// Where each system keeps programs: application folders, and PATH folders on Linux.
struct Roots {
    apps: Vec<PathBuf>,
    path: Vec<PathBuf>,
}

fn system_roots(os: Os) -> Roots {
    let env = |k: &str| std::env::var_os(k).map(PathBuf::from);
    let mut apps = Vec::new();
    match os {
        Os::Mac => {
            apps.push(PathBuf::from("/Applications"));
            if let Some(h) = env("HOME") {
                apps.push(h.join("Applications"));
            }
        }
        Os::Windows => {
            for k in ["ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"] {
                apps.extend(env(k));
            }
            if let Some(l) = env("LOCALAPPDATA") {
                apps.push(l.join("Programs"));
            }
        }
        Os::Linux => {}
    }
    let mut path: Vec<PathBuf> =
        std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()).collect();
    path.extend(
        [
            "/usr/bin",
            "/usr/local/bin",
            "/snap/bin",
            "/var/lib/flatpak/exports/bin",
        ]
        .map(PathBuf::from),
    );
    Roots { apps, path }
}

/// The first entry within a few levels of `dir` that `pred` accepts. `.app` bundles are not entered.
fn find(
    dir: &Path,
    depth: usize,
    seen: &mut usize,
    pred: &dyn Fn(&Path) -> bool,
) -> Option<PathBuf> {
    let mut entries: Vec<PathBuf> = std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .map(|e| e.path())
        .collect();
    entries.sort();
    for p in &entries {
        *seen += 1;
        if *seen > MAX_ENTRIES {
            return None;
        }
        if pred(p) {
            return Some(p.clone());
        }
    }
    if depth > 1 {
        for p in entries
            .iter()
            .filter(|p| p.is_dir() && p.extension().is_none_or(|e| e != "app"))
        {
            if let Some(hit) = find(p, depth - 1, seen, pred) {
                return Some(hit);
            }
        }
    }
    None
}

fn lower(p: &Path) -> String {
    p.file_name()
        .map(|n| n.to_string_lossy().to_lowercase())
        .unwrap_or_default()
}

fn locate(e: &Editor, os: Os, roots: &Roots) -> Option<PathBuf> {
    match os {
        Os::Mac => {
            let prefix = e.mac.to_lowercase();
            let pred = |p: &Path| {
                p.is_dir()
                    && p.extension().is_some_and(|x| x == "app")
                    && lower(p).starts_with(&prefix)
            };
            roots
                .apps
                .iter()
                .find_map(|r| find(r, MAX_DEPTH, &mut 0, &pred))
        }
        Os::Windows => {
            let pred = |p: &Path| {
                p.extension().is_some_and(|x| x.eq_ignore_ascii_case("exe"))
                    && lower(p).starts_with(e.win_exe)
                    && p.to_string_lossy().to_lowercase().contains(e.win_dir)
            };
            roots
                .apps
                .iter()
                .find_map(|r| find(r, MAX_DEPTH + 1, &mut 0, &pred))
        }
        Os::Linux => {
            if e.bin.is_empty() {
                return None;
            }
            roots
                .path
                .iter()
                .map(|d| d.join(e.bin))
                .find(|p| p.is_file())
        }
    }
}

/// The editors found, plus the system default when at least one was. Nothing found means the
/// page shows no "Open in" at all.
fn detect(os: Os, roots: &Roots) -> Vec<EditorInfo> {
    let mut found: Vec<EditorInfo> = EDITORS
        .iter()
        .filter(|e| locate(e, os, roots).is_some())
        .map(|e| EditorInfo {
            id: e.id.into(),
            name: e.name.into(),
        })
        .collect();
    if !found.is_empty() {
        found.push(EditorInfo {
            id: SYSTEM.into(),
            name: "System default".into(),
        });
    }
    found
}

#[tauri::command]
pub fn editors_list(window: WebviewWindow) -> Vec<EditorInfo> {
    if !is_app_page(&window) {
        return Vec::new();
    }
    let os = current_os();
    detect(os, &system_roots(os))
}

fn launch(os: Os, program: &Path, files: &[PathBuf]) -> Result<(), String> {
    let mut cmd = if os == Os::Mac {
        let mut c = Command::new("open");
        c.arg("-a").arg(program).arg("--");
        c
    } else {
        Command::new(program)
    };
    cmd.args(files)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn open_in(
    app: AppHandle,
    window: WebviewWindow,
    editor_id: String,
    paths: Vec<String>,
) -> Result<(), String> {
    if !is_app_page(&window) {
        return Err("Not allowed".into());
    }
    let files: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();
    if files.is_empty()
        || files.len() > MAX_FILES
        || files.iter().any(|f| !f.is_absolute() || !f.is_file())
    {
        return Err("Those files aren't on this computer".into());
    }
    if editor_id == SYSTEM {
        for f in files {
            app.opener()
                .open_path(f.to_string_lossy(), None::<&str>)
                .map_err(|e| e.to_string())?;
        }
        return Ok(());
    }
    let os = current_os();
    let editor = EDITORS
        .iter()
        .find(|e| e.id == editor_id)
        .ok_or("Unknown editor")?;
    let program = locate(editor, os, &system_roots(os)).ok_or("That editor isn't installed")?;
    launch(os, &program, &files)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("lifer-editors-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn roots(apps: &Path) -> Roots {
        Roots {
            apps: vec![apps.to_path_buf()],
            path: vec![apps.join("bin")],
        }
    }

    fn ids(found: &[EditorInfo]) -> Vec<&str> {
        found.iter().map(|e| e.id.as_str()).collect()
    }

    #[test]
    fn finds_mac_apps_including_ones_in_a_vendor_folder() {
        let dir = scratch("mac");
        fs::create_dir_all(dir.join("Adobe Photoshop 2025/Adobe Photoshop 2025.app")).unwrap();
        fs::create_dir_all(dir.join("darktable.app")).unwrap();
        fs::create_dir_all(dir.join("Adobe Lightroom.app")).unwrap(); // the cloud app, not Classic
        let found = detect(Os::Mac, &roots(&dir));
        assert_eq!(ids(&found), ["photoshop", "darktable", "system"]);
    }

    #[test]
    fn finds_windows_programs_by_folder_and_exe() {
        let dir = scratch("win");
        fs::create_dir_all(dir.join("Adobe/Adobe Lightroom Classic")).unwrap();
        fs::write(dir.join("Adobe/Adobe Lightroom Classic/Lightroom.exe"), b"").unwrap();
        fs::create_dir_all(dir.join("GIMP 2/bin")).unwrap();
        fs::write(dir.join("GIMP 2/bin/gimp-2.10.exe"), b"").unwrap();
        fs::create_dir_all(dir.join("Other")).unwrap();
        fs::write(dir.join("Other/Photoshop.exe"), b"").unwrap();
        let found = detect(Os::Windows, &roots(&dir));
        assert_eq!(ids(&found), ["lightroom-classic", "gimp", "system"]);
    }

    #[test]
    fn finds_linux_commands_on_the_path() {
        let dir = scratch("linux");
        fs::create_dir_all(dir.join("bin")).unwrap();
        fs::write(dir.join("bin/rawtherapee"), b"").unwrap();
        assert_eq!(
            ids(&detect(Os::Linux, &roots(&dir))),
            ["rawtherapee", "system"]
        );
    }

    #[test]
    fn lists_nothing_when_no_editor_is_installed() {
        let dir = scratch("none");
        assert!(detect(Os::Mac, &roots(&dir)).is_empty());
    }
}
