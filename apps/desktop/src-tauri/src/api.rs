// Spawns and supervises the Lifer API as a Node sidecar. apps/api is a plain Fastify server
// configured by env vars, with nothing desktop-specific.
use crate::embedded_db;
use postgresql_embedded::PostgreSQL;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
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
    // Last 4KB of stderr, for the crash dialog.
    pub recent_stderr: Mutex<String>,
    // Embedded Postgres for local mode, kept for the app's lifetime so stop_api() can shut it
    // down and a second start_api() reuses it.
    pub postgres: Mutex<Option<PostgreSQL>>,
}

pub(crate) fn resources_root(app: &AppHandle) -> PathBuf {
    // `tauri dev` has no bundled resources, so use the folder prepare-resources stages.
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

// Dev convenience: copies the repo checkout's offline map into the app data dir. Gated on that
// relative path existing, which is never true for an end-user install.
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

enum LocalApi {
    Absent,
    Ours,
    // Another launch's API, or an older API that predates launchId.
    Foreign,
}

async fn probe_local_api() -> LocalApi {
    #[derive(serde::Deserialize)]
    struct Health {
        #[serde(rename = "launchId")]
        launch_id: Option<String>,
    }
    let Ok(client) = reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
    else {
        return LocalApi::Absent;
    };
    let Ok(res) = client
        .get(format!("http://127.0.0.1:{LOCAL_PORT}/health"))
        .send()
        .await
    else {
        return LocalApi::Absent;
    };
    match res.json::<Health>().await {
        Ok(Health {
            launch_id: Some(id),
        }) if id == crate::local_credential::launch_id() => LocalApi::Ours,
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
    // A force-quit skips our exit handlers, so the sidecar polls this pid and exits once it's gone.
    envs.insert(
        "LIFER_WATCH_PARENT_PID".into(),
        std::process::id().to_string(),
    );
    // The desktop credential (secret) and the per-launch id /health echoes (not secret); see
    // local_credential.rs.
    envs.insert(
        "LIFER_LAUNCH_TOKEN".into(),
        crate::local_credential::launch_token().to_string(),
    );
    envs.insert(
        "LIFER_LAUNCH_ID".into(),
        crate::local_credential::launch_id().to_string(),
    );
    envs.insert(
        "WEB_DIST_DIR".into(),
        web_dist.to_string_lossy().into_owned(),
    );
    // Rolling "map-latest" release, so a map update needs no app release. An env override wins.
    envs
        .entry("MAP_DOWNLOAD_URL".into())
        .or_insert_with(|| "https://github.com/Sparklysparkspark/lifer-app/releases/download/map-latest/world-z8.pmtiles".into());

    // An explicit DATABASE_URL wins (dev). Otherwise use embedded Postgres, reusing one already
    // started in this process.
    let already_running_url = {
        let guard = state.postgres.lock().unwrap();
        guard.as_ref().map(embedded_db::connection_url)
    };
    let database_url = if let Ok(url) = std::env::var("DATABASE_URL") {
        url
    } else if let Some(url) = already_running_url {
        url
    } else {
        let (postgresql, url) = embedded_db::start_embedded_postgres(&app_data_dir, &resources)
            .await
            .map_err(|e| format!("Couldn't start the embedded database: {e}"))?;
        run_migrations(app, &resources, &url).await?;
        // A new database has the schema but no species catalog. Not fatal: the library still
        // opens, and an empty catalog is retried next launch.
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
    // Lets the sidecar's parent watchdog stop the embedded Postgres if this app is killed.
    if let Some((pg_ctl, pg_data)) = state
        .postgres
        .lock()
        .unwrap()
        .as_ref()
        .map(embedded_db::pg_ctl_and_data_dir)
    {
        envs.insert("LIFER_PG_CTL".into(), pg_ctl.to_string_lossy().into_owned());
        envs.insert(
            "LIFER_PG_DATA".into(),
            pg_data.to_string_lossy().into_owned(),
        );
    }
    // Same fallback chain as main.js: the folder chosen in the picker, persisted in config,
    // falling back to a stable per-install default under Tauri's own app data dir.
    let resolved_data_dir =
        data_dir.unwrap_or_else(|| app_data_dir.join("data").to_string_lossy().into_owned());
    envs.insert("DATA_DIR".into(), resolved_data_dir);
    // Shared app assets (offline basemap, reference-photo cache), independent of DATA_DIR.
    envs.insert(
        "APP_DATA_DIR".into(),
        app_data_dir.join("app-data").to_string_lossy().into_owned(),
    );

    // The compiled server (apps/api/scripts/build.mjs).
    let entry = api_dir.join("dist").join("index.js");

    let spec = SpawnSpec {
        api_dir,
        envs,
        args: vec![entry.to_string_lossy().into_owned()],
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
    *app.state::<ApiState>().child.lock().unwrap() = Some(RunningChild {
        child,
        stopping: stopping.clone(),
    });

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
    let detail = if stderr.trim().is_empty() {
        "No error output was captured.".to_string()
    } else {
        stderr
    };
    let _ = app.emit("api-crashed", format!("{failure}\n\n{detail}"));
}

// apps/api doesn't run migrations itself, so run data-pipeline's migrate.ts as a one-off sidecar
// before starting the API. Idempotent via schema_migrations.
async fn run_migrations(
    app: &AppHandle,
    resources: &Path,
    database_url: &str,
) -> Result<(), String> {
    let migrate_entry = resources
        .join("node_modules")
        .join("data-pipeline")
        .join("dist")
        .join("migrate.js");

    let mut envs: HashMap<String, String> = std::env::vars().collect();
    envs.insert("DATABASE_URL".into(), database_url.to_string());

    let (mut rx, _child) = app
        .shell()
        .sidecar("node")
        .map_err(|e| format!("Couldn't resolve the node sidecar for migrations: {e}"))?
        .envs(envs)
        .args([migrate_entry.to_string_lossy().into_owned()])
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
        if tokio::time::timeout(Duration::from_secs(10), postgresql.stop())
            .await
            .is_err()
        {
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

/// Polls a URL until it responds or times out, for the local API and remote servers alike.
pub async fn wait_for_server(url: &str, timeout_ms: u64) -> Result<(), String> {
    let start = std::time::Instant::now();
    loop {
        if fetch_ok(url).await {
            return Ok(());
        }
        if start.elapsed().as_millis() as u64 > timeout_ms {
            return Err(
                "Lifer's backend didn't respond in time. Check that Postgres is running.".into(),
            );
        }
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    }
}

pub async fn is_reachable(url: &str) -> bool {
    fetch_ok(url).await
}

// Checks credentials against a remote server's /auth/login natively, avoiding CORS. The cookie
// is discarded; the real login happens in LoginPage after the window navigates there.
pub async fn test_login(url: &str, email: &str, password: &str) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .build()
        .map_err(|e| e.to_string())?;
    let res = client
        .post(format!("{url}/auth/login"))
        // The API's cross-site guard wants this on non-GET requests from Lifer's own clients.
        .header("x-lifer-client", "1")
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
    let message = res
        .json::<ErrorBody>()
        .await
        .ok()
        .and_then(|b| b.error)
        .unwrap_or_else(|| "Invalid email or password".into());
    Err(message)
}
