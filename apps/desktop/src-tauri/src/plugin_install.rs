// Lifer as a launcher for third-party apps: download the publisher's own signed installer, check it,
// and hand it to the system's installer. Lifer never unpacks or runs the program itself. Every trust
// anchor (feed address, allowed hosts, minisign keys, code signer, installer format, install places)
// is compiled in from suggestedApps.json; the page only names an app id.
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tauri::{Manager, WebviewWindow};
use tauri_plugin_opener::OpenerExt;

const SUGGESTED_APPS: &str = include_str!("../../../web/src/data/suggestedApps.json");
// Installers are big, but a runaway or hostile server shouldn't fill the disk.
const MAX_INSTALLER_BYTES: u64 = 4 * 1024 * 1024 * 1024;
const MAX_FEED_BYTES: usize = 64 * 1024;
// Room left for the installer to unpack and the system to breathe.
const SPACE_MARGIN: u64 = 512 * 1024 * 1024;
const PLACEHOLDER: &str = "PLACEHOLDER";

// Error codes the page turns into plain words (suggestedApps.error.* in en.json).
pub(crate) const NOT_SET_UP: &str = "not-set-up";
pub(crate) const NO_INSTALLER: &str = "no-installer";
pub(crate) const BUSY: &str = "busy";
pub(crate) const OFFLINE: &str = "offline";
pub(crate) const UNAVAILABLE: &str = "unavailable";
pub(crate) const VERIFICATION: &str = "verification";
pub(crate) const TOO_LARGE: &str = "too-large";
pub(crate) const SPACE: &str = "space";
pub(crate) const BLOCKED: &str = "blocked";
pub(crate) const CANCELLED: &str = "cancelled";
pub(crate) const FAILED: &str = "failed";

#[derive(Debug, Deserialize)]
struct Entry {
    id: String,
    name: String,
    install: Option<Install>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Install {
    /// The publisher's feed; `{channel}` is replaced by `channel`.
    feed: String,
    #[serde(default)]
    channel: Option<String>,
    /// Exact hosts the feed and installer (after redirects) may be on.
    hosts: Vec<String>,
    minisign_keys: Vec<String>,
    #[serde(default)]
    pending: bool,
    /// Keyed by target, like `darwin-aarch64` or `windows-x86_64`.
    platforms: HashMap<String, Target>,
    /// Keyed by OS (`darwin`, `win32`, `linux`): where a standalone copy's program lives.
    #[serde(default)]
    locations: HashMap<String, Vec<String>>,
}

#[derive(Debug, Deserialize)]
struct Target {
    format: String,
    /// macOS Team ID, or the Windows certificate subject.
    #[serde(default)]
    signer: Option<String>,
    /// Windows only: allowed issuers; empty allows any issuer Windows trusts.
    #[serde(default)]
    issuers: Vec<String>,
}

#[derive(Deserialize)]
struct Feed {
    installers: Option<HashMap<String, FeedInstaller>>,
}

#[derive(Deserialize)]
struct FeedInstaller {
    version: String,
    format: String,
    url: String,
    size: u64,
    sha256: String,
    minisign: String,
}

fn entries() -> &'static [Entry] {
    static ENTRIES: OnceLock<Vec<Entry>> = OnceLock::new();
    ENTRIES.get_or_init(|| serde_json::from_str(SUGGESTED_APPS).unwrap_or_default())
}

/// This build's target key, the same names the feed uses.
fn this_target() -> String {
    let os = if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(windows) {
        "windows"
    } else {
        "linux"
    };
    format!("{os}-{}", std::env::consts::ARCH)
}

fn this_os_key() -> &'static str {
    if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(windows) {
        "win32"
    } else {
        "linux"
    }
}

/// The file extension a format installs from, for formats this OS opens with its own installer.
/// An AppImage would have to be made executable and run by Lifer, so it never installs from here.
fn extension(target: &str, format: &str) -> Option<&'static str> {
    match (target.split('-').next()?, format) {
        ("darwin", "dmg") => Some("dmg"),
        ("windows", "nsis") => Some("exe"),
        ("windows", "msi") => Some("msi"),
        ("linux", "deb") => Some("deb"),
        ("linux", "rpm") => Some("rpm"),
        _ => None,
    }
}

fn has_placeholder(install: &Install, target: Option<&Target>) -> bool {
    let mut fields = vec![install.feed.as_str()];
    fields.extend(install.hosts.iter().map(String::as_str));
    fields.extend(install.minisign_keys.iter().map(String::as_str));
    if let Some(t) = target {
        fields.extend(t.signer.as_deref());
        fields.extend(t.issuers.iter().map(String::as_str));
    }
    fields.iter().any(|f| f.contains(PLACEHOLDER))
}

/// The entry, its install block and this target's anchor, or why it can't install here.
fn resolve<'a>(
    list: &'a [Entry],
    id: &str,
    target: &str,
) -> Result<(&'a Entry, &'a Install, &'a Target), &'static str> {
    let entry = list.iter().find(|e| e.id == id).ok_or(NO_INSTALLER)?;
    let install = entry.install.as_ref().ok_or(NO_INSTALLER)?;
    let anchor = install.platforms.get(target);
    if install.pending || has_placeholder(install, anchor) {
        return Err(NOT_SET_UP);
    }
    let anchor = anchor.ok_or(NO_INSTALLER)?;
    extension(target, &anchor.format).ok_or(NO_INSTALLER)?;
    if install.minisign_keys.is_empty() || install.hosts.is_empty() {
        return Err(NOT_SET_UP);
    }
    // macOS and Windows installers also carry the OS's own code signature, pinned here.
    if (target.starts_with("darwin") || target.starts_with("windows")) && anchor.signer.is_none() {
        return Err(NOT_SET_UP);
    }
    Ok((entry, install, anchor))
}

/// A plain address on one of the allowed hosts: https, a named host, no credentials or fragment.
fn allowed(raw: &str, hosts: &[String]) -> Option<url::Url> {
    let url = url::Url::parse(raw).ok()?;
    // Tests serve fixtures over plain http on localhost.
    let scheme_ok = url.scheme() == "https" || (cfg!(test) && url.scheme() == "http");
    let host_ok = matches!(url.host(), Some(url::Host::Domain(h)) if hosts.iter().any(|a| a.eq_ignore_ascii_case(h)));
    (scheme_ok
        && host_ok
        && url.username().is_empty()
        && url.password().is_none()
        && url.fragment().is_none())
    .then_some(url)
}

/// Whether a code signer found on the file is the one the anchor pins. Windows reports
/// "subject\nissued by issuer": the subject is pinned, the issuer only when a list is given,
/// since short-lived certificates can come from several intermediates.
fn signer_matches(found: &str, expected: &str, issuers: &[String]) -> bool {
    match found.split_once("\nissued by ") {
        Some((subject, issuer)) => {
            subject == expected && (issuers.is_empty() || issuers.iter().any(|i| i == issuer))
        }
        None => found == expected,
    }
}

/// Everything signed into the trusted comment must name this app, target and version.
fn comment_matches(comment: &str, id: &str, target: &str, version: &str) -> bool {
    let has = |k: &str, v: &str| {
        comment
            .split_whitespace()
            .any(|t| t.strip_prefix(k).and_then(|r| r.strip_prefix(':')) == Some(v))
    };
    has("id", id) && has("target", target) && has("version", version)
}

#[derive(Default)]
struct Download {
    downloaded: AtomicU64,
    total: AtomicU64,
    // 0 downloading, 1 verifying, 2 opening the installer.
    stage: AtomicU8,
    cancel: AtomicBool,
    done: AtomicBool,
}

#[derive(Default)]
pub struct PluginInstalls(Mutex<HashMap<String, Arc<Download>>>);

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct InstallProgress {
    pub downloaded: u64,
    /// 0 until the size is known.
    pub total: u64,
    pub running: bool,
    /// "downloading", "verifying" or "opening".
    pub stage: &'static str,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Claims the app's install slot; a second install of the same app while one runs is refused.
fn begin(installs: &PluginInstalls, id: &str) -> Result<Arc<Download>, &'static str> {
    let mut map = lock(&installs.0);
    if map.get(id).is_some_and(|d| !d.done.load(Ordering::SeqCst)) {
        return Err(BUSY);
    }
    let fresh = Arc::new(Download::default());
    map.insert(id.to_string(), fresh.clone());
    Ok(fresh)
}

#[cfg(unix)]
#[allow(clippy::unnecessary_cast)]
fn free_bytes(dir: &Path) -> Option<u64> {
    use std::os::unix::ffi::OsStrExt;
    let path = std::ffi::CString::new(dir.as_os_str().as_bytes()).ok()?;
    // SAFETY: statvfs only writes into the zeroed struct we pass and reads the NUL-terminated path.
    let mut s: libc::statvfs = unsafe { std::mem::zeroed() };
    (unsafe { libc::statvfs(path.as_ptr(), &mut s) } == 0)
        .then(|| s.f_bavail as u64 * s.f_frsize as u64)
}

// shortcut: Windows has no pre-check, a full disk is caught as StorageFull while writing; add
// GetDiskFreeSpaceExW if a late failure proves annoying.
#[cfg(not(unix))]
fn free_bytes(_dir: &Path) -> Option<u64> {
    None
}

/// What one install needs, all from compiled-in anchors except `feed`'s answer.
struct Plan<'a> {
    id: &'a str,
    name: &'a str,
    target: &'a str,
    format: &'a str,
    feed: String,
    hosts: &'a [String],
    keys: &'a [String],
}

fn client(hosts: &[String]) -> Result<reqwest::Client, &'static str> {
    let hosts = hosts.to_vec();
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(20))
        .read_timeout(Duration::from_secs(60))
        // Every hop stays https and on an allowed host; anything else stops at the redirect.
        .redirect(reqwest::redirect::Policy::custom(move |a| {
            if a.previous().len() > 5 || allowed(a.url().as_str(), &hosts).is_none() {
                a.stop()
            } else {
                a.follow()
            }
        }))
        .build()
        .map_err(|_| FAILED)
}

async fn get(client: &reqwest::Client, url: url::Url) -> Result<reqwest::Response, &'static str> {
    let response = client.get(url).send().await.map_err(|_| OFFLINE)?;
    if response.status().is_redirection() {
        // A redirect off the allowed hosts.
        return Err(VERIFICATION);
    }
    if !response.status().is_success() {
        return Err(UNAVAILABLE);
    }
    Ok(response)
}

async fn read_feed(
    client: &reqwest::Client,
    plan: &Plan<'_>,
) -> Result<FeedInstaller, &'static str> {
    let url = allowed(&plan.feed, plan.hosts).ok_or(NOT_SET_UP)?;
    let mut response = get(client, url).await?;
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| OFFLINE)? {
        if body.len() + chunk.len() > MAX_FEED_BYTES {
            return Err(UNAVAILABLE);
        }
        body.extend_from_slice(&chunk);
    }
    let mut feed: Feed = serde_json::from_slice(&body).map_err(|_| UNAVAILABLE)?;
    // No installer for this computer in this release: the website is the way.
    let found = feed
        .installers
        .as_mut()
        .and_then(|m| m.remove(plan.target))
        .ok_or(NO_INSTALLER)?;
    if found.format != plan.format {
        return Err(NO_INSTALLER);
    }
    Ok(found)
}

/// Fetches the feed, downloads this target's installer into `dir` and checks it: allowed hosts,
/// exact size, sha256 and minisign (with id, target and version in the signed comment), all on
/// the bytes as they stream in. Returns the checked file; on any failure `dir` is deleted.
async fn fetch_verified(
    plan: &Plan<'_>,
    dir: &Path,
    state: &Download,
) -> Result<PathBuf, &'static str> {
    let result = fetch_inner(plan, dir, state).await;
    if result.is_err() {
        let _ = fs::remove_dir_all(dir);
    }
    result
}

async fn fetch_inner(
    plan: &Plan<'_>,
    dir: &Path,
    state: &Download,
) -> Result<PathBuf, &'static str> {
    use sha2::Digest;
    let client = client(plan.hosts)?;
    let found = read_feed(&client, plan).await?;
    let url = allowed(&found.url, plan.hosts).ok_or(VERIFICATION)?;
    if found.size > MAX_INSTALLER_BYTES {
        return Err(TOO_LARGE);
    }
    let expected_sha = found.sha256.to_ascii_lowercase();
    if found.size == 0
        || expected_sha.len() != 64
        || !expected_sha.bytes().all(|b| b.is_ascii_hexdigit())
    {
        return Err(VERIFICATION);
    }
    let signature =
        minisign_verify::Signature::decode(found.minisign.trim()).map_err(|_| VERIFICATION)?;
    if !comment_matches(
        signature.trusted_comment(),
        plan.id,
        plan.target,
        &found.version,
    ) {
        return Err(VERIFICATION);
    }
    let keys: Vec<minisign_verify::PublicKey> = plan
        .keys
        .iter()
        .filter_map(|k| minisign_verify::PublicKey::from_base64(k.trim()).ok())
        .collect();
    let key = keys
        .iter()
        .find(|k| k.verify_stream(&signature).is_ok())
        .ok_or(VERIFICATION)?;
    let mut verifier = key.verify_stream(&signature).map_err(|_| VERIFICATION)?;
    if free_bytes(dir).is_some_and(|free| free < found.size.saturating_add(SPACE_MARGIN)) {
        return Err(SPACE);
    }

    let mut response = get(&client, url).await?;
    if response.content_length().is_some_and(|n| n != found.size) {
        return Err(VERIFICATION);
    }
    state.total.store(found.size, Ordering::SeqCst);
    let part = dir.join("download.part");
    let mut out = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&part)
        .map_err(|_| FAILED)?;
    let mut sha = sha2::Sha256::new();
    let mut written: u64 = 0;
    while let Some(chunk) = response.chunk().await.map_err(|_| OFFLINE)? {
        if state.cancel.load(Ordering::SeqCst) {
            return Err(CANCELLED);
        }
        written += chunk.len() as u64;
        if written > found.size {
            return Err(VERIFICATION);
        }
        sha.update(&chunk);
        verifier.update(&chunk);
        out.write_all(&chunk).map_err(|e| {
            if e.kind() == std::io::ErrorKind::StorageFull {
                SPACE
            } else {
                FAILED
            }
        })?;
        state.downloaded.store(written, Ordering::SeqCst);
    }
    out.sync_all().map_err(|_| FAILED)?;
    drop(out);
    state.stage.store(1, Ordering::SeqCst);
    let digest: String = sha.finalize().iter().map(|b| format!("{b:02x}")).collect();
    if written != found.size || digest != expected_sha || verifier.finalize().is_err() {
        return Err(VERIFICATION);
    }
    let ext = extension(plan.target, plan.format).ok_or(NO_INSTALLER)?;
    let stem: String = plan
        .name
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
        .take(60)
        .collect();
    let stem = if stem.is_empty() { "Installer" } else { &stem };
    let file = dir.join(format!("{stem}.{ext}"));
    fs::rename(&part, &file).map_err(|_| FAILED)?;
    Ok(file)
}

/// The OS code signature on macOS and Windows: the pinned signer, and on macOS notarisation too.
/// Linux packages carry only the minisign signature, already checked.
fn platform_check(file: &Path, anchor: &Target) -> Result<(), &'static str> {
    #[cfg(any(target_os = "macos", windows))]
    {
        let expected = anchor.signer.as_deref().ok_or(NOT_SET_UP)?;
        let found = crate::plugins::signer_of(file).ok_or(VERIFICATION)?;
        if !signer_matches(&found, expected, &anchor.issuers) {
            return Err(VERIFICATION);
        }
        #[cfg(target_os = "macos")]
        {
            // Gatekeeper's own verdict on the disk image: notarised Developer ID only.
            let notarised = std::process::Command::new("/usr/sbin/spctl")
                .args(["-a", "-t", "open", "--context", "context:primary-signature"])
                .arg(file)
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
                .is_ok_and(|s| s.success());
            if !notarised {
                return Err(VERIFICATION);
            }
        }
        Ok(())
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let _ = (file, anchor);
        Ok(())
    }
}

/// `<app data>/downloads/apps/<id>`, emptied so an earlier unchecked file can never be opened.
fn fresh_base(window: &WebviewWindow, app_id: &str) -> Result<PathBuf, &'static str> {
    let safe: String = app_id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || "-.".contains(*c))
        .collect();
    let base = crate::app_data_dir(window.app_handle())
        .join("downloads")
        .join("apps")
        .join(safe);
    let _ = fs::remove_dir_all(&base);
    fs::create_dir_all(&base).map_err(|_| FAILED)?;
    Ok(base)
}

/// A new owner-only folder with a random name inside `base`, for one download.
fn private_dir(base: &Path) -> Result<PathBuf, &'static str> {
    let token = crate::local_inference::random_token().map_err(|_| FAILED)?;
    let dir = base.join(&token[..16]);
    let mut builder = fs::DirBuilder::new();
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
    builder.create(&dir).map_err(|_| FAILED)?;
    Ok(dir)
}

async fn install(
    window: &WebviewWindow,
    entry: &Entry,
    install: &Install,
    anchor: &'static Target,
    target: &str,
    state: &Download,
) -> Result<(), &'static str> {
    let base = fresh_base(window, &entry.id)?;
    let result = async {
        let dir = private_dir(&base)?;
        let plan = Plan {
            id: &entry.id,
            name: &entry.name,
            target,
            format: &anchor.format,
            feed: install
                .feed
                .replace("{channel}", install.channel.as_deref().unwrap_or("stable")),
            hosts: &install.hosts,
            keys: &install.minisign_keys,
        };
        let file = fetch_verified(&plan, &dir, state).await?;
        let checked = file.clone();
        tauri::async_runtime::spawn_blocking(move || platform_check(&checked, anchor))
            .await
            .map_err(|_| FAILED)??;
        state.stage.store(2, Ordering::SeqCst);
        // The system's own handler: Finder mounts the disk image, Windows runs the signed
        // installer, Linux opens its package installer. Lifer never runs the program itself.
        window
            .app_handle()
            .opener()
            .open_path(file.to_string_lossy(), None::<&str>)
            .map_err(|_| BLOCKED)
    }
    .await;
    if result.is_err() {
        let _ = fs::remove_dir_all(&base);
    }
    result
}

/// Downloads, checks and opens one suggested app's installer. The page names only the app; every
/// address, key and signer comes from the compiled-in list. Errors are codes the page words.
#[tauri::command]
pub(crate) async fn plugin_install(window: WebviewWindow, app_id: String) -> Result<(), String> {
    if !crate::security::is_app_page(&window) {
        return Err("not allowed".into());
    }
    let target = this_target();
    let (entry, install_block, anchor) = resolve(entries(), &app_id, &target)?;
    #[cfg(target_os = "linux")]
    {
        // A package opens in the system's package installer; without one, use the website.
        let tool = if anchor.format == "deb" {
            "/usr/bin/dpkg"
        } else {
            "/usr/bin/rpm"
        };
        if !Path::new(tool).exists() {
            return Err(NO_INSTALLER.into());
        }
    }
    let state = begin(&window.state::<PluginInstalls>(), &app_id)?;
    let result = install(&window, entry, install_block, anchor, &target, &state).await;
    state.done.store(true, Ordering::SeqCst);
    result.map_err(String::from)
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
            stage: "downloading",
        },
        |d| InstallProgress {
            downloaded: d.downloaded.load(Ordering::SeqCst),
            total: d.total.load(Ordering::SeqCst),
            running: !d.done.load(Ordering::SeqCst),
            stage: match d.stage.load(Ordering::SeqCst) {
                0 => "downloading",
                1 => "verifying",
                _ => "opening",
            },
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

// ---- Finding a copy installed outside Lifer ----

/// `~/x` and a leading `%VAR%/x`, from the environment; anything not absolute after that is skipped.
fn expand(location: &str) -> Option<PathBuf> {
    let path = if let Some(rest) = location.strip_prefix("~/") {
        let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"))?;
        PathBuf::from(home).join(rest)
    } else if let Some(rest) = location.strip_prefix('%') {
        let (var, rest) = rest.split_once('%')?;
        PathBuf::from(std::env::var_os(var)?).join(rest.trim_start_matches(['/', '\\']))
    } else {
        PathBuf::from(location)
    };
    path.is_absolute().then_some(path)
}

/// The first listed program that exists, is a safe executable file, and (on macOS and Windows)
/// is signed by the pinned signer.
fn find_installed(locations: &[String], anchor: Option<&Target>) -> Option<PathBuf> {
    locations.iter().filter_map(|l| expand(l)).find_map(|path| {
        let real = fs::canonicalize(path).ok()?;
        let meta = fs::metadata(&real).ok()?;
        if !meta.is_file() {
            return None;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if meta.permissions().mode() & 0o111 == 0 {
                return None;
            }
        }
        crate::plugins::check_file_safety(&real).ok()?;
        #[cfg(any(target_os = "macos", windows))]
        {
            let anchor = anchor?;
            let expected = anchor
                .signer
                .as_deref()
                .filter(|s| !s.contains(PLACEHOLDER))?;
            let found = crate::plugins::signer_of(&real)?;
            if !signer_matches(&found, expected, &anchor.issuers) {
                return None;
            }
        }
        #[cfg(not(any(target_os = "macos", windows)))]
        let _ = anchor;
        Some(real)
    })
}

fn installed_copy(app_id: &str) -> Option<PathBuf> {
    let entry = entries().iter().find(|e| e.id == app_id)?;
    let install = entry.install.as_ref()?;
    let locations = install.locations.get(this_os_key())?;
    find_installed(locations, install.platforms.get(&this_target()))
}

/// Where a verified copy installed outside Lifer is, so the page says "Already installed".
#[tauri::command]
pub(crate) async fn plugin_detect(
    window: WebviewWindow,
    app_id: String,
) -> Result<Option<String>, String> {
    if !crate::security::is_app_page(&window) {
        return Err("not allowed".into());
    }
    let found = tauri::async_runtime::spawn_blocking(move || installed_copy(&app_id))
        .await
        .map_err(|e| e.to_string())?;
    Ok(found.map(|p| crate::plugins::display_path(&p.to_string_lossy())))
}

/// Opens a copy installed outside Lifer the way the system would. It writes its own manifest on
/// first run; Lifer then opens it with the host hand-off.
#[tauri::command]
pub(crate) async fn plugin_open_installed(
    window: WebviewWindow,
    app_id: String,
) -> Result<(), String> {
    if !crate::security::is_app_page(&window) {
        return Err("not allowed".into());
    }
    let exe = tauri::async_runtime::spawn_blocking(move || installed_copy(&app_id))
        .await
        .map_err(|e| e.to_string())?
        .ok_or(NO_INSTALLER)?;
    // A macOS app opens by its bundle, so it starts as a normal app rather than a bare program.
    let bundle = exe
        .ancestors()
        .find(|a| a.extension().is_some_and(|x| x == "app"));
    match bundle {
        Some(bundle) => window
            .app_handle()
            .opener()
            .open_path(bundle.to_string_lossy(), None::<&str>)
            .map_err(|_| BLOCKED.to_string()),
        None => std::process::Command::new(&exe)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .map(|_| ())
            .map_err(|_| BLOCKED.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // A test-only key pair made once with openssl; the secret halves were never kept.
    const KEY_A: &str = "RWQBAgMEBQYHCP30LS0HOc4ntGcRhnKuikypTruGwm0LEMUORx2Mhs/x";
    const SIG_A: &str = "untrusted comment: test\nRUQBAgMEBQYHCCHoJqvw4yJc91wonZqgthv8beI/SnRk+e8CP8bmQMp3VeG/OpQRkOA2BTFAdtyWnSCswTwuq24zVNqjzcPTvwI=\ntrusted comment: id:com.example.app target:linux-x86_64 version:1.0.0\nMFYSNH6K8ArKFu7LVa2d7BN2HXGcyK3wqp+qVwRVHZCAGObUsYQreB0Oh3xpypxQPRkqplYLJBuFeh3gtdIFBQ==";
    // The same bytes and comment, signed by another key.
    const SIG_B: &str = "untrusted comment: test\nRUQJCgsMDQ4PEHUdR8RKjvCnYJ36Thuvr6Pb9ysDlAdb4gv54eeyXazReu/7IEAIEa0RFGVQC2o368WzgQ7TFaSBt7gu0bSXlws=\ntrusted comment: id:com.example.app target:linux-x86_64 version:1.0.0\nqT1Q12wqL+2J7MXCBfd/eEpIx1qpQ51xdAmYQEw48oTX7JMz2KsMPXCjnzg6knOfQshUiCuaiNQW6AKFWf/tBw==";
    const SHA: &str = "b50bf7a25768a3f69353f23e7430493816445571026bb49b12567c9f5cff291a";
    const TARGET: &str = "linux-x86_64";

    fn fixture() -> Vec<u8> {
        b"lifer fixture installer\n".repeat(100)
    }

    fn ok(body: &[u8], kind: &str) -> Vec<u8> {
        let mut r = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: {kind}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        )
        .into_bytes();
        r.extend_from_slice(body);
        r
    }

    type Routes = Arc<Mutex<HashMap<String, Vec<u8>>>>;

    /// Serves fixed responses by path on localhost; routes can be added once the port is known.
    fn serve() -> (u16, Routes) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let routes: Routes = Arc::default();
        let served = routes.clone();
        std::thread::spawn(move || {
            for mut s in listener.incoming().flatten() {
                use std::io::Read;
                let mut req = [0u8; 4096];
                let n = s.read(&mut req).unwrap_or(0);
                let req = String::from_utf8_lossy(&req[..n]);
                let path = req.split_whitespace().nth(1).unwrap_or("").to_string();
                let answer = lock(&served).get(&path).cloned().unwrap_or_else(|| {
                    b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                        .to_vec()
                });
                let _ = s.write_all(&answer);
            }
        });
        (port, routes)
    }

    fn feed(port: u16, path: &str, size: usize, sha: &str, sig: &str, version: &str) -> Vec<u8> {
        let body = serde_json::json!({ "installers": { TARGET: {
            "version": version, "format": "deb",
            "url": format!("http://localhost:{port}{path}"),
            "size": size, "sha256": sha, "minisign": sig,
        }}});
        ok(body.to_string().as_bytes(), "application/json")
    }

    struct Run {
        result: Result<PathBuf, &'static str>,
        dir: PathBuf,
    }

    /// One install against a fixture server whose feed is built by `make_feed(port)`.
    fn run(name: &str, extra: Vec<(&str, Vec<u8>)>, make_feed: impl Fn(u16) -> Vec<u8>) -> Run {
        let (port, routes) = serve();
        {
            let mut r = lock(&routes);
            r.extend(extra.into_iter().map(|(p, a)| (p.to_string(), a)));
            r.insert("/feed.json".into(), make_feed(port));
        }
        let dir = std::env::temp_dir().join(format!("lifer-install-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let hosts = vec!["localhost".to_string()];
        let keys = vec![KEY_A.to_string()];
        let plan = Plan {
            id: "com.example.app",
            name: "Example",
            target: TARGET,
            format: "deb",
            feed: format!("http://localhost:{port}/feed.json"),
            hosts: &hosts,
            keys: &keys,
        };
        let state = Download::default();
        let result = tauri::async_runtime::block_on(fetch_verified(&plan, &dir, &state));
        Run { result, dir }
    }

    fn installer() -> (&'static str, Vec<u8>) {
        ("/Example.deb", ok(&fixture(), "application/octet-stream"))
    }

    fn refused(run: Run, code: &str) {
        assert_eq!(run.result.as_ref().err().copied(), Some(code));
        assert!(!run.dir.exists(), "a failed install leaves nothing behind");
    }

    #[test]
    fn a_signed_matching_installer_is_kept_under_the_apps_name() {
        let r = run("good", vec![installer()], |p| {
            feed(p, "/Example.deb", 2400, SHA, SIG_A, "1.0.0")
        });
        let file = r.result.unwrap();
        assert_eq!(file.file_name().unwrap(), "Example.deb");
        assert_eq!(fs::read(&file).unwrap(), fixture());
        assert!(!r.dir.join("download.part").exists());
        fs::remove_dir_all(r.dir).unwrap();
    }

    #[test]
    fn a_wrong_hash_is_refused() {
        let bad = "0".repeat(64);
        refused(
            run("hash", vec![installer()], |p| {
                feed(p, "/Example.deb", 2400, &bad, SIG_A, "1.0.0")
            }),
            VERIFICATION,
        );
    }

    #[test]
    fn a_signature_from_another_key_is_refused() {
        refused(
            run("otherkey", vec![installer()], |p| {
                feed(p, "/Example.deb", 2400, SHA, SIG_B, "1.0.0")
            }),
            VERIFICATION,
        );
    }

    #[test]
    fn tampered_bytes_fail_the_signature_even_with_a_matching_hash_and_size() {
        let mut bytes = fixture();
        bytes[0] = b'L';
        use sha2::Digest;
        let sha: String = sha2::Sha256::digest(&bytes)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        refused(
            run(
                "tampered",
                vec![("/Example.deb", ok(&bytes, "application/octet-stream"))],
                move |p| feed(p, "/Example.deb", 2400, &sha, SIG_A, "1.0.0"),
            ),
            VERIFICATION,
        );
    }

    #[test]
    fn a_signed_comment_for_another_version_is_refused() {
        refused(
            run("version", vec![installer()], |p| {
                feed(p, "/Example.deb", 2400, SHA, SIG_A, "1.0.1")
            }),
            VERIFICATION,
        );
    }

    #[test]
    fn an_installer_on_a_host_not_in_the_list_is_refused() {
        refused(
            run("host", vec![], |_| {
                let body = serde_json::json!({ "installers": { TARGET: {
                    "version": "1.0.0", "format": "deb", "url": "http://elsewhere.test/Example.deb",
                    "size": 2400, "sha256": SHA, "minisign": SIG_A,
                }}});
                ok(body.to_string().as_bytes(), "application/json")
            }),
            VERIFICATION,
        );
    }

    #[test]
    fn a_redirect_to_another_host_is_refused() {
        let redirect = |p: u16| {
            format!("HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:{p}/Example.deb\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").into_bytes()
        };
        let (other, other_routes) = serve();
        lock(&other_routes).extend([installer()].map(|(p, r)| (p.to_string(), r)));
        refused(
            run("redirect", vec![("/go", redirect(other))], |p| {
                feed(p, "/go", 2400, SHA, SIG_A, "1.0.0")
            }),
            VERIFICATION,
        );
    }

    #[test]
    fn more_bytes_than_signed_are_refused_and_an_oversized_size_never_downloads() {
        let mut long = fixture();
        long.extend_from_slice(b"extra");
        let mut answer =
            b"HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nConnection: close\r\n\r\n"
                .to_vec();
        answer.extend_from_slice(&long);
        refused(
            run("long", vec![("/Example.deb", answer)], |p| {
                feed(p, "/Example.deb", 2400, SHA, SIG_A, "1.0.0")
            }),
            VERIFICATION,
        );
        let huge = MAX_INSTALLER_BYTES as usize + 1;
        refused(
            run("huge", vec![installer()], move |p| {
                feed(p, "/Example.deb", huge, SHA, SIG_A, "1.0.0")
            }),
            TOO_LARGE,
        );
    }

    #[test]
    fn a_truncated_download_is_refused() {
        let mut answer = b"HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nConnection: close\r\n\r\n".to_vec();
        answer.extend_from_slice(&fixture()[..1000]);
        let r = run("short", vec![("/Example.deb", answer)], |p| {
            feed(p, "/Example.deb", 2400, SHA, SIG_A, "1.0.0")
        });
        refused(r, VERIFICATION);
    }

    #[test]
    fn a_feed_without_this_computers_installer_points_to_the_website() {
        refused(
            run("nofeed", vec![], |_| {
                ok(b"{\"version\":\"1.0.0\"}", "application/json")
            }),
            NO_INSTALLER,
        );
    }

    #[test]
    fn concurrent_installs_of_the_same_app_are_refused() {
        let installs = PluginInstalls::default();
        let first = begin(&installs, "com.example.app").unwrap();
        assert_eq!(begin(&installs, "com.example.app").err(), Some(BUSY));
        assert!(begin(&installs, "com.example.other").is_ok());
        first.done.store(true, Ordering::SeqCst);
        assert!(begin(&installs, "com.example.app").is_ok());
    }

    fn entry_json(signer: &str, keys: &str, pending: bool) -> Vec<Entry> {
        serde_json::from_str(&format!(
            r#"[{{"id":"com.example.app","name":"Example","install":{{
                "feed":"https://dl.example.com/{{channel}}/latest.json","hosts":["dl.example.com"],
                "minisignKeys":["{keys}"],"pending":{pending},
                "platforms":{{"darwin-aarch64":{{"format":"dmg","signer":"{signer}"}},
                              "linux-x86_64":{{"format":"deb"}},
                              "linux-aarch64":{{"format":"appimage"}}}}}}}}]"#
        ))
        .unwrap()
    }

    #[test]
    fn a_placeholder_or_pending_anchor_refuses_to_install() {
        let list = entry_json("PLACEHOLDER", KEY_A, false);
        assert_eq!(
            resolve(&list, "com.example.app", "darwin-aarch64").err(),
            Some(NOT_SET_UP)
        );
        let list = entry_json("ABCDE12345", "PLACEHOLDER", false);
        assert_eq!(
            resolve(&list, "com.example.app", "linux-x86_64").err(),
            Some(NOT_SET_UP)
        );
        let list = entry_json("ABCDE12345", KEY_A, true);
        assert_eq!(
            resolve(&list, "com.example.app", "linux-x86_64").err(),
            Some(NOT_SET_UP)
        );
        let list = entry_json("ABCDE12345", KEY_A, false);
        assert!(resolve(&list, "com.example.app", "darwin-aarch64").is_ok());
        assert!(resolve(&list, "com.example.app", "linux-x86_64").is_ok());
        // An AppImage would have to be run by Lifer, so it never installs from here.
        assert_eq!(
            resolve(&list, "com.example.app", "linux-aarch64").err(),
            Some(NO_INSTALLER)
        );
        assert_eq!(
            resolve(&list, "com.example.app", "windows-x86_64").err(),
            Some(NO_INSTALLER)
        );
        assert_eq!(
            resolve(&list, "com.example.unknown", "linux-x86_64").err(),
            Some(NO_INSTALLER)
        );
    }

    // The build guard: the shipped list parses, and a live entry has real, well-formed anchors.
    #[test]
    fn the_compiled_in_suggestions_are_well_formed() {
        let list: Vec<Entry> = serde_json::from_str(SUGGESTED_APPS).expect("suggestedApps.json");
        assert_eq!(entries().len(), list.len());
        for e in &list {
            let Some(i) = &e.install else { continue };
            assert!(!i.hosts.is_empty(), "{}: hosts", e.id);
            assert!(
                allowed(&i.feed.replace("{channel}", "stable"), &i.hosts).is_some()
                    && i.feed.starts_with("https://"),
                "{}: the feed must be https on a listed host",
                e.id
            );
            for (target, t) in &i.platforms {
                assert!(
                    extension(target, &t.format).is_some() || t.format == "appimage",
                    "{}: {target} format {}",
                    e.id,
                    t.format
                );
            }
            if i.pending {
                continue;
            }
            assert!(
                !has_placeholder(i, None)
                    && i.platforms.values().all(|t| !has_placeholder(i, Some(t))),
                "{}: still has PLACEHOLDER values",
                e.id
            );
            assert!(!i.minisign_keys.is_empty(), "{}: no minisign key", e.id);
            for k in &i.minisign_keys {
                assert!(
                    minisign_verify::PublicKey::from_base64(k).is_ok(),
                    "{}: bad key {k}",
                    e.id
                );
            }
        }
    }

    #[test]
    fn only_plain_addresses_on_listed_hosts_are_allowed() {
        let hosts = vec!["dl.example.com".to_string()];
        assert!(allowed("https://dl.example.com/a.dmg", &hosts).is_some());
        assert!(allowed("https://DL.example.com/a.dmg", &hosts).is_some());
        for bad in [
            "https://evil.example.com/a.dmg",
            "https://dl.example.com.evil.test/a.dmg",
            "https://127.0.0.1/a.dmg",
            "https://user:pw@dl.example.com/a.dmg",
            "https://dl.example.com/a.dmg#x",
            "file:///etc/passwd",
            "nonsense",
        ] {
            assert!(allowed(bad, &hosts).is_none(), "{bad}");
        }
    }

    #[test]
    fn signers_pin_the_subject_and_optionally_the_issuer() {
        assert!(signer_matches("ABCDE12345", "ABCDE12345", &[]));
        assert!(!signer_matches("ZZZZZ99999", "ABCDE12345", &[]));
        let win = "CN=Example Ltd, O=Example Ltd\nissued by CN=Some CA 03";
        assert!(signer_matches(win, "CN=Example Ltd, O=Example Ltd", &[]));
        assert!(signer_matches(
            win,
            "CN=Example Ltd, O=Example Ltd",
            &["CN=Some CA 03".into()]
        ));
        assert!(!signer_matches(
            win,
            "CN=Example Ltd, O=Example Ltd",
            &["CN=Other CA".into()]
        ));
        assert!(!signer_matches(win, "CN=Example", &[]));
    }

    #[test]
    fn the_signed_comment_must_name_app_target_and_version() {
        let c = "timestamp:1 id:com.example.app target:linux-x86_64 version:1.0.0";
        assert!(comment_matches(c, "com.example.app", TARGET, "1.0.0"));
        assert!(!comment_matches(c, "com.example.other", TARGET, "1.0.0"));
        assert!(!comment_matches(
            c,
            "com.example.app",
            "darwin-aarch64",
            "1.0.0"
        ));
        assert!(!comment_matches(c, "com.example.app", TARGET, "1.0"));
        assert!(!comment_matches(
            "idx:com.example.app",
            "com.example.app",
            TARGET,
            "1.0.0"
        ));
    }

    #[cfg(unix)]
    #[test]
    fn finds_a_safe_executable_at_a_listed_place() {
        use std::os::unix::fs::PermissionsExt;
        let dir = fs::canonicalize(std::env::temp_dir())
            .unwrap()
            .join(format!("lifer-detect-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let exe = dir.join("app");
        fs::write(&exe, b"#!/bin/sh\n").unwrap();
        let locations = vec!["relative/app".to_string(), exe.display().to_string()];
        fs::set_permissions(&exe, fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(find_installed(&locations, None), None, "not executable");
        fs::set_permissions(&exe, fs::Permissions::from_mode(0o755)).unwrap();
        // macOS needs the pinned signer, which an unsigned test file never has.
        let expected = (!cfg!(target_os = "macos")).then(|| exe.clone());
        assert_eq!(find_installed(&locations, None), expected);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn locations_expand_home_and_variables() {
        std::env::set_var("LIFER_TEST_PROGRAMS", std::env::temp_dir());
        assert_eq!(
            expand("%LIFER_TEST_PROGRAMS%/Example/app.exe"),
            Some(std::env::temp_dir().join("Example/app.exe"))
        );
        assert_eq!(expand("%LIFER_TEST_UNSET_VAR%/x"), None);
        assert_eq!(expand("relative/x"), None);
        assert!(expand("~/Applications/Example.app").is_some_and(|p| p.is_absolute()));
    }
}
