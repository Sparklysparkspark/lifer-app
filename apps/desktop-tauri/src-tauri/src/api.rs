// Spawns and supervises the Lifer API as a child process — the Tauri equivalent of
// apps/desktop/src/main.js's startApi/stopApi/waitForServer/fetchOk. apps/api itself needs
// ZERO changes for this migration (confirmed: it's a plain Fastify server reading env vars,
// no Electron-specific assumptions anywhere) — only how it's launched changes, from Electron
// repurposing its own binary as Node (ELECTRON_RUN_AS_NODE) to a real vendored Node binary
// run as a Tauri sidecar.
use std::collections::HashMap;
use std::path::PathBuf;
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

pub fn start_api(app: &AppHandle, data_dir: Option<String>) -> Result<(), String> {
    use tauri::Manager;

    let state = app.state::<ApiState>();
    state.stopping_intentionally.store(false, Ordering::SeqCst);

    let resources = resources_root(app);
    let api_dir = resources.join("api");
    let web_dist = resources.join("web");
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Couldn't resolve app data dir: {e}"))?;

    let mut envs: HashMap<String, String> = std::env::vars().collect();
    envs.insert("PORT".into(), LOCAL_PORT.to_string());
    envs.insert("NODE_ENV".into(), "production".into());
    envs.insert("SINGLE_USER_MODE".into(), "1".into());
    envs.insert("WEB_DIST_DIR".into(), web_dist.to_string_lossy().into_owned());
    envs.insert(
        "DATABASE_URL".into(),
        std::env::var("DATABASE_URL").unwrap_or_else(|_| "postgres://lifer:lifer@localhost:5432/lifer".into()),
    );
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

pub fn stop_api(app: &AppHandle) {
    use tauri::Manager;
    let state = app.state::<ApiState>();
    state.stopping_intentionally.store(true, Ordering::SeqCst);
    let taken = state.child.lock().unwrap().take();
    if let Some(child) = taken {
        let _ = child.kill();
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
