// Saves a local crash report when the shell panics. The api offers it on the next launch and
// sends it only if the user clicks Send (apps/api/src/crashReports/), redacting it again first.
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const KEEP: usize = 10;
const MAX_MESSAGE: usize = 4_000;
const MAX_STACK: usize = 64_000;

/// Same folder the api reads: its APP_DATA_DIR (api.rs) plus crash-reports.
pub fn reports_dir(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("app-data").join("crash-reports")
}

pub fn install_panic_hook(app_data_dir: PathBuf) {
    // Packagers who ship without crash reporting set LIFER_CRASH_REPORTS=off (the api honours it too).
    if std::env::var("LIFER_CRASH_REPORTS").is_ok_and(|v| v.trim().eq_ignore_ascii_case("off")) {
        return;
    }
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let payload = info
            .payload()
            .downcast_ref::<&str>()
            .map(|s| s.to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "panic".into());
        let location = info
            .location()
            .map(|l| format!(" at {}:{}", l.file(), l.line()))
            .unwrap_or_default();
        let stack = std::backtrace::Backtrace::force_capture().to_string();
        save(
            &reports_dir(&app_data_dir),
            &format!("{payload}{location}"),
            &stack,
        );
        previous(info);
    }));
}

fn save(dir: &Path, message: &str, stack: &str) {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_default();
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let report = serde_json::json!({
        "app": "lifer",
        "version": env!("CARGO_PKG_VERSION"),
        "os": node_os(),
        "arch": node_arch(),
        "kind": "desktop-panic",
        "message": cap(&redact(message, &home), MAX_MESSAGE),
        "stack": cap(&redact(stack, &home), MAX_STACK),
        "timestamp": now,
    });
    // A failure here has nowhere to go: the shell is already panicking.
    let _ = crate::fsutil::write_atomic(
        &dir.join(format!("{now}.json")),
        report.to_string().as_bytes(),
        None,
    );
    prune(dir);
}

fn prune(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut stamps: Vec<u128> = entries
        .filter_map(|e| {
            e.ok()?
                .file_name()
                .to_str()?
                .strip_suffix(".json")?
                .parse()
                .ok()
        })
        .collect();
    stamps.sort_unstable_by(|a, b| b.cmp(a));
    for old in stamps.iter().skip(KEEP) {
        let _ = std::fs::remove_file(dir.join(format!("{old}.json")));
    }
}

// The api's names, so every report says the same thing whichever side wrote it.
fn node_os() -> &'static str {
    match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        other => other,
    }
}

fn node_arch() -> &'static str {
    match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "x64",
        other => other,
    }
}

fn cap(text: &str, max: usize) -> String {
    match text.char_indices().nth(max) {
        Some((cut, _)) => format!("{}\n[truncated]", &text[..cut]),
        None => text.to_string(),
    }
}

/// A first pass: home folder, paths and emails. The api's redact() does the full job on read.
fn redact(text: &str, home: &str) -> String {
    let text = if home.len() > 1 {
        text.replace(home, "~")
    } else {
        text.to_string()
    };
    let mut out = String::with_capacity(text.len());
    let mut in_path = false;
    for piece in text.split_inclusive(char::is_whitespace) {
        let word = piece.trim_end();
        let gap = &piece[word.len()..];
        let has_sep = word.contains('/') || word.contains('\\');
        // A path with spaces ("~/My Birds/owl.jpg") continues while the next word has a separator.
        if in_path && has_sep {
            out.push_str(gap);
            continue;
        }
        in_path = has_sep && !gap.contains('\n');
        if has_sep {
            let file = word.rsplit(['/', '\\']).next().unwrap_or("");
            let base = file.split(':').next().unwrap_or("");
            out.push_str(if base.ends_with(".rs") {
                file
            } else {
                "<path>"
            });
        } else if word.contains('@') && word.contains('.') {
            out.push_str("<email>");
        } else {
            out.push_str(word);
        }
        out.push_str(gap);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_paths_and_emails() {
        let out = redact(
            "open /Users/judah/My Birds/owl.jpg for judah@example.com\n at /Users/judah/dev/src/api.rs:12:5",
            "/Users/judah",
        );
        assert!(!out.contains("judah"), "{out}");
        assert!(!out.contains("Birds"), "{out}");
        assert!(out.contains("api.rs:12:5"), "{out}");
    }

    #[test]
    fn saves_and_keeps_the_newest_ten() {
        let dir = std::env::temp_dir().join(format!("lifer-crash-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        for n in 0..12u128 {
            std::fs::write(dir.join(format!("{n}.json")), "{}").unwrap();
        }
        save(&dir, "boom at /Users/someone/x.jpg", "");
        let count = std::fs::read_dir(&dir).unwrap().count();
        let newest = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| {
                e.ok()?
                    .file_name()
                    .to_str()?
                    .strip_suffix(".json")?
                    .parse::<u128>()
                    .ok()
            })
            .max()
            .unwrap();
        let report: serde_json::Value =
            serde_json::from_slice(&std::fs::read(dir.join(format!("{newest}.json"))).unwrap())
                .unwrap();
        std::fs::remove_dir_all(&dir).unwrap();
        assert_eq!(count, KEEP);
        assert_eq!(report["kind"], "desktop-panic");
        assert_eq!(report["message"], "boom at <path>");
    }
}
