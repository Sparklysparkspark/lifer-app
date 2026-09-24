// Spawns and supervises the Lifer API as a child process — the Tauri equivalent of
// apps/desktop/src/main.js's startApi/stopApi/waitForServer/fetchOk. apps/api itself needs
// ZERO changes for this migration (confirmed: it's a plain Fastify server reading env vars,
// no Electron-specific assumptions anywhere) — only how it's launched changes, from Electron
// repurposing its own binary as Node (ELECTRON_RUN_AS_NODE) to a real vendored Node binary
// run as a Tauri sidecar.
use crate::embedded_db;
use postgresql_embedded::PostgreSQL;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

pub const LOCAL_PORT: u16 = 4310;

// Unexpected mid-session crashes are restarted at most this many times per window before the
// crash dialog is shown.
const MAX_RESTARTS: usize = 2;
const RESTART_WINDOW: Duration = Duration::from_secs(5 * 60);

pub struct RunningChild {
    child: CommandChild,
    // Per-child, so a deliberate stop of one child can't be confused with a crash of the next.
    stopping: Arc<AtomicBool>,
}

#[derive(Clone)]
struct SpawnSpec {
    api_dir: PathBuf,
    envs: HashMap<String, String>,
    args: Vec<String>,
}

#[derive(Default)]
pub struct ApiState {
    child: Mutex<Option<RunningChild>>,
    spawn_spec: Mutex<Option<SpawnSpec>>,
    restarts: Mutex<Vec<Instant>>,
    // Last 4KB of stderr, for the crash dialog — mirrors main.js's `recentStderr`.
    pub recent_stderr: Mutex<String>,
    // The embedded Postgres instance backing local mode (see embedded_db.rs) — kept alive here
    // for the app's lifetime so stop_api() can shut it down cleanly, and so a second start_api()
    // call in the same process (re-picking the library folder) reuses the already-running
    // instance instead of trying to set up/start a second one on top of it.
    pub postgres: Mutex<Option<PostgreSQL>>,
}

fn resources_root(app: &AppHandle) -> PathBuf {
    // In dev (`tauri dev`), resources aren't bundled yet — fall back to the staged resources
    // folder the prepare-resources script writes, so `tauri dev` can run against the real API
    // without a full `tauri build` first.
    match app.path_resolver_resource_dir() {
        Some(dir) if dir.join("api").exists() => dir,
        _ => PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources-staging"),
    }
}

trait PathResolverExt {
    fn path_resolver_resource_dir(&self) -> Option<PathBuf>;
}
impl PathResolverExt for AppHandle {
    fn path_resolver_resource_dir(&self) -> Option<PathBuf> {
        use tauri::Manager;
        self.path().resource_dir().ok()
    }
}

// Dev-only convenience: the offline map is a real opt-in download in the shipped app (see
// settings/routes.ts's /settings/map/download, MAP_DOWNLOAD_URL) — there's no hosted download
// URL configured yet, so right now there's genuinely no way to get the map without this. This
// repo's own checkout already has that same file at data/lifer/maps — gated purely on that
// exact relative path actually existing (not on debug vs. release build), since that's already
// the real safety guarantee: no real end-user install ever has this repo's own working copy
// sitting three directories above wherever the app binary happens to live, so this can never
// fire outside a QA checkout like this one, in either build profile. This is the Tauri port of
// the same fix main.js's ensureDevMap once had for Electron — that version never carried over
// during the migration, which is the actual reason "the map is grey" kept coming back: the map
// file was never present for this app's own data dir at all, in either light or dark mode,
// regardless of any style/flavor changes made along the way.
fn ensure_dev_map(app_data_dir: &std::path::Path) {
    let dev_map = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../data/lifer/maps/world-z8.pmtiles");
    let dest_dir = app_data_dir.join("app-data").join("maps");
    let dest_map = dest_dir.join("world-z8.pmtiles");
    if !dev_map.exists() || dest_map.exists() {
        return;
    }
    if std::fs::create_dir_all(&dest_dir).is_ok() {
        let _ = std::fs::copy(&dev_map, &dest_map);
    }
}

// Random per-launch id passed to the API as LIFER_LAUNCH_TOKEN and echoed by its /health, so a
// previous launch's still-exiting API is never mistaken for ours.
fn launch_token() -> &'static str {
    static TOKEN: OnceLock<String> = OnceLock::new();
    TOKEN.get_or_init(|| {
        use std::hash::{BuildHasher, Hasher};
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        (0..2u8)
            .map(|i| {
                let mut h = std::collections::hash_map::RandomState::new().build_hasher();
                h.write_u128(nanos);
                h.write_u32(std::process::id());
                h.write_u8(i);
                format!("{:016x}", h.finish())
            })
            .collect()
    })
}

enum LocalApi {
    Absent,
    Ours,
    // Another launch's API, or an older API that predates launchToken.
    Foreign,
}

async fn probe_local_api() -> LocalApi {
    #[derive(serde::Deserialize)]
    struct Health {
        #[serde(rename = "launchToken")]
        launch_token: Option<String>,
    }
    let Ok(client) = reqwest::Client::builder().timeout(Duration::from_secs(2)).build() else {
        return LocalApi::Absent;
    };
    let Ok(res) = client.get(format!("http://127.0.0.1:{LOCAL_PORT}/health")).send().await else {
        return LocalApi::Absent;
    };
    match res.json::<Health>().await {
        Ok(Health { launch_token: Some(t) }) if t == launch_token() => LocalApi::Ours,
        _ => LocalApi::Foreign,
    }
}

// Waits for a previous launch's API to exit (its parent-pid watchdog polls every 3s) so the new
// child doesn't die on EADDRINUSE.
async fn wait_for_port_free(timeout: Duration) -> Result<(), String> {
    let start = Instant::now();
    loop {
        let absent = matches!(probe_local_api().await, LocalApi::Absent);
        if absent && std::net::TcpListener::bind(("127.0.0.1", LOCAL_PORT)).is_ok() {
            return Ok(());
        }
        if start.elapsed() > timeout {
            return Err(format!(
                "Another program (possibly an earlier copy of Lifer) is still using port {LOCAL_PORT}. Quit it and open Lifer again."
            ));
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}

pub async fn start_api(app: &AppHandle, data_dir: Option<String>) -> Result<(), String> {
    use tauri::Manager;

    match probe_local_api().await {
        LocalApi::Ours => return Ok(()),
        LocalApi::Absent | LocalApi::Foreign => wait_for_port_free(Duration::from_secs(20)).await?,
    }

    let state = app.state::<ApiState>();

    let resources = resources_root(app);
    let api_dir = resources.join("api");
    let web_dist = resources.join("web");
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Couldn't resolve app data dir: {e}"))?;
    ensure_dev_map(&app_data_dir);

    let mut envs: HashMap<String, String> = std::env::vars().collect();
    envs.insert("PORT".into(), LOCAL_PORT.to_string());
    envs.insert("NODE_ENV".into(), "production".into());
    envs.insert("SINGLE_USER_MODE".into(), "1".into());
    // Belt-and-suspenders against a force-quit or crash of this app: those send SIGKILL
    // directly to this process with no chance for the RunEvent::Exit/ExitRequested handler
    // below to run at all, which otherwise leaves this sidecar orphaned and still holding
    // LOCAL_PORT. The sidecar's own watchdog (see apps/api/src/index.ts) polls this pid and
    // self-exits once it's gone.
    envs.insert("LIFER_WATCH_PARENT_PID".into(), std::process::id().to_string());
    envs.insert("LIFER_LAUNCH_TOKEN".into(), launch_token().to_string());
    envs.insert("WEB_DIST_DIR".into(), web_dist.to_string_lossy().into_owned());
    // Same "one dedicated, rolling GitHub Release" shape as CATALOG_SEED_URL (embedded_db.rs) —
    // re-uploading a new asset to this same "map-latest" tag publishes an update without
    // needing a new app release. Only inserted when not already set, so a real dev/CI
    // MAP_DOWNLOAD_URL override (e.g. pointing at a local test file) still wins.
    envs
        .entry("MAP_DOWNLOAD_URL".into())
        .or_insert_with(|| "https://github.com/Sparklysparkspark/lifer-app/releases/download/map-latest/world-z8.pmtiles".into());

    // An explicit DATABASE_URL in the environment (development against a real Postgres) is
    // always respected as-is; otherwise local mode is fully self-contained — no separately-
    // running Postgres required anymore. Reuses an already-running embedded instance from an
    // earlier start_api() call in this same process (e.g. re-picking the library folder)
    // rather than trying to set one up on top of it.
    let already_running_url = {
        let guard = state.postgres.lock().unwrap();
        guard.as_ref().map(embedded_db::connection_url)
    };
    let database_url = if let Ok(url) = std::env::var("DATABASE_URL") {
        url
    } else if let Some(url) = already_running_url {
        url
    } else {
        let (postgresql, url) = embedded_db::start_embedded_postgres(&app_data_dir)
            .await
            .map_err(|e| format!("Couldn't start the embedded database: {e}"))?;
        run_migrations(app, &resources, &url).await?;
        // Migrations create the schema; a brand new database still has none of the base
        // species/region taxonomy (a separate one-time "seed" dataset — see this function's own
        // comment). Restoring it here, right after migrations and before the real API starts,
        // is what makes a fresh local library show anything at all instead of an empty shell.
        // Not fatal: the library still opens, and an empty catalog is retried next launch.
        if let Err(e) = embedded_db::restore_catalog_seed_if_needed(&postgresql, &resources).await {
            eprintln!("[start_api] catalog restore failed: {e}");
            app.dialog()
                .message(format!(
                    "Lifer couldn't load the species catalog. It will try again next time Lifer opens, or you can update it from Settings.\n\n{e}"
                ))
                .kind(tauri_plugin_dialog::MessageDialogKind::Warning)
                .show(|_| {});
        }
        *state.postgres.lock().unwrap() = Some(postgresql);
        url
    };
    envs.insert("DATABASE_URL".into(), database_url);
    // Same fallback chain as main.js: the folder chosen in the picker, persisted in config,
    // falling back to a stable per-install default under Tauri's own app data dir.
    let resolved_data_dir = data_dir.unwrap_or_else(|| app_data_dir.join("data").to_string_lossy().into_owned());
    envs.insert("DATA_DIR".into(), resolved_data_dir);
    // Shared app assets (offline basemap, species reference-photo cache) — see config.ts's own
    // comment on why this is deliberately independent of DATA_DIR.
    envs.insert(
        "APP_DATA_DIR".into(),
        app_data_dir.join("app-data").to_string_lossy().into_owned(),
    );

    let tsx_dir = resources.join("node_modules").join("tsx").join("dist");
    let entry = api_dir.join("src").join("index.ts");

    let spec = SpawnSpec {
        api_dir,
        envs,
        args: vec![
            "--require".into(),
            tsx_dir.join("preflight.cjs").to_string_lossy().into_owned(),
            "--import".into(),
            format!("file://{}", tsx_dir.join("loader.mjs").to_string_lossy()),
            entry.to_string_lossy().into_owned(),
        ],
    };
    *state.spawn_spec.lock().unwrap() = Some(spec.clone());
    state.restarts.lock().unwrap().clear();
    spawn_child(app, &spec)
}

fn spawn_child(app: &AppHandle, spec: &SpawnSpec) -> Result<(), String> {
    use tauri::Manager;
    let (mut rx, child) = app
        .shell()
        .sidecar("node")
        .map_err(|e| format!("Couldn't resolve the node sidecar: {e}"))?
        .current_dir(&spec.api_dir)
        .envs(spec.envs.clone())
        .args(spec.args.clone())
        .spawn()
        .map_err(|e| format!("Couldn't start the API: {e}"))?;

    let stopping = Arc::new(AtomicBool::new(false));
    *app.state::<ApiState>().child.lock().unwrap() = Some(RunningChild { child, stopping: stopping.clone() });

    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    print!("[api] {}", String::from_utf8_lossy(&line));
                }
                CommandEvent::Stderr(line) => {
                    let text = String::from_utf8_lossy(&line).into_owned();
                    eprint!("[api] {text}");
                    let state = app_handle.state::<ApiState>();
                    let mut buf = state.recent_stderr.lock().unwrap();
                    buf.push_str(&text);
                    if buf.len() > 4000 {
                        // Cut on a char boundary; split_off panics mid-codepoint.
                        let mut cut = buf.len() - 4000;
                        while !buf.is_char_boundary(cut) {
                            cut += 1;
                        }
                        *buf = buf.split_off(cut);
                    }
                }
                CommandEvent::Terminated(payload) => {
                    let code = payload.code.unwrap_or(-1);
                    if code != 0 && !stopping.load(Ordering::SeqCst) {
                        handle_unexpected_exit(&app_handle, &stopping, code).await;
                    }
                }
                _ => {}
            }
        }
    });

    Ok(())
}

async fn handle_unexpected_exit(app: &AppHandle, stopping: &AtomicBool, code: i32) {
    use tauri::Manager;
    let state = app.state::<ApiState>();
    let can_restart = {
        let mut restarts = state.restarts.lock().unwrap();
        restarts.retain(|t| t.elapsed() < RESTART_WINDOW);
        let ok = restarts.len() < MAX_RESTARTS;
        if ok {
            restarts.push(Instant::now());
        }
        ok
    };
    let spec = state.spawn_spec.lock().unwrap().clone();
    let mut failure = format!("The backend process exited with code {code}.");
    if let (true, Some(spec)) = (can_restart, spec) {
        eprintln!("[api] backend exited with code {code}, restarting");
        tokio::time::sleep(Duration::from_secs(1)).await;
        // stop_api() may have run during the sleep (mode switch or quit): don't resurrect.
        if stopping.load(Ordering::SeqCst) {
            return;
        }
        match spawn_child(app, &spec) {
            Ok(()) => return,
            Err(e) => failure = format!("{failure} Restarting it failed: {e}"),
        }
    }
    let stderr = state.recent_stderr.lock().unwrap().clone();
    let detail = if stderr.trim().is_empty() { "No error output was captured.".to_string() } else { stderr };
    let _ = app.emit("api-crashed", format!("{failure}\n\n{detail}"));
}

// apps/api itself never runs its own migrations (see packages/data-pipeline/src/migrate.ts —
// the Docker image's own CMD runs it as a separate step before starting the server); local
// mode has no equivalent separate step today, so this runs it as a one-off sidecar invocation,
// waited on to completion, right after the embedded database is confirmed up and before the
// real API sidecar starts. Idempotent (schema_migrations tracks what's already applied), so
// safe to run on every start_api() call that just (re)created the embedded instance.
async fn run_migrations(app: &AppHandle, resources: &Path, database_url: &str) -> Result<(), String> {
    let migrate_entry = resources.join("node_modules").join("data-pipeline").join("src").join("migrate.ts");
    let tsx_dir = resources.join("node_modules").join("tsx").join("dist");

    let mut envs: HashMap<String, String> = std::env::vars().collect();
    envs.insert("DATABASE_URL".into(), database_url.to_string());

    let (mut rx, _child) = app
        .shell()
        .sidecar("node")
        .map_err(|e| format!("Couldn't resolve the node sidecar for migrations: {e}"))?
        .envs(envs)
        .args([
            "--require".into(),
            tsx_dir.join("preflight.cjs").to_string_lossy().into_owned(),
            "--import".into(),
            format!("file://{}", tsx_dir.join("loader.mjs").to_string_lossy()),
            migrate_entry.to_string_lossy().into_owned(),
        ])
        .spawn()
        .map_err(|e| format!("Couldn't run database migrations: {e}"))?;

    let mut stderr_output = String::new();
    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stderr(line) => stderr_output.push_str(&String::from_utf8_lossy(&line)),
            CommandEvent::Terminated(payload) => {
                return match payload.code {
                    Some(0) => Ok(()),
                    code => Err(format!(
                        "Database migrations failed (exit code {code:?}):\n{stderr_output}"
                    )),
                };
            }
            _ => {}
        }
    }
    Ok(())
}

pub async fn stop_api_async(app: &AppHandle) {
    use tauri::Manager;
    let state = app.state::<ApiState>();
    let taken = state.child.lock().unwrap().take();
    if let Some(running) = taken {
        running.stopping.store(true, Ordering::SeqCst);
        let _ = running.child.kill();
    }
    let taken_postgres = state.postgres.lock().unwrap().take();
    if let Some(postgresql) = taken_postgres {
        if tokio::time::timeout(Duration::from_secs(10), postgresql.stop()).await.is_err() {
            eprintln!("[stop_api] embedded postgres didn't stop within 10s, proceeding anyway");
        }
    }
}

// Blocking wrapper for sync callers (menu, exit, updater drop hook). Runs on its own thread so
// block_on is never nested inside the async runtime, which panics.
pub fn stop_api(app: &AppHandle) {
    let app = app.clone();
    let _ = std::thread::spawn(move || tauri::async_runtime::block_on(stop_api_async(&app))).join();
}

// Held in the app's resource table: the updater's pre-install exit hook clears that table
// (cleanup_before_exit) right before the Windows installer force-exits us, so Drop stops the API.
pub struct StopApiOnDrop(pub AppHandle);
impl tauri::Resource for StopApiOnDrop {}
impl Drop for StopApiOnDrop {
    fn drop(&mut self) {
        stop_api(&self.0);
    }
}

async fn fetch_ok(url: &str) -> bool {
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(2))
        .build()
    {
        Ok(c) => c,
        Err(_) => return false,
    };
    matches!(client.get(url).send().await, Ok(res) if res.status().as_u16() < 500)
}

/// Polls a URL until it responds (or times out) — the Tauri equivalent of main.js's
/// waitForServer, used both for the freshly-spawned local API and for checking a remote
/// server's reachability before switching modes.
pub async fn wait_for_server(url: &str, timeout_ms: u64) -> Result<(), String> {
    let start = std::time::Instant::now();
    loop {
        if fetch_ok(url).await {
            return Ok(());
        }
        if start.elapsed().as_millis() as u64 > timeout_ms {
            return Err("Lifer's backend didn't respond in time. Check that Postgres is running.".into());
        }
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    }
}

pub async fn is_reachable(url: &str) -> bool {
    fetch_ok(url).await
}

// Backs Settings' (and the picker's) "Sign in" step — a real credential check against the
// REMOTE server's own /auth/login, done natively here rather than as a browser fetch() from the
// renderer, since an arbitrary self-hosted server has no reason to send this app's origin
// permissive CORS headers. This intentionally does NOT establish the actual browsing session
// (the cookie login sets here is just discarded with this one-off client) — it only answers
// "are these credentials good" before the window commits to switching. The real, cookie-backed
// login still happens the normal way, via LoginPage, once the window has actually navigated to
// that server's own origin.
pub async fn test_login(url: &str, email: &str, password: &str) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .build()
        .map_err(|e| e.to_string())?;
    let res = client
        .post(format!("{url}/auth/login"))
        .json(&serde_json::json!({ "email": email, "password": password }))
        .send()
        .await
        .map_err(|_| "Couldn't reach that server.".to_string())?;
    if res.status().is_success() {
        return Ok(());
    }
    #[derive(serde::Deserialize)]
    struct ErrorBody {
        error: Option<String>,
    }
    let message = res.json::<ErrorBody>().await.ok().and_then(|b| b.error).unwrap_or_else(|| "Invalid email or password".into());
    Err(message)
}
