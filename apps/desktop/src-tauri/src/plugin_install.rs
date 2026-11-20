// Installing a suggested companion app: download the installer the user chose, check its signature
// against the identity the suggestion names, then open it with the system's own installer. Nothing
// is requested before the user presses Install, and a file that fails the check is deleted unopened.
use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{Manager, WebviewWindow};
use tauri_plugin_opener::OpenerExt;

// Installers are big, but a runaway or hostile server shouldn't fill the disk.
const MAX_INSTALLER_BYTES: u64 = 4 * 1024 * 1024 * 1024;
#[cfg(not(any(target_os = "macos", windows)))]
const MAX_SIGNATURE_BYTES: usize = 8 * 1024;

#[derive(Default)]
struct Download {
    downloaded: AtomicU64,
    total: AtomicU64,
    cancel: AtomicBool,
    done: AtomicBool,
}

#[derive(Default)]
pub struct PluginInstalls(Mutex<HashMap<String, Arc<Download>>>);

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct InstallProgress {
    pub downloaded: u64,
    /// 0 when the server didn't say.
    pub total: u64,
    pub running: bool,
}

/// A plain https URL on a named host: no credentials, no address literals, no fragments.
fn checked_url(raw: &str) -> Result<url::Url, String> {
    let url = url::Url::parse(raw).map_err(|_| "That download address isn't valid.".to_string())?;
    let host_ok = matches!(url.host(), Some(url::Host::Domain(_)));
    if url.scheme() != "https"
        || !host_ok
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err("That download address isn't a plain https address.".into());
    }
    Ok(url)
}

/// The last path segment as a safe file name.
fn file_name(url: &url::Url) -> String {
    let last = url
        .path_segments()
        .and_then(|mut s| s.next_back())
        .unwrap_or("");
    let clean: String = last
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || "-_.".contains(c) {
                c
            } else {
                '_'
            }
        })
        .collect();
    let clean = clean.trim_start_matches('.');
    if clean.is_empty() {
        "installer".into()
    } else {
        clean.chars().take(100).collect()
    }
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Linux has no platform signature check, so a detached minisign signature is checked against the
/// public key the suggestion names.
#[cfg(any(not(any(target_os = "macos", windows)), test))]
fn verify_minisign(file: &Path, public_key: &str, signature: &str) -> Result<(), String> {
    let key = minisign_verify::PublicKey::from_base64(public_key.trim())
        .map_err(|_| "The suggestion's signing key isn't valid.".to_string())?;
    let sig = minisign_verify::Signature::decode(signature)
        .map_err(|_| "The installer's signature isn't valid.".to_string())?;
    let bytes = fs::read(file).map_err(|e| e.to_string())?;
    key.verify(&bytes, &sig, false)
        .map_err(|_| "The installer doesn't match its signature.".to_string())
}

/// Whether the file was signed by `expected`: the code signature's identity on macOS and Windows
/// (the same check approval uses), a minisign signature elsewhere.
async fn verify(
    file: &Path,
    expected: &str,
    signature_url: Option<&url::Url>,
) -> Result<(), String> {
    #[cfg(any(target_os = "macos", windows))]
    {
        let _ = signature_url;
        match crate::plugins::signer_of(file) {
            Some(found) if found == expected => Ok(()),
            _ => Err("This installer isn't signed by the publisher it should be.".into()),
        }
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let url = signature_url.ok_or("This suggestion has no signature to check.")?;
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .redirect(reqwest::redirect::Policy::limited(3))
            .build()
            .map_err(|e| e.to_string())?;
        let text = client
            .get(url.clone())
            .send()
            .await
            .map_err(|_| "Couldn't download the signature.".to_string())?
            .bytes()
            .await
            .map_err(|_| "Couldn't download the signature.".to_string())?;
        if text.len() > MAX_SIGNATURE_BYTES {
            return Err("The signature is too big.".into());
        }
        verify_minisign(file, expected, &String::from_utf8_lossy(&text))
    }
}

async fn download(url: url::Url, dir: &Path, state: &Download) -> Result<PathBuf, String> {
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(20))
        .read_timeout(Duration::from_secs(60))
        // Only https hops; the final host may differ from the first.
        .redirect(reqwest::redirect::Policy::custom(|a| {
            if a.previous().len() > 5 || a.url().scheme() != "https" {
                a.stop()
            } else {
                a.follow()
            }
        }))
        .build()
        .map_err(|e| e.to_string())?;
    let mut response = client.get(url).send().await.map_err(|_| {
        "Couldn't reach the download. Check your connection and try again.".to_string()
    })?;
    if !response.status().is_success() {
        return Err("The download isn't available right now.".into());
    }
    let total = response.content_length().unwrap_or(0);
    if total > MAX_INSTALLER_BYTES {
        return Err("The download is larger than Lifer will accept.".into());
    }
    state.total.store(total, Ordering::SeqCst);
    // Named after the final hop: a counting redirect's own path has no .dmg or .exe to open by.
    let dest = dir.join(file_name(response.url()));
    let mut out = fs::File::create(&dest).map_err(|e| e.to_string())?;
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "The download was interrupted.".to_string())?
    {
        if state.cancel.load(Ordering::SeqCst) {
            return Err("Cancelled".into());
        }
        let so_far = state
            .downloaded
            .fetch_add(chunk.len() as u64, Ordering::SeqCst)
            + chunk.len() as u64;
        if so_far > MAX_INSTALLER_BYTES {
            return Err("The download is larger than Lifer will accept.".into());
        }
        out.write_all(&chunk).map_err(|e| e.to_string())?;
    }
    out.flush().map_err(|e| e.to_string())?;
    Ok(dest)
}

fn installs_dir(window: &WebviewWindow, app_id: &str) -> PathBuf {
    let safe: String = app_id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || "-.".contains(*c))
        .collect();
    crate::app_data_dir(window.app_handle())
        .join("downloads")
        .join("apps")
        .join(safe)
}

/// Downloads, checks and opens one suggested app's installer. `signer` is the identity the
/// suggestion names (macOS team id, Windows subject and issuer, or the Linux minisign public key).
#[tauri::command]
pub(crate) async fn plugin_install(
    window: WebviewWindow,
    app_id: String,
    url: String,
    signer: String,
    signature_url: Option<String>,
) -> Result<(), String> {
    if !crate::security::is_app_page(&window) {
        return Err("not allowed".into());
    }
    let url = checked_url(&url)?;
    let signature_url = signature_url.as_deref().map(checked_url).transpose()?;
    let state = {
        let installs = window.state::<PluginInstalls>();
        let mut map = lock(&installs.0);
        if map
            .get(&app_id)
            .is_some_and(|d| !d.done.load(Ordering::SeqCst))
        {
            return Err("This app is already downloading.".into());
        }
        let fresh = Arc::new(Download::default());
        map.insert(app_id.clone(), fresh.clone());
        fresh
    };
    let dir = installs_dir(&window, &app_id);
    let result = async {
        // A clean folder, so an earlier unchecked file can never be the one opened.
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let file = download(url, &dir, &state).await?;
        verify(&file, &signer, signature_url.as_ref()).await?;
        Ok::<PathBuf, String>(file)
    }
    .await;
    state.done.store(true, Ordering::SeqCst);
    match result {
        Ok(file) => window
            .app_handle()
            .opener()
            .open_path(file.to_string_lossy(), None::<&str>)
            .map_err(|e| e.to_string()),
        Err(message) => {
            let _ = fs::remove_dir_all(&dir);
            Err(message)
        }
    }
}

#[tauri::command]
pub(crate) fn plugin_install_progress(
    window: WebviewWindow,
    app_id: String,
) -> Result<InstallProgress, String> {
    if !crate::security::is_app_page(&window) {
        return Err("not allowed".into());
    }
    let installs = window.state::<PluginInstalls>();
    let map = lock(&installs.0);
    Ok(map.get(&app_id).map_or(
        InstallProgress {
            downloaded: 0,
            total: 0,
            running: false,
        },
        |d| InstallProgress {
            downloaded: d.downloaded.load(Ordering::SeqCst),
            total: d.total.load(Ordering::SeqCst),
            running: !d.done.load(Ordering::SeqCst),
        },
    ))
}

#[tauri::command]
pub(crate) fn plugin_install_cancel(window: WebviewWindow, app_id: String) -> Result<(), String> {
    if !crate::security::is_app_page(&window) {
        return Err("not allowed".into());
    }
    if let Some(d) = lock(&window.state::<PluginInstalls>().0).get(&app_id) {
        d.cancel.store(true, Ordering::SeqCst);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_plain_https_addresses_are_downloaded() {
        assert!(checked_url("https://example.com/app/Setup.exe").is_ok());
        for bad in [
            "http://example.com/a.dmg",
            "https://127.0.0.1/a.dmg",
            "https://[::1]/a.dmg",
            "https://user:pw@example.com/a.dmg",
            "https://example.com/a.dmg#x",
            "file:///etc/passwd",
            "nonsense",
        ] {
            assert!(checked_url(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn file_names_are_safe() {
        let name = |u: &str| file_name(&url::Url::parse(u).unwrap());
        assert_eq!(
            name("https://example.com/dl/My%20App%201.2.dmg"),
            "My_20App_201.2.dmg"
        );
        assert_eq!(name("https://example.com/"), "installer");
        assert!(!name("https://example.com/%2E%2E").starts_with('.'));
    }

    #[test]
    fn a_tampered_or_malformed_signature_is_refused() {
        let file = std::env::temp_dir().join("lifer-install-test.bin");
        fs::write(&file, b"installer bytes").unwrap();
        let key = "RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3";
        assert!(verify_minisign(&file, key, "not a signature").is_err());
        assert!(verify_minisign(&file, "not a key", "x").is_err());
        let _ = fs::remove_file(&file);
    }
}
