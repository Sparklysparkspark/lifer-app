// Companion app discovery: each installed app drops one JSON manifest into <app data>/plugins/.
// The folder is rescanned every few seconds so installs and removals show up without a restart.
// Approval is pinned to the code signer (or the file's hash when unsigned), and the second half of
// this file launches, watches and stops the approved app's process.
use crate::fsutil::write_atomic;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fs;
use std::io::BufRead;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime};
use tauri::{AppHandle, Manager, WebviewWindow};

const SCAN_EVERY: Duration = Duration::from_secs(5);
const CAPABILITIES: [&str; 6] = [
    "pickers",
    "notifications",
    "imports",
    "offersImports",
    "background",
    "host.preference",
];
const APPROVALS_FILE: &str = "plugin-approvals.json";
// Manifests are a few hundred bytes; the cap keeps a stray huge file from eating memory each pass.
const MAX_MANIFEST_BYTES: u64 = 64 * 1024;

#[derive(Debug, Clone, Deserialize)]
struct Executables {
    darwin: Option<String>,
    win32: Option<String>,
    linux: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PluginPage {
    pub label: String,
    pub icon: String,
    pub accent: String,
    pub surface: String,
}

#[derive(Debug, Clone, Deserialize)]
struct Manifest {
    schema: u32,
    id: String,
    name: String,
    publisher: String,
    homepage: String,
    support: String,
    version: String,
    executable: Executables,
    protocol: Vec<u32>,
    page: PluginPage,
    scopes: Vec<String>,
    #[serde(default)]
    capabilities: Vec<String>,
}

/// A validated plugin. `executable` is the path for this OS.
#[derive(Debug, Clone, PartialEq)]
pub struct Plugin {
    pub id: String,
    pub name: String,
    pub page: PluginPage,
    pub scopes: Vec<String>,
    pub capabilities: Vec<String>,
    pub executable: String,
    /// Who signed the executable, worked out in the background; None until known or unreadable.
    pub identity: Option<Identity>,
}

/// What an approval is pinned to: a verified code signer, or the file's SHA-256 when unsigned.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Identity {
    Signer(String),
    Sha256(String),
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct PluginSummary {
    pub id: String,
    pub name: String,
    pub page: PluginPage,
    pub scopes: Vec<String>,
    /// The host protocol allowlists messages by these (pluginHost.ts).
    pub capabilities: Vec<String>,
    pub approved: bool,
}

fn is_https_url(s: &str) -> bool {
    url::Url::parse(s).is_ok_and(|u| u.scheme() == "https" && u.host_str().is_some())
}

// Reverse DNS: at least two dot-separated labels of letters, digits and hyphens.
fn is_valid_id(id: &str) -> bool {
    let labels: Vec<&str> = id.split('.').collect();
    labels.len() >= 2
        && labels.iter().all(|l| {
            !l.is_empty()
                && !l.starts_with('-')
                && !l.ends_with('-')
                && l.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
        })
}

fn executable_for_this_os(e: &Executables) -> Option<&str> {
    if cfg!(target_os = "macos") {
        e.darwin.as_deref()
    } else if cfg!(target_os = "windows") {
        e.win32.as_deref()
    } else {
        e.linux.as_deref()
    }
}

fn validate(m: Manifest) -> Result<Plugin, String> {
    if m.schema != 1 {
        return Err(format!("unsupported schema {}", m.schema));
    }
    if !is_valid_id(&m.id) {
        return Err(format!("invalid id {:?}", m.id));
    }
    if [
        &m.name,
        &m.version,
        &m.page.label,
        &m.page.icon,
        &m.page.accent,
    ]
    .iter()
    .any(|s| s.trim().is_empty())
    {
        return Err("name, version and page fields can't be empty".into());
    }
    // An app named after Lifer could pass for part of it in the sidebar or a consent dialog.
    if [&m.name, &m.page.label]
        .iter()
        .any(|s| s.trim().eq_ignore_ascii_case("lifer"))
    {
        return Err("name and page.label can't be Lifer".into());
    }
    for (field, url) in [
        ("publisher", &m.publisher),
        ("homepage", &m.homepage),
        ("support", &m.support),
    ] {
        if !is_https_url(url) {
            return Err(format!("{field} must be an https URL"));
        }
    }
    if m.protocol.is_empty() {
        return Err("protocol must list at least one version".into());
    }
    if !["default", "dark"].contains(&m.page.surface.as_str()) {
        return Err(format!(
            "page.surface must be default or dark, got {:?}",
            m.page.surface
        ));
    }
    if m.scopes.iter().any(|s| s.trim().is_empty()) {
        return Err("empty scope".into());
    }
    // A capability from a newer Lifer is dropped, not fatal, so the app still shows here.
    let (capabilities, unknown): (Vec<String>, Vec<String>) = m
        .capabilities
        .into_iter()
        .partition(|c| CAPABILITIES.contains(&c.as_str()));
    log_unknown_capabilities(&m.id, &unknown);
    let exe = executable_for_this_os(&m.executable).ok_or("no executable for this OS")?;
    if !Path::new(exe).is_absolute() {
        return Err("executable must be an absolute path".into());
    }
    // The real file, so approval follows what actually runs, not a symlink that can be repointed.
    let real = fs::canonicalize(exe).map_err(|_| format!("executable not found: {exe}"))?;
    let meta = fs::metadata(&real).map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err(format!("executable not found: {exe}"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if meta.permissions().mode() & 0o111 == 0 {
            return Err(format!("not executable: {exe}"));
        }
    }
    let executable = real
        .to_str()
        .ok_or("executable path isn't valid UTF-8")?
        .to_string();
    Ok(Plugin {
        id: m.id,
        name: m.name,
        page: m.page,
        scopes: m.scopes,
        capabilities,
        executable,
        identity: None,
    })
}

/// Notes each dropped capability once per run; the folder is rescanned every few seconds.
fn log_unknown_capabilities(id: &str, unknown: &[String]) {
    static LOGGED: Mutex<BTreeSet<String>> = Mutex::new(BTreeSet::new());
    let Ok(mut logged) = LOGGED.lock() else {
        return;
    };
    for c in unknown {
        if logged.insert(format!("{id}\n{c}")) && cfg!(debug_assertions) {
            eprintln!("[lifer] plugin {id}: ignoring unknown capability {c:?}");
        }
    }
}

/// Reads every manifest in `dir`. Returns the valid plugins (first file by name wins a duplicate
/// id) and one message per skipped file.
fn scan(dir: &Path) -> (Vec<Plugin>, BTreeSet<String>) {
    let mut files: Vec<PathBuf> = fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "json"))
        .collect();
    files.sort();
    let (mut plugins, mut skipped, mut seen) = (Vec::new(), BTreeSet::new(), HashSet::new());
    for path in files {
        let name = path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned();
        let parsed = read_manifest(&path).and_then(validate);
        match parsed {
            Ok(p) if seen.insert(p.id.clone()) => plugins.push(p),
            Ok(p) => {
                skipped.insert(format!("{name}: duplicate id {}", p.id));
            }
            Err(e) => {
                skipped.insert(format!("{name}: {e}"));
            }
        }
    }
    (plugins, skipped)
}

// Only regular files under the size cap; a FIFO or device would hang or flood the scan.
fn read_manifest(path: &Path) -> Result<Manifest, String> {
    let meta = fs::metadata(path).map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err("not a regular file".into());
    }
    if meta.len() > MAX_MANIFEST_BYTES {
        return Err(format!("larger than {MAX_MANIFEST_BYTES} bytes"));
    }
    let mut text = String::new();
    std::io::Read::read_to_string(
        &mut std::io::Read::take(
            fs::File::open(path).map_err(|e| e.to_string())?,
            MAX_MANIFEST_BYTES,
        ),
        &mut text,
    )
    .map_err(|e| e.to_string())?;
    serde_json::from_str(&text).map_err(|e| e.to_string())
}

// Approvals map plugin id to the identity the user approved, in their own file so the connection
// config's rewrites never drop them. The path isn't part of it, so an app that updates in place
// (or moves) keeps its approval while its signer stays the same.
fn read_approvals(app_data_dir: &Path) -> BTreeMap<String, Identity> {
    fs::read_to_string(app_data_dir.join(APPROVALS_FILE))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub(crate) fn approve(app_data_dir: &Path, id: &str, identity: &Identity) -> std::io::Result<()> {
    // Two approvals at once must not drop each other's entry.
    static APPROVALS: Mutex<()> = Mutex::new(());
    let _guard = lock(&APPROVALS);
    let mut approvals = read_approvals(app_data_dir);
    approvals.insert(id.to_string(), identity.clone());
    write_atomic(
        &app_data_dir.join(APPROVALS_FILE),
        serde_json::to_string_pretty(&approvals)?.as_bytes(),
        None,
    )
}

fn summarize(plugins: &[Plugin], approvals: &BTreeMap<String, Identity>) -> Vec<PluginSummary> {
    plugins
        .iter()
        .map(|p| PluginSummary {
            id: p.id.clone(),
            name: p.name.clone(),
            page: p.page.clone(),
            scopes: p.scopes.clone(),
            capabilities: p.capabilities.clone(),
            approved: p.identity.is_some() && approvals.get(&p.id) == p.identity.as_ref(),
        })
        .collect()
}

#[derive(Default)]
pub struct PluginRegistry {
    found: Mutex<Vec<Plugin>>,
}

impl PluginRegistry {
    #[allow(dead_code)]
    pub(crate) fn find(&self, id: &str) -> Option<Plugin> {
        self.found.lock().ok()?.iter().find(|p| p.id == id).cloned()
    }
}

/// Starts the rescan loop. Skipped manifests are logged once each, not every pass.
pub fn start_watching(app: &AppHandle) {
    let Ok(base) = app.path().app_data_dir() else {
        return;
    };
    let dir = base.join("plugins");
    let _ = fs::create_dir_all(&dir);
    let app = app.clone();
    std::thread::spawn(move || {
        let mut logged = BTreeSet::new();
        // Signature checks and hashes are slow on big apps, so redo them only when the file changes.
        let mut known: HashMap<String, (u64, SystemTime, Identity)> = HashMap::new();
        loop {
            let (mut plugins, skipped) = scan(&dir);
            for p in &mut plugins {
                let Some((len, modified)) = fs::metadata(&p.executable)
                    .ok()
                    .and_then(|m| Some((m.len(), m.modified().ok()?)))
                else {
                    continue;
                };
                p.identity = match known.get(&p.executable) {
                    Some((l, m, id)) if *l == len && *m == modified => Some(id.clone()),
                    _ => identify(Path::new(&p.executable)).ok(),
                };
                if let Some(id) = &p.identity {
                    known.insert(p.executable.clone(), (len, modified, id.clone()));
                }
            }
            for msg in skipped.difference(&logged) {
                eprintln!("[lifer] ignoring plugin manifest {msg}");
            }
            logged = skipped;
            if let Ok(mut found) = app.state::<PluginRegistry>().found.lock() {
                *found = plugins;
            }
            std::thread::sleep(SCAN_EVERY);
        }
    });
}

#[tauri::command]
pub(crate) fn plugins_list(window: WebviewWindow) -> Result<Vec<PluginSummary>, String> {
    // App pages only: is_trusted_sender would also pass a connected server's page.
    if !crate::security::is_app_page(&window) {
        return Err("not allowed".into());
    }
    let app = window.app_handle();
    let approvals = read_approvals(&crate::app_data_dir(app));
    let found = app
        .state::<PluginRegistry>()
        .found
        .lock()
        .map_err(|e| e.to_string())?
        .clone();
    Ok(summarize(&found, &approvals))
}

// ---- Identity: who signed the executable ----

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Windows' canonical paths carry a \\?\ prefix that means nothing to people.
pub(crate) fn display_path(path: &str) -> String {
    if let Some(unc) = path.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{unc}")
    } else {
        path.strip_prefix(r"\\?\").unwrap_or(path).to_string()
    }
}

/// The verified code signer of a file, or None when it isn't signed. Only the installer check calls it, and that check runs on macOS and Windows.
#[cfg(any(target_os = "macos", windows))]
pub(crate) fn signer_of(path: &Path) -> Option<String> {
    platform_signer(path)
}

/// The verified signer, or the SHA-256 for unsigned (and ad hoc signed) files and on Linux.
fn identify(path: &Path) -> Result<Identity, String> {
    if let Some(signer) = platform_signer(path) {
        return Ok(Identity::Signer(signer));
    }
    crate::embedded_db::sha256_file(path).map(Identity::Sha256)
}

// codesign -d prints "TeamIdentifier=ABCDE12345", or "TeamIdentifier=not set" for ad hoc code.
#[cfg(any(target_os = "macos", test))]
fn team_identifier(details: &str) -> Option<&str> {
    let team = details
        .lines()
        .find_map(|l| l.strip_prefix("TeamIdentifier="))?
        .trim();
    (!team.is_empty() && team.chars().all(|c| c.is_ascii_alphanumeric())).then_some(team)
}

// The Team ID counts only when the signature checks out and chains to Apple with that same Team
// ID in the leaf certificate, so a self-made certificate can't claim someone else's.
#[cfg(target_os = "macos")]
fn platform_signer(path: &Path) -> Option<String> {
    let details = Command::new(CODESIGN)
        .args(["-d", "--verbose=2"])
        .arg(path)
        .output()
        .ok()?;
    let team = team_identifier(&String::from_utf8_lossy(&details.stderr))?.to_string();
    Command::new(CODESIGN)
        .args([
            "--verify",
            "--strict",
            "--test-requirement",
            &team_requirement(&team),
        ])
        .arg(path)
        .stderr(Stdio::null())
        .status()
        .ok()?
        .success()
        .then_some(team)
}

#[cfg(target_os = "macos")]
const CODESIGN: &str = "/usr/bin/codesign";

#[cfg(target_os = "macos")]
fn team_requirement(team: &str) -> String {
    format!("=anchor apple generic and certificate leaf[subject.OU] = \"{team}\"")
}

/// Whether the launched process is still the approved code, not just the file it started from.
/// macOS checks the running code's signature by pid with the same requirement as approval.
#[cfg(target_os = "macos")]
fn running_matches(pid: u32, _exe: &Path, identity: &Identity) -> bool {
    match identity {
        Identity::Signer(team) => Command::new(CODESIGN)
            .args(["--verify", "--test-requirement", &team_requirement(team)])
            .arg(pid.to_string())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|s| s.success()),
        // shortcut: an unsigned app's running image isn't hashed, only its file just before launch
        // (which check_file_safety keeps other users from swapping); hash the image if that matters.
        Identity::Sha256(_) => true,
    }
}

// Windows can't replace a running program's file, so the file now is what runs.
#[cfg(windows)]
fn running_matches(_pid: u32, exe: &Path, identity: &Identity) -> bool {
    identify(exe).is_ok_and(|i| &i == identity)
}

// shortcut: Linux trusts the hash taken just before launch (/proc/<pid>/exe is the interpreter for
// script plugins); compare the image's hash for compiled plugins if that ever matters.
#[cfg(not(any(target_os = "macos", windows)))]
fn running_matches(_pid: u32, _exe: &Path, _identity: &Identity) -> bool {
    true
}

#[cfg(windows)]
fn platform_signer(path: &Path) -> Option<String> {
    win::authenticode_signer(path)
}

// Subject and issuer, so a certificate from another issuer with the same name doesn't match. The
// thumbprint isn't pinned, so a renewal from the same issuer keeps the approval. X.500 strings
// quote any value holding a newline, so the pair can't be faked by one long subject.
#[cfg(any(windows, test))]
fn signer_label(subject: &str, issuer: &str) -> String {
    format!("{subject}\nissued by {issuer}")
}

#[cfg(not(any(target_os = "macos", windows)))]
fn platform_signer(_path: &Path) -> Option<String> {
    None
}

/// Refuses a file another user could have swapped or changed.
#[cfg(unix)]
fn check_file_safety(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::MetadataExt;
    let shown = display_path(&path.to_string_lossy());
    let meta = fs::metadata(path).map_err(|_| format!("The app at {shown} is missing."))?;
    if meta.mode() & 0o002 != 0 {
        return Err(format!(
            "The app at {shown} can be changed by anyone on this computer, so Lifer won't open it."
        ));
    }
    // SAFETY: geteuid has no preconditions and can't fail.
    let me = unsafe { libc::geteuid() };
    if meta.uid() != me && meta.uid() != 0 {
        return Err(format!(
            "The app at {shown} belongs to another user, so Lifer won't open it."
        ));
    }
    // A folder another user can write to lets them swap the file between the check and the launch.
    // Sticky folders like /tmp only let owners rename their own entries.
    for dir in path.ancestors().skip(1) {
        let Ok(m) = fs::metadata(dir) else { continue };
        let open = m.mode() & 0o002 != 0 && m.mode() & 0o1000 == 0;
        if open || (m.uid() != me && m.uid() != 0) {
            return Err(format!(
                "The folder holding the app at {shown} can be changed by another user, so Lifer won't open it."
            ));
        }
    }
    Ok(())
}

// shortcut: Windows ACLs aren't inspected, the signer or hash pin still catches a swapped file.
#[cfg(not(unix))]
fn check_file_safety(_path: &Path) -> Result<(), String> {
    Ok(())
}

// ---- Launch and lifecycle ----

const START_TIMEOUT: Duration = Duration::from_secs(30);
const STOP_GRACE: Duration = Duration::from_secs(5);
const READY_PREFIX: &str = "LIFER_PLUGIN_READY ";
// Two missed checks in a row (about 20 s) before a plugin counts as crashed, so one busy moment
// doesn't restart it.
const MAX_HEALTH_MISSES: u8 = 2;
// The health answer is one short JSON object.
const MAX_HEALTH_BODY: usize = 4 * 1024;
const MAX_LINE: usize = 8 * 1024;

#[derive(Debug, PartialEq)]
struct Ready {
    port: u16,
    page: String,
    page_token: String,
}

fn parse_ready(line: &str) -> Option<Ready> {
    let rest = line.trim().strip_prefix(READY_PREFIX)?;
    let (mut port, mut page, mut page_token) = (None, None, None);
    for part in rest.split_whitespace() {
        match part.split_once('=')? {
            ("port", v) => port = v.parse::<u16>().ok().filter(|p| *p != 0),
            ("page", v) => page = Some(v),
            ("pageToken", v) => page_token = Some(v),
            _ => {}
        }
    }
    let page = page.filter(|p| p.starts_with('/') && !p.starts_with("//"))?;
    let page_token = page_token.filter(|t| {
        !t.is_empty()
            && t.len() <= 512
            && t.chars()
                .all(|c| c.is_ascii_alphanumeric() || "-_.~".contains(c))
    })?;
    Some(Ready {
        port: port?,
        page: page.to_string(),
        page_token: page_token.to_string(),
    })
}

/// Where the page loads from. The token stays out of `page_url` (history, logs, Referer); the web
/// app hands it to the page in the host protocol's `credential` message.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PluginEndpoint {
    pub origin: String,
    pub page_url: String,
    pub page_token: String,
}

fn endpoint_for(ready: &Ready) -> Option<PluginEndpoint> {
    let origin = format!("http://127.0.0.1:{}", ready.port);
    let url = url::Url::parse(&origin).ok()?.join(&ready.page).ok()?;
    // The page path must not move the frame to another host or port, and Lifer's own origin would
    // give the frame the app's privileges.
    if ready.port == crate::api::LOCAL_PORT
        || url.host_str() != Some("127.0.0.1")
        || url.port() != Some(ready.port)
    {
        return None;
    }
    Some(PluginEndpoint {
        origin,
        page_url: url.into(),
        page_token: ready.page_token.clone(),
    })
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PluginStatus {
    /// "stopped", "starting" or "running".
    pub state: &'static str,
    pub endpoint: Option<PluginEndpoint>,
    /// Why it stopped, in plain words, when it didn't stop on purpose.
    pub error: Option<String>,
}

/// A process Lifer started. Dropping stdin tells it Lifer is leaving.
struct Owned {
    child: Child,
    stdin: Option<ChildStdin>,
    // Closing the job kills the plugin and everything it started, even if Lifer is force-quit.
    #[cfg(windows)]
    _job: Option<win::Job>,
}

impl Owned {
    fn exited(&mut self) -> bool {
        !matches!(self.child.try_wait(), Ok(None))
    }

    /// Kills the process (and on Unix its process group) and reaps it.
    fn kill(mut self) {
        if !self.exited() {
            #[cfg(unix)]
            // SAFETY: the child hasn't been reaped, so its pid (and group id) is still ours.
            unsafe {
                libc::killpg(self.child.id() as libc::pid_t, libc::SIGKILL);
            }
            let _ = self.child.kill();
        }
        let _ = self.child.wait();
    }
}

/// Closes every stdin, waits up to `grace` for them all to exit, then kills what's left.
fn stop_processes(mut owned: Vec<Owned>, grace: Duration) {
    owned.iter_mut().for_each(|o| drop(o.stdin.take()));
    let deadline = Instant::now() + grace;
    while Instant::now() < deadline && owned.iter_mut().any(|o| !o.exited()) {
        std::thread::sleep(Duration::from_millis(50));
    }
    owned.into_iter().for_each(Owned::kill);
}

struct Running {
    generation: u64,
    plugin: Plugin,
    data_dir: PathBuf,
    // None once attached to an instance the plugin runs itself.
    process: Option<Owned>,
    endpoint: PluginEndpoint,
    // Health checks prove it; pairing (L-08) checks it too.
    ticket: String,
}

enum State {
    Stopped(Option<String>),
    Starting,
    Running(Box<Running>),
}

struct Slot {
    state: State,
    // The one automatic restart has been used; a Restart by the user resets it.
    restarted: bool,
    misses: u8,
}

impl Default for Slot {
    fn default() -> Self {
        Slot {
            state: State::Stopped(None),
            restarted: false,
            misses: 0,
        }
    }
}

/// Asks the user to allow a plugin with this identity; true when they do.
type Ask = Arc<dyn Fn(&Plugin, &Identity) -> bool + Send + Sync>;

struct HostInner {
    slots: Mutex<HashMap<String, Slot>>,
    // Bumped per launch, so a stale exit or health miss can't touch a newer process.
    generation: AtomicU64,
    quitting: AtomicBool,
    start_timeout: Duration,
    stop_grace: Duration,
}

#[derive(Clone)]
pub struct PluginHost(Arc<HostInner>);

impl Default for PluginHost {
    fn default() -> Self {
        Self::with_timing(START_TIMEOUT, STOP_GRACE)
    }
}

const NOT_APPROVED: &str = "You didn't allow this app to open.";

impl PluginHost {
    fn with_timing(start_timeout: Duration, stop_grace: Duration) -> Self {
        PluginHost(Arc::new(HostInner {
            slots: Mutex::new(HashMap::new()),
            generation: AtomicU64::new(0),
            quitting: AtomicBool::new(false),
            start_timeout,
            stop_grace,
        }))
    }

    /// Starts the plugin unless it's already running, asking first when its identity isn't the
    /// approved one. A call made while another is starting it waits for that start. Without `ask`
    /// it's a background start: it never asks, and a failure leaves no error, so the user's own
    /// open starts it normally.
    async fn start(
        &self,
        plugin: Plugin,
        data_dir: PathBuf,
        ask: Option<Ask>,
    ) -> Result<PluginEndpoint, String> {
        let mut waited = false;
        loop {
            {
                let mut slots = lock(&self.0.slots);
                let slot = slots.entry(plugin.id.clone()).or_default();
                match &slot.state {
                    State::Running(r) => return Ok(r.endpoint.clone()),
                    State::Stopped(Some(e)) if waited => return Err(e.clone()),
                    State::Starting => {}
                    State::Stopped(_) => {
                        *slot = Slot {
                            state: State::Starting,
                            ..Slot::default()
                        };
                        break;
                    }
                }
            }
            waited = true;
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        let background = ask.is_none();
        let result = self.verify_and_launch(&plugin, &data_dir, ask).await;
        self.install(plugin, result, background)
    }

    async fn verify_and_launch(
        &self,
        plugin: &Plugin,
        data_dir: &Path,
        ask: Option<Ask>,
    ) -> Result<Running, String> {
        let exe = PathBuf::from(&plugin.executable);
        let identity = tauri::async_runtime::spawn_blocking(move || {
            check_file_safety(&exe)?;
            identify(&exe)
        })
        .await
        .map_err(|e| e.to_string())??;
        if read_approvals(data_dir).get(&plugin.id) != Some(&identity) {
            // An automatic restart never asks; the user reviews the change on their next open.
            let ask = ask.ok_or_else(|| {
                format!(
                    "{} has changed since you allowed it. Open it again to review.",
                    plugin.name
                )
            })?;
            let (p, i) = (plugin.clone(), identity.clone());
            let allowed = tauri::async_runtime::spawn_blocking(move || ask(&p, &i))
                .await
                .unwrap_or(false);
            if !allowed {
                return Err(NOT_APPROVED.into());
            }
            approve(data_dir, &plugin.id, &identity)
                .map_err(|e| format!("Couldn't save the approval: {e}"))?;
        }
        // A process spawned now could outlive Lifer's exit.
        if self.0.quitting.load(Ordering::SeqCst) {
            return Err("Lifer is quitting.".into());
        }
        let generation = self.0.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let (mut process, endpoint, ticket) = launch(plugin, self.0.start_timeout).await?;
        // Before READY's ticket is trusted for pairing. Checked while the child is unreaped, so its
        // pid can't belong to another process yet. A launcher that already handed off and exited
        // leaves nothing to check.
        let (pid, exe) = (process.child.id(), PathBuf::from(&plugin.executable));
        let matches =
            tauri::async_runtime::spawn_blocking(move || running_matches(pid, &exe, &identity))
                .await
                .unwrap_or(false);
        if !matches && !process.exited() {
            tauri::async_runtime::spawn_blocking(move || process.kill());
            return Err(format!(
                "{} isn't the app you allowed, so Lifer stopped it.",
                plugin.name
            ));
        }
        Ok(Running {
            generation,
            plugin: plugin.clone(),
            data_dir: data_dir.to_path_buf(),
            process: Some(process),
            endpoint,
            ticket,
        })
    }

    fn install(
        &self,
        plugin: Plugin,
        result: Result<Running, String>,
        background: bool,
    ) -> Result<PluginEndpoint, String> {
        let mut slots = lock(&self.0.slots);
        let slot = slots.entry(plugin.id.clone()).or_default();
        match result {
            Ok(running) if self.0.quitting.load(Ordering::SeqCst) => {
                drop(slots);
                running.process.into_iter().for_each(Owned::kill);
                Err("Lifer is quitting.".into())
            }
            Ok(running) => {
                share_ticket(&running.plugin, &running.ticket, true);
                let endpoint = running.endpoint.clone();
                let generation = running.generation;
                slot.state = State::Running(Box::new(running));
                drop(slots);
                self.watch(plugin.id, generation);
                Ok(endpoint)
            }
            Err(e) => {
                slot.state = State::Stopped((!background).then(|| e.clone()));
                Err(e)
            }
        }
    }

    /// Notices the launched process exiting. Exit code 0 with a healthy page means it handed off
    /// to an instance that was already running, without one the user closed it; anything else is
    /// a crash.
    fn watch(&self, id: String, generation: u64) {
        let host = self.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_millis(250)).await;
                let exit = {
                    let mut slots = lock(&host.0.slots);
                    let Some(r) = host.running_mut(&mut slots, &id, generation) else {
                        return;
                    };
                    let Some(owned) = r.process.as_mut() else {
                        return;
                    };
                    match owned.child.try_wait() {
                        Ok(None) => continue,
                        Ok(Some(status)) => Some((
                            status.success(),
                            r.endpoint.origin.clone(),
                            r.ticket.clone(),
                        )),
                        Err(_) => None,
                    }
                };
                if let Some((true, origin, ticket)) = &exit {
                    if health_ok(origin, ticket).await {
                        let mut slots = lock(&host.0.slots);
                        if let Some(r) = host.running_mut(&mut slots, &id, generation) {
                            r.process = None;
                        }
                    } else {
                        host.ended(&id, generation, false);
                    }
                    return;
                }
                host.ended(&id, generation, true);
                return;
            }
        });
    }

    fn running_mut<'a>(
        &self,
        slots: &'a mut HashMap<String, Slot>,
        id: &str,
        generation: u64,
    ) -> Option<&'a mut Running> {
        match &mut slots.get_mut(id)?.state {
            State::Running(r) if r.generation == generation => Some(r),
            _ => None,
        }
    }

    /// A crash restarts once; after that, or when the user closed the app, it stays stopped until
    /// the user restarts it.
    fn ended(&self, id: &str, generation: u64, crash: bool) {
        let mut slots = lock(&self.0.slots);
        let Some(slot) = slots.get_mut(id) else {
            return;
        };
        let State::Running(r) = &mut slot.state else {
            return;
        };
        if r.generation != generation {
            return;
        }
        let mut dead = r.process.take();
        // A failed check from a process that already exited cleanly is the user closing it. An
        // instance it handed off to isn't Lifer's child, so with no exit code to go on, it was closed.
        let crash = crash
            && dead
                .as_mut()
                .is_some_and(|o| !matches!(o.child.try_wait(), Ok(Some(s)) if s.success()));
        let (plugin, data_dir) = (r.plugin.clone(), r.data_dir.clone());
        share_ticket(&plugin, &r.ticket, false);
        let restart = crash && !slot.restarted && !self.0.quitting.load(Ordering::SeqCst);
        slot.misses = 0;
        slot.state = if restart {
            slot.restarted = true;
            State::Starting
        } else if crash {
            State::Stopped(Some(format!("{} stopped.", plugin.name)))
        } else {
            State::Stopped(Some(format!("{} was closed.", plugin.name)))
        };
        drop(slots);
        if let Some(owned) = dead {
            tauri::async_runtime::spawn_blocking(move || owned.kill());
        }
        if restart {
            eprintln!("[lifer] plugin {id} stopped, restarting it once");
            let host = self.clone();
            tauri::async_runtime::spawn(async move {
                let result = host.verify_and_launch(&plugin, &data_dir, None).await;
                let _ = host.install(plugin, result, false);
            });
        }
    }

    /// The page asks every 10 s while it's visible; that's also when health is checked.
    async fn status(&self, id: &str) -> PluginStatus {
        let running = match &lock(&self.0.slots).get(id).map(|s| &s.state) {
            Some(State::Running(r)) => {
                Some((r.generation, r.endpoint.origin.clone(), r.ticket.clone()))
            }
            _ => None,
        };
        if let Some((generation, origin, ticket)) = running {
            let healthy = health_ok(&origin, &ticket).await;
            let crashed = {
                let mut slots = lock(&self.0.slots);
                match slots.get_mut(id) {
                    Some(slot) if matches!(&slot.state, State::Running(r) if r.generation == generation) =>
                    {
                        slot.misses = if healthy { 0 } else { slot.misses + 1 };
                        slot.misses >= MAX_HEALTH_MISSES
                    }
                    _ => false,
                }
            };
            if crashed {
                self.ended(id, generation, true);
            }
        }
        match &lock(&self.0.slots).get(id).map(|s| &s.state) {
            Some(State::Running(r)) => PluginStatus {
                state: "running",
                endpoint: Some(r.endpoint.clone()),
                error: None,
            },
            Some(State::Starting) => PluginStatus {
                state: "starting",
                endpoint: None,
                error: None,
            },
            Some(State::Stopped(error)) => PluginStatus {
                state: "stopped",
                endpoint: None,
                error: error.clone(),
            },
            None => PluginStatus {
                state: "stopped",
                endpoint: None,
                error: None,
            },
        }
    }

    /// On quit: closes each launched plugin's stdin, gives them the grace period, then stops them.
    pub fn stop_all(&self) {
        self.0.quitting.store(true, Ordering::SeqCst);
        let owned: Vec<Owned> = lock(&self.0.slots)
            .values_mut()
            .filter_map(
                |slot| match std::mem::replace(&mut slot.state, State::Stopped(None)) {
                    State::Running(r) => r.process,
                    other => {
                        slot.state = other;
                        None
                    }
                },
            )
            .collect();
        stop_processes(owned, self.0.stop_grace);
    }
}

/// Healthy only when the answer proves the ticket, so another process on the port can't pass.
async fn health_ok(origin: &str, ticket: &str) -> bool {
    let Ok(nonce) = crate::local_inference::random_token() else {
        return false;
    };
    let Ok(client) = reqwest::Client::builder()
        .timeout(Duration::from_secs(3))
        .no_proxy()
        // A redirect could send Lifer's check to another host.
        .redirect(reqwest::redirect::Policy::none())
        .build()
    else {
        return false;
    };
    let Ok(mut response) = client
        .get(format!("{origin}/lifer-host/health?nonce={nonce}"))
        .send()
        .await
    else {
        return false;
    };
    let is_json = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(';').next())
        .is_some_and(|m| m.trim().eq_ignore_ascii_case("application/json"));
    if response.status() != reqwest::StatusCode::OK
        || !is_json
        || response
            .content_length()
            .is_some_and(|n| n > MAX_HEALTH_BODY as u64)
    {
        return false;
    }
    let mut body = Vec::new();
    loop {
        match response.chunk().await {
            Ok(Some(chunk)) if body.len() + chunk.len() <= MAX_HEALTH_BODY => {
                body.extend_from_slice(&chunk)
            }
            Ok(None) => break,
            _ => return false,
        }
    }
    #[derive(Deserialize)]
    struct Health {
        proof: String,
    }
    serde_json::from_slice::<Health>(&body).is_ok_and(|h| proof_matches(ticket, &nonce, &h.proof))
}

/// `proof` must be the lowercase hex HMAC-SHA256 of the nonce keyed with the ticket string.
fn proof_matches(ticket: &str, nonce: &str, proof: &str) -> bool {
    use hmac::{KeyInit, Mac};
    if proof.len() != 64
        || !proof
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
    {
        return false;
    }
    let bytes: Vec<u8> = (0..64)
        .step_by(2)
        .filter_map(|i| u8::from_str_radix(&proof[i..i + 2], 16).ok())
        .collect();
    let Ok(mut mac) = hmac::Hmac::<sha2::Sha256>::new_from_slice(ticket.as_bytes()) else {
        return false;
    };
    mac.update(nonce.as_bytes());
    mac.verify_slice(&bytes).is_ok()
}

/// A plugin prints READY once its server listens, but give it a moment before calling it broken.
async fn proves_ticket(origin: &str, ticket: &str) -> bool {
    for _ in 0..5 {
        if health_ok(origin, ticket).await {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    false
}

/// Gives the local API the SHA-256 of a launch's ticket for pairing (apps/api/src/plugins), or
/// withdraws it. Only to this launch's own API, since the call carries the launch credential.
fn share_ticket(plugin: &Plugin, ticket: &str, active: bool) {
    use sha2::Digest;
    let hash: String = sha2::Sha256::digest(ticket.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    let url = format!(
        "http://127.0.0.1:{}/api/plugins/v1/host-tickets/{}",
        crate::api::LOCAL_PORT,
        plugin.id
    );
    let body =
        serde_json::json!({ "ticketHash": hash, "name": plugin.name, "scopes": plugin.scopes });
    tauri::async_runtime::spawn(async move {
        if !crate::api::local_api_is_ours().await {
            return;
        }
        let Ok(client) = reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(5))
            .build()
        else {
            return;
        };
        let request = if active {
            client.put(url).json(&body)
        } else {
            client.delete(format!("{url}/{hash}"))
        };
        let _ = request
            .header(
                "x-lifer-launch-token",
                crate::local_credential::launch_token(),
            )
            .header("x-lifer-client", "1")
            .send()
            .await;
    });
}

/// Calls `f` for each line; longer lines are dropped (and logged once) so a plugin can't make
/// Lifer buffer without limit.
fn each_line(reader: impl std::io::Read, id: &str, mut f: impl FnMut(&str)) {
    use std::io::Read;
    let mut reader = std::io::BufReader::new(reader);
    let (mut buf, mut warned) = (Vec::new(), false);
    loop {
        buf.clear();
        match (&mut reader)
            .take(MAX_LINE as u64 + 1)
            .read_until(b'\n', &mut buf)
        {
            Ok(0) | Err(_) => return,
            Ok(n) if n > MAX_LINE && !buf.ends_with(b"\n") => {
                if reader.skip_until(b'\n').is_err() {
                    return;
                }
                if !std::mem::replace(&mut warned, true) {
                    eprintln!("[plugin {id}] ignoring output lines longer than {MAX_LINE} bytes");
                }
            }
            Ok(_) => f(String::from_utf8_lossy(&buf).trim_end_matches(['\r', '\n'])),
        }
    }
}

/// Spawns on one thread that lives as long as Lifer. PR_SET_PDEATHSIG fires when the spawning
/// thread ends, not the process, so a spawn from a short-lived thread would kill the plugin early.
fn spawn_on_launcher(cmd: Command) -> std::io::Result<Child> {
    type Job = (Command, std::sync::mpsc::Sender<std::io::Result<Child>>);
    static LAUNCHER: std::sync::OnceLock<std::sync::mpsc::Sender<Job>> = std::sync::OnceLock::new();
    let launcher = LAUNCHER.get_or_init(|| {
        let (tx, rx) = std::sync::mpsc::channel::<Job>();
        std::thread::spawn(move || {
            for (mut cmd, reply) in rx {
                let _ = reply.send(cmd.spawn());
            }
        });
        tx
    });
    let (reply, result) = std::sync::mpsc::channel();
    let gone = || std::io::Error::other("the launcher thread stopped");
    launcher.send((cmd, reply)).map_err(|_| gone())?;
    result.recv().map_err(|_| gone())?
}

/// The fixed launch: approved executable, documented arguments and environment, piped stdio.
fn plugin_command(plugin: &Plugin, ticket: &str) -> Command {
    let mut cmd = Command::new(&plugin.executable);
    cmd.args(["--lifer-host", "--protocol=1"])
        .env("LIFER_HOST_TICKET", ticket)
        // A force quit skips the stdin close, so the plugin watches this pid as Lifer's API does.
        .env("LIFER_WATCH_PARENT_PID", std::process::id().to_string())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    std::os::unix::process::CommandExt::process_group(&mut cmd, 0);
    // The kernel kills the plugin when Lifer goes, even on a force quit. The signal follows the
    // spawning thread, hence spawn_on_launcher.
    #[cfg(target_os = "linux")]
    {
        let parent = std::process::id() as libc::pid_t;
        // SAFETY: prctl and getppid are async-signal-safe, as code between fork and exec must be.
        unsafe {
            std::os::unix::process::CommandExt::pre_exec(&mut cmd, move || {
                if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                // Lifer already died before the signal was armed.
                if libc::getppid() != parent {
                    return Err(std::io::Error::from_raw_os_error(libc::ESRCH));
                }
                Ok(())
            });
        }
    }
    // CREATE_NO_WINDOW: a console plugin mustn't flash a terminal window.
    #[cfg(windows)]
    std::os::windows::process::CommandExt::creation_flags(&mut cmd, 0x0800_0000);
    cmd
}

/// Runs only the approved executable, with fixed arguments, and waits for its READY line.
async fn launch(
    plugin: &Plugin,
    timeout: Duration,
) -> Result<(Owned, PluginEndpoint, String), String> {
    let ticket = crate::local_inference::random_token()?;
    let mut child = spawn_on_launcher(plugin_command(plugin, &ticket))
        .map_err(|e| format!("Couldn't start {}: {e}", plugin.name))?;
    #[cfg(windows)]
    let job = win::Job::kill_on_close(&child);

    let (tx, rx) = std::sync::mpsc::channel();
    if let Some(stdout) = child.stdout.take() {
        let id = plugin.id.clone();
        // Keeps draining after READY so a chatty plugin never blocks on a full pipe.
        std::thread::spawn(move || {
            each_line(stdout, &id, |line| {
                if let Some(ready) = parse_ready(line) {
                    let _ = tx.send(ready);
                }
            })
        });
    }
    if let Some(stderr) = child.stderr.take() {
        let id = plugin.id.clone();
        std::thread::spawn(move || {
            each_line(stderr, &id, |line| eprintln!("[plugin {id}] {line}"))
        });
    }
    let owned = Owned {
        stdin: child.stdin.take(),
        child,
        #[cfg(windows)]
        _job: job,
    };
    let ready = tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(timeout))
        .await
        .map_err(|e| e.to_string())?;
    let name = &plugin.name;
    let failure = match ready {
        Ok(ready) => match endpoint_for(&ready) {
            Some(endpoint) if proves_ticket(&endpoint.origin, &ticket).await => {
                return Ok((owned, endpoint, ticket))
            }
            Some(_) => format!("{name} didn't answer Lifer's check, so Lifer won't show its page."),
            None => format!("{name} gave Lifer an address it can't open."),
        },
        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
            format!("{name} didn't start within {} seconds.", timeout.as_secs())
        }
        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
            format!("{name} stopped while starting.")
        }
    };
    tauri::async_runtime::spawn_blocking(move || owned.kill());
    Err(failure)
}

fn confirm(app: &AppHandle, plugin: &Plugin, identity: &Identity, changed: bool) -> bool {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
    let signed = match identity {
        Identity::Signer(s) => format!("Signed by {s}."),
        Identity::Sha256(_) => {
            "It isn't signed, so Lifer asks again whenever the app's file changes.".into()
        }
    };
    let (title, lead) = if changed {
        (
            format!("{} has changed", plugin.name),
            "It's signed differently, or its file changed, since you allowed it. Open it only if you updated it yourself.",
        )
    } else {
        (
            format!("Open {}?", plugin.name),
            "It's a separate app on this computer. Lifer starts it and shows its page in this window.",
        )
    };
    app.dialog()
        .message(format!(
            "{lead}\n\n{}\n{signed}",
            display_path(&plugin.executable)
        ))
        .title(title)
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Open".into(),
            "Cancel".into(),
        ))
        .blocking_show()
}

/// Whether a URL is the page of an app Lifer is running, so its frame may load in the window.
pub(crate) fn is_plugin_origin(app: &AppHandle, url: &url::Url) -> bool {
    let host = app.state::<PluginHost>();
    let slots = lock(&host.0.slots);
    let running = slots.values().filter_map(|slot| match &slot.state {
        State::Running(r) => Some(r.endpoint.origin.as_str()),
        _ => None,
    });
    matches_running_origin(running, url)
}

/// Same scheme, host and port as a running app's origin; any other loopback port or host is refused.
fn matches_running_origin<'a>(mut running: impl Iterator<Item = &'a str>, url: &url::Url) -> bool {
    running.any(|origin| url::Url::parse(origin).is_ok_and(|o| o.origin() == url.origin()))
}

#[tauri::command]
pub(crate) async fn plugin_start(
    window: WebviewWindow,
    id: String,
    background: Option<bool>,
) -> Result<PluginEndpoint, String> {
    if !crate::security::is_app_page(&window) {
        return Err("not allowed".into());
    }
    let app = window.app_handle().clone();
    let plugin = app
        .state::<PluginRegistry>()
        .find(&id)
        .ok_or("This app isn't installed.")?;
    let host = app.state::<PluginHost>().inner().clone();
    let data_dir = crate::app_data_dir(&app);
    let had_approval = read_approvals(&data_dir).contains_key(&id);
    let ask_app = app.clone();
    let ask: Ask = Arc::new(move |p, i| confirm(&ask_app, p, i, had_approval));
    let ask = (!background.unwrap_or(false)).then_some(ask);
    host.start(plugin, data_dir, ask).await
}

#[tauri::command]
pub(crate) async fn plugin_status(
    window: WebviewWindow,
    id: String,
) -> Result<PluginStatus, String> {
    if !crate::security::is_app_page(&window) {
        return Err("not allowed".into());
    }
    let host = window.app_handle().state::<PluginHost>().inner().clone();
    Ok(host.status(&id).await)
}

// An app that offers imports lists its past work and exports one to a folder with XMP. Lifer then
// imports that folder through the ordinary folder import, so the files' own marks win.
const MAX_IMPORTS_BODY: usize = 1024 * 1024;
const EXPORT_TIMEOUT: Duration = Duration::from_secs(30 * 60);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OfferedImport {
    id: String,
    name: String,
    date: Option<String>,
    file_count: Option<u64>,
}

/// The origin of a running app that offers imports. The page opens the app first, so a stopped
/// app is an error here rather than a launch.
async fn imports_origin(window: &WebviewWindow, id: &str) -> Result<String, String> {
    if !crate::security::is_app_page(window) {
        return Err("not allowed".into());
    }
    let app = window.app_handle();
    let plugin = app
        .state::<PluginRegistry>()
        .find(id)
        .ok_or("This app isn't installed.")?;
    if !plugin.capabilities.iter().any(|c| c == "offersImports") {
        return Err("This app doesn't offer imports.".into());
    }
    let host = app.state::<PluginHost>().inner().clone();
    host.status(id)
        .await
        .endpoint
        .map(|e| e.origin)
        .ok_or_else(|| "Open the app first.".to_string())
}

async fn plugin_call<T: for<'de> Deserialize<'de>>(
    request: reqwest::RequestBuilder,
) -> Result<T, String> {
    let mut response = request
        .send()
        .await
        .map_err(|_| "The app didn't answer.".to_string())?;
    if response.status() != reqwest::StatusCode::OK
        || response
            .content_length()
            .is_some_and(|n| n > MAX_IMPORTS_BODY as u64)
    {
        return Err("The app couldn't do that.".into());
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "The app didn't answer.".to_string())?
    {
        if body.len() + chunk.len() > MAX_IMPORTS_BODY {
            return Err("The app's answer was too big.".into());
        }
        body.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&body).map_err(|_| "The app's answer wasn't understood.".to_string())
}

fn imports_client(timeout: Duration) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(timeout)
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) async fn plugin_offered_imports(
    window: WebviewWindow,
    id: String,
) -> Result<Vec<OfferedImport>, String> {
    let origin = imports_origin(&window, &id).await?;
    let client = imports_client(Duration::from_secs(10))?;
    let mut list: Vec<OfferedImport> =
        plugin_call(client.get(format!("{origin}/lifer-host/imports"))).await?;
    list.truncate(500);
    Ok(list)
}

/// Asks the app to write one piece of past work to a folder and returns that folder's path.
#[tauri::command]
pub(crate) async fn plugin_export_import(
    window: WebviewWindow,
    id: String,
    work_id: String,
) -> Result<String, String> {
    let origin = imports_origin(&window, &id).await?;
    let client = imports_client(EXPORT_TIMEOUT)?;
    #[derive(Deserialize)]
    struct Exported {
        folder: String,
    }
    let done: Exported = plugin_call(
        client
            .post(format!("{origin}/lifer-host/imports/export"))
            .json(&serde_json::json!({ "id": work_id })),
    )
    .await?;
    if !Path::new(&done.folder).is_absolute() {
        return Err("The app didn't say where it saved the work.".into());
    }
    Ok(done.folder)
}

/// Held in the resource table like api::StopApiOnDrop, so the Windows updater's exit stops plugins.
pub struct StopPluginsOnDrop(pub AppHandle);
impl tauri::Resource for StopPluginsOnDrop {}
impl Drop for StopPluginsOnDrop {
    fn drop(&mut self) {
        self.0.state::<PluginHost>().stop_all();
    }
}

#[cfg(windows)]
mod win {
    use std::ffi::c_void;
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::AsRawHandle;
    use std::path::Path;
    use std::ptr::{null, null_mut};
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::Security::Cryptography::{
        CertGetNameStringW, CERT_CONTEXT, CERT_NAME_ISSUER_FLAG, CERT_NAME_RDN_TYPE,
        CERT_X500_NAME_STR,
    };
    use windows_sys::Win32::Security::WinTrust::{
        WTHelperGetProvSignerFromChain, WTHelperProvDataFromStateData, WinVerifyTrust,
        WINTRUST_ACTION_GENERIC_VERIFY_V2, WINTRUST_DATA, WINTRUST_DATA_0, WINTRUST_FILE_INFO,
        WTD_CACHE_ONLY_URL_RETRIEVAL, WTD_CHOICE_FILE, WTD_REVOKE_NONE, WTD_STATEACTION_CLOSE,
        WTD_STATEACTION_VERIFY, WTD_UI_NONE,
    };
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    /// The leaf certificate's subject and issuer, when WinVerifyTrust accepts the Authenticode
    /// signature. Revocation isn't fetched, so checking never goes online.
    pub fn authenticode_signer(path: &Path) -> Option<String> {
        let wide: Vec<u16> = path.as_os_str().encode_wide().chain([0]).collect();
        let mut file = WINTRUST_FILE_INFO {
            cbStruct: size_of::<WINTRUST_FILE_INFO>() as u32,
            pcwszFilePath: wide.as_ptr(),
            ..Default::default()
        };
        let mut data = WINTRUST_DATA {
            cbStruct: size_of::<WINTRUST_DATA>() as u32,
            dwUIChoice: WTD_UI_NONE,
            fdwRevocationChecks: WTD_REVOKE_NONE,
            dwUnionChoice: WTD_CHOICE_FILE,
            Anonymous: WINTRUST_DATA_0 { pFile: &mut file },
            dwStateAction: WTD_STATEACTION_VERIFY,
            dwProvFlags: WTD_CACHE_ONLY_URL_RETRIEVAL,
            ..Default::default()
        };
        let mut action = WINTRUST_ACTION_GENERIC_VERIFY_V2;
        // SAFETY: data and file outlive both calls; the state is released by the CLOSE call.
        unsafe {
            let ok = WinVerifyTrust(
                null_mut(),
                &mut action,
                &mut data as *mut WINTRUST_DATA as *mut c_void,
            ) == 0;
            let signer = if ok {
                leaf_signer(data.hWVTStateData)
            } else {
                None
            };
            data.dwStateAction = WTD_STATEACTION_CLOSE;
            WinVerifyTrust(
                null_mut(),
                &mut action,
                &mut data as *mut WINTRUST_DATA as *mut c_void,
            );
            signer
        }
    }

    unsafe fn leaf_signer(state: HANDLE) -> Option<String> {
        let provider = WTHelperProvDataFromStateData(state);
        if provider.is_null() {
            return None;
        }
        let signer = WTHelperGetProvSignerFromChain(provider, 0, 0, 0);
        if signer.is_null() || (*signer).csCertChain == 0 || (*signer).pasCertChain.is_null() {
            return None;
        }
        let cert = (*(*signer).pasCertChain).pCert;
        if cert.is_null() {
            return None;
        }
        let subject = cert_name(cert, 0)?;
        let issuer = cert_name(cert, CERT_NAME_ISSUER_FLAG)?;
        Some(super::signer_label(&subject, &issuer))
    }

    unsafe fn cert_name(cert: *const CERT_CONTEXT, flags: u32) -> Option<String> {
        let kind: u32 = CERT_X500_NAME_STR;
        let para = &kind as *const u32 as *const c_void;
        let len = CertGetNameStringW(cert, CERT_NAME_RDN_TYPE, flags, para, null_mut(), 0);
        if len <= 1 {
            return None;
        }
        let mut buf = vec![0u16; len as usize];
        let written =
            CertGetNameStringW(cert, CERT_NAME_RDN_TYPE, flags, para, buf.as_mut_ptr(), len);
        let name = String::from_utf16_lossy(&buf[..written.saturating_sub(1) as usize]);
        (!name.trim().is_empty()).then_some(name)
    }

    pub struct Job(HANDLE);
    // SAFETY: a job handle can be used and closed from any thread.
    unsafe impl Send for Job {}
    impl Drop for Job {
        fn drop(&mut self) {
            // SAFETY: the handle came from CreateJobObjectW and is closed once.
            unsafe { CloseHandle(self.0) };
        }
    }

    impl Job {
        // shortcut: a process the plugin starts before it is assigned escapes the job; launching
        // suspended would close that gap if it matters.
        pub fn kill_on_close(child: &std::process::Child) -> Option<Job> {
            // SAFETY: plain Win32 calls on a fresh job and the live child's handle.
            unsafe {
                let handle = CreateJobObjectW(null(), null());
                if handle.is_null() {
                    return None;
                }
                let job = Job(handle);
                let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                let set = SetInformationJobObject(
                    handle,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const c_void,
                    size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                );
                if set == 0
                    || AssignProcessToJobObject(handle, child.as_raw_handle() as HANDLE) == 0
                {
                    return None;
                }
                Some(job)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_running_apps_exact_origin_may_load() {
        let running = ["http://127.0.0.1:51234"];
        let ok =
            |u: &str| matches_running_origin(running.into_iter(), &url::Url::parse(u).unwrap());
        assert!(ok("http://127.0.0.1:51234/"));
        assert!(ok("http://127.0.0.1:51234/some/page?x=1#y"));
        assert!(!ok("http://127.0.0.1:51235/"));
        assert!(!ok("http://localhost:51234/"));
        assert!(!ok("https://127.0.0.1:51234/"));
        assert!(!ok("http://[::1]:51234/"));
        assert!(!ok("http://192.168.1.10:51234/"));
        assert!(!ok("http://127.0.0.1.example.com:51234/"));
        assert!(!ok("file:///etc/passwd"));
        // Nothing running, nothing allowed.
        assert!(!matches_running_origin(
            std::iter::empty(),
            &url::Url::parse("http://127.0.0.1:51234/").unwrap()
        ));
        // A malformed recorded origin never matches.
        assert!(!matches_running_origin(
            ["not a url"].into_iter(),
            &url::Url::parse("http://127.0.0.1:51234/").unwrap()
        ));
    }

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("lifer-plugins-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn manifest(id: &str, exe: &str) -> String {
        format!(
            r##"{{"schema":1,"id":"{id}","name":"Example","publisher":"https://example.com","homepage":"https://example.com","support":"https://example.com/help","version":"1.0.0","executable":{{"darwin":{e},"win32":{e},"linux":{e}}},"protocol":[1],"page":{{"label":"Example","icon":"M0 0h1v1z","accent":"#336699","surface":"default"}},"scopes":["lifelist.read"],"capabilities":["pickers"]}}"##,
            e = serde_json::to_string(exe).unwrap()
        )
    }

    fn exe_in(dir: &Path) -> String {
        let p = dir.join("app-bin");
        fs::write(&p, "x").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&p, fs::Permissions::from_mode(0o755)).unwrap();
        }
        p.to_string_lossy().into_owned()
    }

    #[test]
    fn valid_manifest_is_listed() {
        let d = tmp("valid");
        let exe = exe_in(&d);
        fs::write(
            d.join("com.example.app.json"),
            manifest("com.example.app", &exe),
        )
        .unwrap();
        let (plugins, skipped) = scan(&d);
        assert_eq!(plugins.len(), 1);
        assert!(skipped.is_empty());
        let real = fs::canonicalize(&exe).unwrap();
        assert_eq!(plugins[0].executable, real.to_str().unwrap());
    }

    #[test]
    fn broken_manifests_are_skipped() {
        let d = tmp("broken");
        let exe = exe_in(&d);
        fs::write(d.join("a.json"), "not json").unwrap();
        fs::write(d.join("b.json"), manifest("nodots", &exe)).unwrap();
        fs::write(d.join("c.json"), manifest("com.example.c", "relative/path")).unwrap();
        fs::write(
            d.join("d.json"),
            manifest("com.example.d", "/no/such/binary"),
        )
        .unwrap();
        fs::write(
            d.join("e.json"),
            manifest("com.example.e", &exe)
                .replace("https://example.com/help", "http://example.com"),
        )
        .unwrap();
        fs::write(
            d.join("g.json"),
            " ".repeat(MAX_MANIFEST_BYTES as usize + 1),
        )
        .unwrap();
        fs::create_dir(d.join("h.json")).unwrap();
        let (plugins, skipped) = scan(&d);
        assert!(plugins.is_empty());
        assert_eq!(skipped.len(), 7, "{skipped:?}");
    }

    #[test]
    fn unknown_capabilities_are_dropped_and_the_manifest_kept() {
        let d = tmp("caps");
        let exe = exe_in(&d);
        let with = |caps: &str| manifest("com.example.a", &exe).replace("[\"pickers\"]", caps);
        fs::write(
            d.join("a.json"),
            with(r#"["pickers","fromTheFuture","host.preference"]"#),
        )
        .unwrap();
        let (plugins, skipped) = scan(&d);
        assert!(skipped.is_empty(), "{skipped:?}");
        assert_eq!(plugins[0].capabilities, ["pickers", "host.preference"]);

        fs::write(d.join("a.json"), with(r#"["fromTheFuture"]"#)).unwrap();
        let (plugins, skipped) = scan(&d);
        assert!(skipped.is_empty(), "{skipped:?}");
        assert!(plugins[0].capabilities.is_empty());
    }

    #[test]
    fn an_app_named_lifer_is_refused() {
        let d = tmp("named-lifer");
        let exe = exe_in(&d);
        for (name, label) in [(" lifer ", "Kit"), ("Kit", "LIFER")] {
            let m = manifest("com.example.kit", &exe)
                .replace(r#""name":"Example""#, &format!(r#""name":"{name}""#))
                .replace(r#""label":"Example""#, &format!(r#""label":"{label}""#));
            let parsed: Manifest = serde_json::from_str(&m).unwrap();
            assert!(
                validate(parsed).unwrap_err().contains("Lifer"),
                "{name} {label}"
            );
        }
    }

    #[test]
    fn duplicate_id_keeps_the_first_file() {
        let d = tmp("dup");
        let exe = exe_in(&d);
        fs::write(d.join("a.json"), manifest("com.example.app", &exe)).unwrap();
        fs::write(d.join("b.json"), manifest("com.example.app", &exe)).unwrap();
        let (plugins, skipped) = scan(&d);
        assert_eq!(plugins.len(), 1);
        assert_eq!(skipped.len(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_executable_resolves_and_needs_the_exec_bit() {
        let d = tmp("symlink");
        let exe = exe_in(&d);
        let link = d.join("app-link");
        std::os::unix::fs::symlink(&exe, &link).unwrap();
        fs::write(
            d.join("a.json"),
            manifest("com.example.app", link.to_str().unwrap()),
        )
        .unwrap();
        let (plugins, _) = scan(&d);
        assert_eq!(
            plugins[0].executable,
            fs::canonicalize(&exe).unwrap().to_str().unwrap()
        );
        let plain = d.join("plain");
        fs::write(&plain, "x").unwrap();
        fs::write(
            d.join("a.json"),
            manifest("com.example.app", plain.to_str().unwrap()),
        )
        .unwrap();
        assert!(scan(&d).0.is_empty());
    }

    #[test]
    fn missing_folder_is_empty() {
        assert!(scan(Path::new("/no/such/plugins/dir")).0.is_empty());
    }

    #[test]
    fn executable_comes_from_this_os() {
        let e = Executables {
            darwin: Some("/m".into()),
            win32: Some("C:\\w".into()),
            linux: Some("/l".into()),
        };
        let want = if cfg!(target_os = "macos") {
            "/m"
        } else if cfg!(windows) {
            "C:\\w"
        } else {
            "/l"
        };
        assert_eq!(executable_for_this_os(&e), Some(want));
        assert_eq!(
            executable_for_this_os(&Executables {
                darwin: None,
                win32: None,
                linux: None
            }),
            None
        );
    }

    #[test]
    fn approval_follows_the_identity_not_the_path() {
        let d = tmp("approve");
        let exe = exe_in(&d);
        fs::write(d.join("x.json"), manifest("com.example.app", &exe)).unwrap();
        let (mut plugins, _) = scan(&d);
        let signer = Identity::Signer("TEAM123456".into());
        plugins[0].identity = Some(signer.clone());
        assert!(!summarize(&plugins, &read_approvals(&d))[0].approved);
        approve(&d, "com.example.app", &signer).unwrap();
        assert!(summarize(&plugins, &read_approvals(&d))[0].approved);
        // An in-place update or a new install path, same signer: still approved.
        plugins[0].executable = format!("{}-moved", plugins[0].executable);
        assert!(summarize(&plugins, &read_approvals(&d))[0].approved);
        plugins[0].identity = Some(Identity::Signer("OTHER12345".into()));
        assert!(!summarize(&plugins, &read_approvals(&d))[0].approved);
        plugins[0].identity = None;
        assert!(!summarize(&plugins, &read_approvals(&d))[0].approved);
    }

    #[test]
    fn concurrent_approvals_keep_every_entry() {
        let d = tmp("approve-race");
        let threads: Vec<_> = (0..16)
            .map(|i| {
                let d = d.clone();
                std::thread::spawn(move || {
                    approve(
                        &d,
                        &format!("com.example.a{i}"),
                        &Identity::Sha256(i.to_string()),
                    )
                    .unwrap()
                })
            })
            .collect();
        threads.into_iter().for_each(|t| t.join().unwrap());
        assert_eq!(read_approvals(&d).len(), 16);
    }

    #[test]
    fn ready_line_parses_and_rejects_bad_values() {
        let r =
            parse_ready("LIFER_PLUGIN_READY port=4999 page=/app?x=1 pageToken=abc_1\n").unwrap();
        assert_eq!(r.port, 4999);
        let ep = endpoint_for(&r).unwrap();
        assert_eq!(ep.origin, "http://127.0.0.1:4999");
        assert_eq!(ep.page_url, "http://127.0.0.1:4999/app?x=1");
        assert_eq!(ep.page_token, "abc_1");
        for bad in [
            "LIFER_PLUGIN_READY port=0 page=/ pageToken=a",
            "LIFER_PLUGIN_READY port=70000 page=/ pageToken=a",
            "LIFER_PLUGIN_READY port=1 page=//evil.example pageToken=a",
            "LIFER_PLUGIN_READY port=1 page=http://evil.example/ pageToken=a",
            "LIFER_PLUGIN_READY port=1 page=/ pageToken=",
            "LIFER_PLUGIN_READY port=1 page=/ pageToken=a\"b",
            "LIFER_PLUGIN_READY port=1 page=/",
            "LIFER_PLUGIN_READY port=4310 page=/ pageToken=a",
            "port=1 page=/ pageToken=a",
        ] {
            assert!(
                parse_ready(bad).and_then(|r| endpoint_for(&r)).is_none(),
                "{bad}"
            );
        }
    }

    #[test]
    fn proof_must_be_exact_lowercase_hex() {
        let good = proof("ticket", "nonce");
        assert!(proof_matches("ticket", "nonce", &good));
        assert!(!proof_matches("ticket", "other", &good));
        assert!(!proof_matches("other", "nonce", &good));
        assert!(!proof_matches("ticket", "nonce", &good.to_uppercase()));
        assert!(!proof_matches("ticket", "nonce", &good[..62]));
        assert!(!proof_matches(
            "ticket",
            "nonce",
            &format!("+{}", &good[1..])
        ));
    }

    fn proof(ticket: &str, nonce: &str) -> String {
        use hmac::{KeyInit, Mac};
        let mut mac = hmac::Hmac::<sha2::Sha256>::new_from_slice(ticket.as_bytes()).unwrap();
        mac.update(nonce.as_bytes());
        mac.finalize()
            .into_bytes()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect()
    }

    #[test]
    fn long_lines_are_dropped() {
        let fits = "x".repeat(MAX_LINE);
        let input = format!(
            "a\n{}\nb\r\n{fits}\n{}",
            "y".repeat(MAX_LINE + 1),
            "z".repeat(MAX_LINE * 3)
        );
        let mut lines = Vec::new();
        each_line(input.as_bytes(), "t", |l| lines.push(l.to_string()));
        assert_eq!(lines, ["a", "b", fits.as_str()]);
    }

    #[test]
    fn windows_signer_pins_subject_and_issuer() {
        let a = signer_label("CN=Example", "CN=Issuer One");
        assert_eq!(a, signer_label("CN=Example", "CN=Issuer One"));
        assert_ne!(a, signer_label("CN=Example", "CN=Issuer Two"));
        assert_ne!(a, signer_label("CN=Other", "CN=Issuer One"));
    }

    #[test]
    fn team_identifier_needs_a_real_team() {
        let out = "Executable=/x\nIdentifier=com.example\nTeamIdentifier=ABCDE12345\n";
        assert_eq!(team_identifier(out), Some("ABCDE12345"));
        assert_eq!(team_identifier("TeamIdentifier=not set\n"), None);
        assert_eq!(team_identifier("Signature=adhoc\n"), None);
    }

    #[test]
    fn windows_prefix_is_hidden() {
        assert_eq!(display_path(r"\\?\C:\Apps\x.exe"), r"C:\Apps\x.exe");
        assert_eq!(
            display_path(r"\\?\UNC\nas\share\x.exe"),
            r"\\nas\share\x.exe"
        );
        assert_eq!(display_path("/Applications/X.app"), "/Applications/X.app");
    }

    #[cfg(unix)]
    mod host {
        use super::super::*;
        use std::sync::atomic::AtomicUsize;

        const ID: &str = "com.example.fake";

        fn dir(name: &str) -> PathBuf {
            let d = std::env::temp_dir().join(format!("lifer-host-{name}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&d);
            fs::create_dir_all(&d).unwrap();
            fs::canonicalize(d).unwrap()
        }

        // A stand-in plugin: checks it was launched the documented way, gives its ticket to the
        // stand-in server (`health_server`) by writing <d>/ticket, then runs `body`.
        fn fake(d: &Path, body: &str) -> Plugin {
            use std::os::unix::fs::PermissionsExt;
            let exe = d.join("fake-plugin");
            fs::write(
                &exe,
                format!(
                    "#!/bin/sh\n[ -n \"$LIFER_HOST_TICKET\" ] && [ \"$1\" = --lifer-host ] && [ \"$2\" = --protocol=1 ] && [ \"$LIFER_WATCH_PARENT_PID\" = {pid} ] || exit 3\necho launched >> '{d}/launches'\nprintf %s \"$LIFER_HOST_TICKET\" > '{d}/ticket'\n{body}\n",
                    pid = std::process::id(),
                    d = d.display()
                ),
            )
            .unwrap();
            fs::set_permissions(&exe, fs::Permissions::from_mode(0o755)).unwrap();
            Plugin {
                id: ID.into(),
                name: "Fake".into(),
                page: PluginPage {
                    label: "Fake".into(),
                    icon: "M0 0".into(),
                    accent: "#336699".into(),
                    surface: "default".into(),
                },
                scopes: vec![],
                capabilities: vec![],
                executable: exe.to_string_lossy().into_owned(),
                identity: None,
            }
        }

        fn ready(port: u16) -> String {
            format!("echo 'LIFER_PLUGIN_READY port={port} page=/app pageToken=tok'")
        }

        fn asker(allow: bool) -> (Ask, Arc<AtomicUsize>) {
            let asked = Arc::new(AtomicUsize::new(0));
            let count = asked.clone();
            let ask: Ask = Arc::new(move |_, _| {
                count.fetch_add(1, Ordering::SeqCst);
                allow
            });
            (ask, asked)
        }

        fn launches(d: &Path) -> usize {
            fs::read_to_string(d.join("launches"))
                .unwrap_or_default()
                .lines()
                .count()
        }

        fn fast() -> PluginHost {
            PluginHost::with_timing(Duration::from_secs(5), Duration::from_millis(500))
        }

        fn wait_for(host: &PluginHost, state: &str) -> PluginStatus {
            tauri::async_runtime::block_on(async {
                for _ in 0..150 {
                    let s = host.status(ID).await;
                    if s.state == state {
                        return s;
                    }
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
                panic!("never reached {state}");
            })
        }

        // A plugin's health route: `answer` gets the nonce and returns the full HTTP response.
        fn serve(answer: impl Fn(&str) -> String + Send + 'static) -> u16 {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let port = listener.local_addr().unwrap().port();
            std::thread::spawn(move || {
                for mut s in listener.incoming().flatten() {
                    use std::io::{Read, Write};
                    let mut req = [0u8; 2048];
                    let n = s.read(&mut req).unwrap_or(0);
                    let req = String::from_utf8_lossy(&req[..n]);
                    let nonce = req
                        .split_once("nonce=")
                        .and_then(|(_, r)| r.split([' ', '&']).next())
                        .unwrap_or("");
                    let _ = s.write_all(answer(nonce).as_bytes());
                }
            });
            port
        }

        fn json(body: &str) -> String {
            format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            )
        }

        // Proves whichever ticket the fake last handed over in <d>/ticket, as a running instance
        // would after a hand-off; with none it answers 503.
        fn health_server(d: &Path) -> u16 {
            let d = d.to_path_buf();
            serve(move |nonce| match fs::read_to_string(d.join("ticket")) {
                Ok(t) => json(&format!(r#"{{"proof":"{}"}}"#, super::proof(&t, nonce))),
                Err(_) => {
                    "HTTP/1.1 503 Busy\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".into()
                }
            })
        }

        fn start(
            host: &PluginHost,
            p: &Plugin,
            d: &Path,
            ask: Ask,
        ) -> Result<PluginEndpoint, String> {
            tauri::async_runtime::block_on(host.start(p.clone(), d.to_path_buf(), Some(ask)))
        }

        #[test]
        fn launches_once_and_stops_by_closing_stdin() {
            let d = dir("stop");
            let p = fake(
                &d,
                &format!(
                    "{}\ncat > /dev/null\necho bye > '{}/bye'",
                    ready(health_server(&d)),
                    d.display()
                ),
            );
            let host = fast();
            let (ask, asked) = asker(true);
            let ep = start(&host, &p, &d, ask.clone()).unwrap();
            assert!(ep.page_url.ends_with("/app"), "{}", ep.page_url);
            assert_eq!(ep.page_token, "tok");
            assert_eq!(start(&host, &p, &d, ask).unwrap(), ep);
            assert_eq!(asked.load(Ordering::SeqCst), 1);
            assert_eq!(launches(&d), 1);
            let t = Instant::now();
            host.stop_all();
            assert!(
                t.elapsed() < Duration::from_millis(500),
                "it should exit on stdin close"
            );
            assert!(d.join("bye").exists());
        }

        #[test]
        fn a_plugin_ignoring_stdin_is_killed_with_its_children() {
            let d = dir("stubborn");
            let p = fake(
                &d,
                &format!(
                    "sleep 30 &\necho $! > '{}/child'\n{}\nwait",
                    d.display(),
                    ready(health_server(&d))
                ),
            );
            let host = fast();
            start(&host, &p, &d, asker(true).0).unwrap();
            host.stop_all();
            let child: i32 = fs::read_to_string(d.join("child"))
                .unwrap()
                .trim()
                .parse()
                .unwrap();
            let gone = (0..40).any(|_| {
                std::thread::sleep(Duration::from_millis(50));
                unsafe { libc::kill(child, 0) != 0 }
            });
            assert!(gone, "the plugin's own child outlived it");
        }

        #[test]
        fn a_background_start_never_asks_and_leaves_no_error() {
            let d = dir("background");
            let p = fake(
                &d,
                &format!("{}\ncat > /dev/null", ready(health_server(&d))),
            );
            let host = fast();
            let bg = tauri::async_runtime::block_on(host.start(p.clone(), d.clone(), None));
            assert!(bg.unwrap_err().contains("has changed"));
            assert_eq!(launches(&d), 0);
            let s = tauri::async_runtime::block_on(host.status(ID));
            assert_eq!((s.state, s.error), ("stopped", None));
            let (ask, asked) = asker(true);
            start(&host, &p, &d, ask).unwrap();
            assert_eq!(asked.load(Ordering::SeqCst), 1);
            // Approved now, so a background start reuses the running app.
            assert!(tauri::async_runtime::block_on(host.start(p.clone(), d.clone(), None)).is_ok());
            assert_eq!(launches(&d), 1);
            host.stop_all();
        }

        #[test]
        fn a_silent_plugin_times_out() {
            let d = dir("timeout");
            let p = fake(&d, "sleep 30");
            let host = PluginHost::with_timing(Duration::from_secs(1), Duration::from_millis(100));
            let err = start(&host, &p, &d, asker(true).0).unwrap_err();
            assert!(err.contains("didn't start"), "{err}");
            let s = tauri::async_runtime::block_on(host.status(ID));
            assert_eq!((s.state, s.error), ("stopped", Some(err)));
        }

        #[test]
        fn a_crashing_plugin_restarts_once_then_stays_stopped() {
            let d = dir("crash");
            let p = fake(
                &d,
                &format!("{}\nsleep 1\nexit 1", ready(health_server(&d))),
            );
            let host = fast();
            start(&host, &p, &d, asker(true).0).unwrap();
            let s = wait_for(&host, "stopped");
            assert_eq!(s.error.as_deref(), Some("Fake stopped."));
            assert_eq!(launches(&d), 2);
            // Restart from the page resets the allowance.
            start(&host, &p, &d, asker(true).0).unwrap();
            wait_for(&host, "stopped");
            assert_eq!(launches(&d), 4);
        }

        #[test]
        fn an_automatic_restart_never_runs_a_changed_file() {
            let d = dir("crash-changed");
            let p = fake(
                &d,
                &format!("{}\nsleep 1\nexit 1", ready(health_server(&d))),
            );
            let host = fast();
            start(&host, &p, &d, asker(true).0).unwrap();
            let mut f = fs::OpenOptions::new()
                .append(true)
                .open(&p.executable)
                .unwrap();
            std::io::Write::write_all(&mut f, b"# changed\n").unwrap();
            let s = wait_for(&host, "stopped");
            assert!(s.error.unwrap().contains("has changed"));
            assert_eq!(launches(&d), 1);
        }

        #[test]
        fn hands_off_to_a_running_instance() {
            let d = dir("attach");
            let p = fake(&d, &format!("{}\nexit 0", ready(health_server(&d))));
            let host = fast();
            start(&host, &p, &d, asker(true).0).unwrap();
            std::thread::sleep(Duration::from_millis(800));
            let attached = matches!(
                &lock(&host.0.slots)[ID].state,
                State::Running(r) if r.process.is_none()
            );
            assert!(attached);
            assert_eq!(wait_for(&host, "running").state, "running");
            assert_eq!(launches(&d), 1);
        }

        #[test]
        fn a_handed_off_instance_that_stops_answering_was_closed() {
            let d = dir("attach-gone");
            let p = fake(&d, &format!("{}\nexit 0", ready(health_server(&d))));
            let host = fast();
            start(&host, &p, &d, asker(true).0).unwrap();
            std::thread::sleep(Duration::from_millis(800));
            fs::remove_file(d.join("ticket")).unwrap();
            let s = wait_for(&host, "stopped");
            assert_eq!(s.error.as_deref(), Some("Fake was closed."));
            std::thread::sleep(Duration::from_millis(500));
            assert_eq!(launches(&d), 1);
        }

        #[test]
        fn health_answers_must_be_json() {
            let d = dir("health-type");
            fs::write(d.join("ticket"), "t").unwrap();
            let port = serve(|nonce| {
                let body = format!(r#"{{"proof":"{}"}}"#, super::proof("t", nonce));
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                )
            });
            let origin = format!("http://127.0.0.1:{port}");
            assert!(!tauri::async_runtime::block_on(health_ok(&origin, "t")));
            let port = serve(|nonce| {
                let body = format!(r#"{{"proof":"{}"}}"#, super::proof("t", nonce));
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                )
            });
            let origin = format!("http://127.0.0.1:{port}");
            assert!(tauri::async_runtime::block_on(health_ok(&origin, "t")));
        }

        #[cfg(target_os = "macos")]
        #[test]
        fn a_running_process_must_carry_the_approved_signer() {
            let mut child = Command::new("/bin/sleep").arg("5").spawn().unwrap();
            let exe = Path::new("/bin/sleep");
            assert!(!running_matches(
                child.id(),
                exe,
                &Identity::Signer("ABCDE12345".into())
            ));
            assert!(running_matches(
                child.id(),
                exe,
                &Identity::Sha256("x".into())
            ));
            let _ = child.kill();
            let _ = child.wait();
        }

        #[test]
        fn failed_health_checks_restart_once() {
            let d = dir("health");
            // Healthy at first, then its server forgets the ticket.
            let p = fake(
                &d,
                &format!(
                    "{}\n(sleep 1; printf stale > '{}/ticket') &\ncat > /dev/null",
                    ready(health_server(&d)),
                    d.display()
                ),
            );
            let host = fast();
            start(&host, &p, &d, asker(true).0).unwrap();
            let s = wait_for(&host, "stopped");
            assert_eq!(s.error.as_deref(), Some("Fake stopped."));
            assert_eq!(launches(&d), 2);
            host.stop_all();
        }

        #[test]
        fn a_changed_file_asks_again() {
            let d = dir("hash");
            let p = fake(
                &d,
                &format!("{}\ncat > /dev/null", ready(health_server(&d))),
            );
            let first = fast();
            start(&first, &p, &d, asker(true).0).unwrap();
            first.stop_all();
            // Same bytes on another start: no question.
            let again = fast();
            let (ask, asked) = asker(true);
            start(&again, &p, &d, ask).unwrap();
            again.stop_all();
            assert_eq!(asked.load(Ordering::SeqCst), 0);
            let p = fake(
                &d,
                &format!("{}\ncat > /dev/null\n# v2", ready(health_server(&d))),
            );
            let changed = fast();
            let (ask, asked) = asker(false);
            assert_eq!(start(&changed, &p, &d, ask).unwrap_err(), NOT_APPROVED);
            assert_eq!(asked.load(Ordering::SeqCst), 1);
            assert_eq!(launches(&d), 2);
        }

        #[test]
        fn a_different_signer_asks_again() {
            let d = dir("signer");
            let p = fake(
                &d,
                &format!("{}\ncat > /dev/null", ready(health_server(&d))),
            );
            approve(&d, ID, &Identity::Signer("ABCDE12345".into())).unwrap();
            let host = fast();
            let (ask, asked) = asker(true);
            start(&host, &p, &d, ask).unwrap();
            host.stop_all();
            assert_eq!(asked.load(Ordering::SeqCst), 1);
            assert!(matches!(read_approvals(&d)[ID], Identity::Sha256(_)));
        }

        #[test]
        fn unsafe_files_are_refused() {
            use std::os::unix::fs::PermissionsExt;
            let d = dir("unsafe");
            let p = fake(&d, &ready(4999));
            fs::set_permissions(&p.executable, fs::Permissions::from_mode(0o777)).unwrap();
            let (ask, asked) = asker(true);
            let err = start(&fast(), &p, &d, ask).unwrap_err();
            assert!(err.contains("anyone on this computer"), "{err}");
            assert_eq!(asked.load(Ordering::SeqCst), 0);
            fs::set_permissions(&p.executable, fs::Permissions::from_mode(0o755)).unwrap();
            fs::set_permissions(&d, fs::Permissions::from_mode(0o777)).unwrap();
            let err = start(&fast(), &p, &d, asker(true).0).unwrap_err();
            fs::set_permissions(&d, fs::Permissions::from_mode(0o755)).unwrap();
            assert!(err.contains("folder holding"), "{err}");
            assert_eq!(launches(&d), 0);
        }

        #[test]
        fn health_checks_never_follow_a_redirect() {
            let d = dir("redirect");
            fs::write(d.join("ticket"), "t").unwrap();
            let target = health_server(&d);
            let port = serve(move |_| {
                format!("HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:{target}/lifer-host/health\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            });
            let ok =
                tauri::async_runtime::block_on(health_ok(&format!("http://127.0.0.1:{port}"), "t"));
            assert!(!ok);
        }

        #[test]
        fn health_needs_the_proof_of_this_ticket() {
            let d = dir("proof");
            fs::write(d.join("ticket"), "right").unwrap();
            let origin = format!("http://127.0.0.1:{}", health_server(&d));
            let check = |t: &str| tauri::async_runtime::block_on(health_ok(&origin, t));
            assert!(check("right"));
            assert!(!check("wrong"));
            for answer in [
                json(""),
                json(r#"{"proof":""}"#),
                json(&format!(r#"{{"proof":"{}"}}"#, "0".repeat(64))),
                json(&format!(r#"{{"proof":"{}"}}"#, "a".repeat(5000))),
            ] {
                let port = serve(move |_| answer.clone());
                let ok = tauri::async_runtime::block_on(health_ok(
                    &format!("http://127.0.0.1:{port}"),
                    "right",
                ));
                assert!(!ok);
            }
        }

        #[test]
        fn another_process_on_the_port_is_refused() {
            let d = dir("squatter");
            // Some other server, answering 200 to anything, owns the port the plugin names.
            let port = serve(|_| json(r#"{"proof":"none"}"#));
            let p = fake(&d, &format!("{}\ncat > /dev/null", ready(port)));
            let host = fast();
            let err = start(&host, &p, &d, asker(true).0).unwrap_err();
            assert!(err.contains("didn't answer Lifer's check"), "{err}");
            assert_eq!(launches(&d), 1);
        }

        #[test]
        fn a_hand_off_without_the_ticket_is_refused() {
            let d = dir("attach-stale");
            let p = fake(
                &d,
                &format!(
                    "printf stale > '{}/ticket'\n{}\nexit 0",
                    d.display(),
                    ready(health_server(&d))
                ),
            );
            let host = fast();
            let err = start(&host, &p, &d, asker(true).0).unwrap_err();
            assert!(err.contains("didn't answer Lifer's check"), "{err}");
            assert_eq!(launches(&d), 1);
        }

        #[test]
        fn a_clean_exit_means_closed_not_crashed() {
            let d = dir("closed");
            let p = fake(
                &d,
                &format!(
                    "{}\nsleep 1\nrm '{}/ticket'\nexit 0",
                    ready(health_server(&d)),
                    d.display()
                ),
            );
            let host = fast();
            start(&host, &p, &d, asker(true).0).unwrap();
            let s = wait_for(&host, "stopped");
            assert_eq!(s.error.as_deref(), Some("Fake was closed."));
            std::thread::sleep(Duration::from_millis(500));
            assert_eq!(launches(&d), 1);
        }

        #[test]
        fn the_plugin_is_told_which_pid_to_watch() {
            let d = dir("pid");
            let p = fake(
                &d,
                &format!(
                    "echo \"$LIFER_WATCH_PARENT_PID\" > '{}/pid'\n{}\ncat > /dev/null",
                    d.display(),
                    ready(health_server(&d))
                ),
            );
            let host = fast();
            start(&host, &p, &d, asker(true).0).unwrap();
            host.stop_all();
            let pid = fs::read_to_string(d.join("pid")).unwrap();
            assert_eq!(pid.trim(), std::process::id().to_string());
        }

        // PR_SET_PDEATHSIG fires when the spawning thread ends, which stands in for Lifer dying.
        // A launch from a short-lived thread must still survive it, via spawn_on_launcher.
        #[cfg(target_os = "linux")]
        #[test]
        fn dies_with_lifer_on_linux() {
            let d = dir("pdeath");
            let p = fake(&d, "cat > /dev/null");
            let exited = |pid: libc::pid_t| {
                (0..40).any(|_| {
                    std::thread::sleep(Duration::from_millis(50));
                    let mut status = 0;
                    // SAFETY: reaps our own child, without blocking.
                    unsafe { libc::waitpid(pid, &mut status, libc::WNOHANG) == pid }
                })
            };
            let (direct, via_launcher) = std::thread::spawn(move || {
                let direct = plugin_command(&p, "t").spawn().unwrap();
                let via = spawn_on_launcher(plugin_command(&p, "t")).unwrap();
                let pids = (direct.id() as libc::pid_t, via.id() as libc::pid_t);
                // Keeps stdin open, so only the death signal can end them.
                std::mem::forget((direct, via));
                pids
            })
            .join()
            .unwrap();
            assert!(
                exited(direct),
                "the plugin outlived the thread that spawned it"
            );
            assert!(
                !exited(via_launcher),
                "a launch died with a short-lived thread"
            );
            // SAFETY: our own child.
            unsafe { libc::kill(via_launcher, libc::SIGKILL) };
        }

        #[test]
        fn a_huge_output_line_is_skipped() {
            let d = dir("long-line");
            let p = fake(
                &d,
                &format!(
                    "head -c 100000 /dev/zero | tr '\\0' x\necho\n{}\ncat > /dev/null",
                    ready(health_server(&d))
                ),
            );
            let host = fast();
            start(&host, &p, &d, asker(true).0).unwrap();
            host.stop_all();
        }

        #[cfg(target_os = "macos")]
        #[test]
        fn ad_hoc_signed_files_pin_their_hash() {
            let d = dir("adhoc");
            let p = fake(&d, "exit 0");
            let signed = Command::new("/usr/bin/codesign")
                .args(["-s", "-", "-f", &p.executable])
                .output()
                .unwrap();
            assert!(signed.status.success(), "{signed:?}");
            assert!(matches!(
                identify(Path::new(&p.executable)).unwrap(),
                Identity::Sha256(_)
            ));
        }
    }
}
