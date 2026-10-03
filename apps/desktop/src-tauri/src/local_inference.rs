// Species matching on this computer while connected to a server: runs apps/api's inference-only
// entry on a loopback port with a per-launch token. Pages reach it via lib.rs commands, since an
// https page can't fetch an http loopback address.
use crate::api;
use std::collections::HashMap;
use std::time::Duration;
use tauri::AppHandle;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

const START_TIMEOUT: Duration = Duration::from_secs(30);
const PORT_PREFIX: &str = "LIFER_INFERENCE_PORT=";

struct Sidecar {
    child: CommandChild,
    port: u16,
    token: String,
    // Bumped per spawn, so a stale exit event can't clear a newer child.
    generation: u64,
}

#[derive(Default)]
pub struct LocalInferenceState {
    sidecar: tauri::async_runtime::Mutex<Option<Sidecar>>,
    generation: std::sync::atomic::AtomicU64,
}

fn random_token() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|e| format!("Couldn't generate a token: {e}"))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

async fn spawn(app: &AppHandle, generation: u64) -> Result<Sidecar, String> {
    use tauri::Manager;
    let resources = api::resources_root(app);
    let api_dir = resources.join("api");
    let tsx_dir = resources.join("node_modules").join("tsx").join("dist");
    let entry = api_dir.join("src").join("species").join("localInferenceServer.ts");
    let app_data_dir = app.path().app_data_dir().map_err(|e| format!("Couldn't resolve app data dir: {e}"))?;
    let token = random_token()?;

    let mut envs: HashMap<String, String> = std::env::vars().collect();
    envs.insert("NODE_ENV".into(), "production".into());
    envs.insert("LIFER_INFERENCE_TOKEN".into(), token.clone());
    // The local API's own model folder, so a model downloaded in either mode serves both.
    envs.insert("LIFER_MODEL_DIR".into(), app_data_dir.join("app-data").join("models").to_string_lossy().into_owned());
    envs.insert("LIFER_WATCH_PARENT_PID".into(), std::process::id().to_string());

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
        .map_err(|e| format!("Couldn't start local matching: {e}"))?;

    // The entry prints its port once it's listening.
    let port = tokio::time::timeout(START_TIMEOUT, async {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    let text = String::from_utf8_lossy(&line);
                    if let Some(port) = text.trim().strip_prefix(PORT_PREFIX).and_then(|p| p.parse::<u16>().ok()) {
                        return Ok(port);
                    }
                }
                CommandEvent::Stderr(line) => eprint!("[inference] {}", String::from_utf8_lossy(&line)),
                CommandEvent::Terminated(p) => return Err(format!("Local matching exited on start (code {:?})", p.code)),
                _ => {}
            }
        }
        Err("Local matching exited on start".to_string())
    })
    .await
    .map_err(|_| "Local matching didn't start in time".to_string())
    .and_then(|r| r);
    let port = match port {
        Ok(p) => p,
        Err(e) => {
            let _ = child.kill();
            return Err(e);
        }
    };

    // Keep draining its output; forget it when it exits so the next call starts a fresh one.
    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stderr(line) => eprint!("[inference] {}", String::from_utf8_lossy(&line)),
                CommandEvent::Terminated(_) => {
                    let state = app_handle.state::<LocalInferenceState>();
                    let mut guard = state.sidecar.lock().await;
                    if guard.as_ref().is_some_and(|s| s.generation == generation) {
                        *guard = None;
                    }
                    break;
                }
                _ => {}
            }
        }
    });

    Ok(Sidecar { child, port, token, generation })
}

/// Base URL and token of the running sidecar, starting it first when `start` is set.
async fn endpoint(app: &AppHandle, start: bool) -> Result<Option<(String, String)>, String> {
    use tauri::Manager;
    let state = app.state::<LocalInferenceState>();
    let mut guard = state.sidecar.lock().await;
    if guard.is_none() && start {
        let generation = state.generation.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
        *guard = Some(spawn(app, generation).await?);
    }
    Ok(guard.as_ref().map(|s| (format!("http://127.0.0.1:{}", s.port), s.token.clone())))
}

fn client(timeout: Duration) -> Result<reqwest::Client, String> {
    reqwest::Client::builder().timeout(timeout).build().map_err(|e| e.to_string())
}

async fn json_or_error(res: reqwest::Response) -> Result<serde_json::Value, String> {
    let ok = res.status().is_success();
    let body: serde_json::Value = res.json().await.map_err(|e| format!("Local matching sent a bad reply: {e}"))?;
    if ok {
        return Ok(body);
    }
    Err(body.get("error").and_then(|e| e.as_str()).unwrap_or("Local matching failed").to_string())
}

pub async fn status(app: &AppHandle) -> Result<serde_json::Value, String> {
    let not_started = serde_json::json!({ "available": true, "ready": false, "downloading": false, "error": null });
    let Some((base, token)) = endpoint(app, false).await? else {
        return Ok(not_started);
    };
    let res = client(Duration::from_secs(5))?.get(format!("{base}/status")).bearer_auth(token).send().await;
    match res {
        Ok(res) => {
            let mut body = json_or_error(res).await?;
            body["available"] = serde_json::Value::Bool(true);
            Ok(body)
        }
        Err(_) => Ok(not_started),
    }
}

pub async fn prepare(app: &AppHandle, info: serde_json::Value) -> Result<serde_json::Value, String> {
    let (base, token) = endpoint(app, true).await?.ok_or("Local matching isn't running")?;
    let res = client(Duration::from_secs(10))?
        .post(format!("{base}/prepare"))
        .bearer_auth(token)
        .json(&info)
        .send()
        .await
        .map_err(|e| format!("Couldn't reach local matching: {e}"))?;
    let mut body = json_or_error(res).await?;
    body["available"] = serde_json::Value::Bool(true);
    Ok(body)
}

pub async fn embed(app: &AppHandle, bytes: Vec<u8>, targets: &str) -> Result<serde_json::Value, String> {
    if !targets.chars().all(|c| c.is_ascii_lowercase() || c == '-' || c == ',') {
        return Err("Unknown vector kind".into());
    }
    let (base, token) = endpoint(app, false).await?.ok_or("Local matching isn't running")?;
    let res = client(Duration::from_secs(60))?
        .post(format!("{base}/embed?targets={targets}"))
        .bearer_auth(token)
        .body(bytes)
        .send()
        .await
        .map_err(|e| format!("Couldn't reach local matching: {e}"))?;
    json_or_error(res).await
}

/// On quit. The sidecar's parent watchdog covers a force-quit.
pub fn stop(app: &AppHandle) {
    use tauri::Manager;
    let state = app.state::<LocalInferenceState>();
    let taken = state.sidecar.try_lock().ok().and_then(|mut guard| guard.take());
    if let Some(sidecar) = taken {
        let _ = sidecar.child.kill();
    }
}
