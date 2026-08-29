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
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

pub const LOCAL_PORT: u16 = 4310;

#[derive(Default)]
pub struct ApiState {
    pub child: Mutex<Option<CommandChild>>,
    // Set right before stop_api() kills the child on purpose — mirrors main.js's
    // `stoppingIntentionally` flag, so the exit handler can tell "we did this" apart from a
    // real crash (a killed-by-signal process also reports a non-zero/null exit code).
    pub stopping_intentionally: AtomicBool,
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

pub async fn start_api(app: &AppHandle, data_dir: Option<String>) -> Result<(), String> {
    use tauri::Manager;

    // A previous launch's sidecar can outlive this app instance (a crash, a force-quit before
    // stop_api() ran, or simply relaunching quickly enough that the OS hasn't freed the port
    // yet) — spawning another one on the same port then fails immediately with EADDRINUSE,
    // which read as "Lifer stopped unexpectedly" with no useful stderr captured (the crash
    // happens before the child's own stderr pipe produces anything). If something's already
    // answering on LOCAL_PORT, treat it as already-running and just use it rather than
    // fighting it for the port.
    if is_reachable(&format!("http://127.0.0.1:{LOCAL_PORT}/health")).await {
        return Ok(());
    }

    let state = app.state::<ApiState>();
    state.stopping_intentionally.store(false, Ordering::SeqCst);

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
    envs.insert("WEB_DIST_DIR".into(), web_dist.to_string_lossy().into_owned());

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
        embedded_db::restore_catalog_seed_if_needed(&postgresql, &resources)
            .await
            .map_err(|e| format!("Couldn't load the species catalog: {e}"))?;
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

    let (mut rx, child) = app
        .shell()
        .sidecar("node")
        .map_err(|e| format!("Couldn't resolve the node sidecar: {e}"))?
        .current_dir(&api_dir)
        .envs(envs)
        .args([
            "--require".into(),
            tsx_dir.join("preflight.cjs").to_string_lossy().into_owned(),
            "--import".into(),
            format!("file://{}", tsx_dir.join("loader.mjs").to_string_lossy()),
            entry.to_string_lossy().into_owned(),
        ])
        .spawn()
        .map_err(|e| format!("Couldn't start the API: {e}"))?;

    *state.child.lock().unwrap() = Some(child);

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
                    let len = buf.len();
                    if len > 4000 {
                        *buf = buf.split_off(len - 4000);
                    }
                }
                CommandEvent::Terminated(payload) => {
                    let state = app_handle.state::<ApiState>();
                    let intentional = state.stopping_intentionally.load(Ordering::SeqCst);
                    let code = payload.code.unwrap_or(-1);
                    if code != 0 && !intentional {
                        let stderr = state.recent_stderr.lock().unwrap().clone();
                        let detail = if stderr.trim().is_empty() {
                            "No error output was captured.".to_string()
                        } else {
                            stderr
                        };
                        let _ = app_handle.emit(
                            "api-crashed",
                            format!("The backend process exited with code {code}.\n\n{detail}"),
                        );
                    }
                }
                _ => {}
            }
        }
    });

    Ok(())
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

pub fn stop_api(app: &AppHandle) {
    use tauri::Manager;
    let state = app.state::<ApiState>();
    state.stopping_intentionally.store(true, Ordering::SeqCst);
    let taken = state.child.lock().unwrap().take();
    if let Some(child) = taken {
        let _ = child.kill();
    }
    // Blocks until this actually finishes (bounded by a timeout), rather than firing an async
    // task and returning immediately — a fire-and-forget version raced a caller that relaunches
    // right after this returns (or the whole app process exiting before the spawned task ever
    // got scheduled) into "another server might be running" on the very next start, which
    // happened for real: this function returning was no guarantee postgres had actually stopped
    // yet. block_on is safe here — this always runs on the main/event thread (RunEvent's own
    // callback, or a plain menu-item handler), never from inside the async runtime's own worker
    // pool, so there's no risk of deadlocking against it.
    let taken_postgres = state.postgres.lock().unwrap().take();
    if let Some(postgresql) = taken_postgres {
        let stopped = tauri::async_runtime::block_on(async {
            tokio::time::timeout(std::time::Duration::from_secs(10), postgresql.stop()).await
        });
        if stopped.is_err() {
            eprintln!("[stop_api] embedded postgres didn't stop within 10s, proceeding anyway");
        }
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
