// Keeps this computer's library and the linked server in step while the window is on the server:
// the local API runs alongside (api.rs) and does the work; this module only starts it and shows
// the one question that's the user's to answer, downloading packs the server has onto this
// computer. Runs after connecting and after the link is first made (server_link.rs).
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

use crate::api::LOCAL_PORT;
use crate::{api, local_credential};

const POLL_SECS: u64 = 3;
const MAX_POLLS: u32 = 100;
// The mirror of the server's collection is refreshed this often while connected.
const PULL_EVERY_SECS: u64 = 30 * 60;
static PERIODIC: AtomicBool = AtomicBool::new(false);
static RUNNING: AtomicBool = AtomicBool::new(false);
// Asked for while one ran: the running sync does one more pass when it finishes, so a link made
// mid-sync is synced at once and a burst of requests becomes one extra pass, not several.
static AGAIN: AtomicBool = AtomicBool::new(false);

/// Held while a sync runs; a second one asked for meanwhile waits for it (see AGAIN).
struct InFlight;

impl InFlight {
    fn begin() -> Option<Self> {
        (!RUNNING.swap(true, Ordering::SeqCst)).then_some(InFlight)
    }
}

impl Drop for InFlight {
    fn drop(&mut self) {
        RUNNING.store(false, Ordering::SeqCst);
    }
}

fn linked(app: &AppHandle) -> bool {
    crate::server_link::read(&crate::app_data_dir(app)).is_some()
}

#[derive(serde::Deserialize)]
struct PackOnServer {
    id: String,
    region: Option<String>,
    #[serde(rename = "seaZone")]
    sea_zone: Option<String>,
    taxon: Option<String>,
}

#[derive(serde::Deserialize)]
struct PackSyncResult {
    #[serde(rename = "serverOnly")]
    server_only: Vec<PackOnServer>,
}

#[derive(serde::Deserialize)]
struct PackJob {
    running: bool,
    result: Option<PackSyncResult>,
}

#[derive(serde::Deserialize)]
struct SyncStatus {
    packs: PackJob,
}

fn client() -> Option<reqwest::Client> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .ok()
}

// The launch token goes only to this launch's own API, never to another program on the port.
pub(crate) async fn local_client() -> Result<reqwest::Client, String> {
    if !api::local_api_is_ours().await {
        return Err("The library on this computer isn't running.".into());
    }
    client().ok_or_else(|| "no http client".into())
}

fn local(path: &str) -> String {
    format!("http://127.0.0.1:{LOCAL_PORT}{path}")
}

/// Starts a pack reconcile and a mirror pull in the background, starting the local API first if
/// it isn't up, and keeps the mirror fresh from then on.
pub(crate) fn kick(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            let Some(busy) = InFlight::begin() else {
                AGAIN.store(true, Ordering::SeqCst);
                // The running one may have finished just before AGAIN was set: then run it here.
                if RUNNING.load(Ordering::SeqCst) {
                    break;
                }
                continue;
            };
            AGAIN.store(false, Ordering::SeqCst);
            if let Err(e) = run(&app).await {
                eprintln!("[lifer] sync: {e}");
            }
            drop(busy);
            if !AGAIN.load(Ordering::SeqCst) {
                break;
            }
        }
        if linked(&app) && !PERIODIC.swap(true, Ordering::SeqCst) {
            loop {
                tokio::time::sleep(std::time::Duration::from_secs(PULL_EVERY_SECS)).await;
                // Cleared so linking again (to this or another server) starts a fresh loop.
                if !linked(&app) {
                    PERIODIC.store(false, Ordering::SeqCst);
                    break;
                }
                let Some(busy) = InFlight::begin() else {
                    continue;
                };
                // The local API may have stopped since (a crash): start it again first.
                let synced =
                    match api::start_api(&app, crate::commands::remembered_local_dir(&app)).await {
                        Ok(()) => push_then_pull(&app).await,
                        Err(e) => Err(e),
                    };
                if let Err(e) = synced {
                    eprintln!("[lifer] sync: {e}");
                }
                drop(busy);
                // A sync asked for during this pass was turned away (see kick): run it now.
                if AGAIN.swap(false, Ordering::SeqCst) {
                    kick(&app);
                }
            }
        }
    });
}

/// What this computer changed goes up first, so an edit made while away lands before the
/// server's copy comes back down. The pull waits for the push to finish, whatever its result.
async fn push_then_pull(app: &AppHandle) -> Result<(), String> {
    post(&local("/api/sync/push/start")).await?;
    let mut finished = false;
    for _ in 0..MAX_POLLS * 10 {
        tokio::time::sleep(std::time::Duration::from_secs(POLL_SECS)).await;
        // Unlinked meanwhile: the key is being revoked, so the push stops; there's nothing to pull.
        if !linked(app) {
            return Ok(());
        }
        // A status that can't be read just now is asked again.
        if push_running().await == Some(false) {
            finished = true;
            break;
        }
    }
    if !finished {
        return Err("The push to the server is still running; the next sync pulls.".into());
    }
    if !linked(app) {
        return Ok(());
    }
    post(&local("/api/sync/pull")).await?;
    Ok(())
}

async fn push_running() -> Option<bool> {
    let status: serde_json::Value = local_client()
        .await
        .ok()?
        .get(local("/api/sync/status"))
        .header("x-lifer-launch-token", local_credential::launch_token())
        .send()
        .await
        .ok()?
        .json()
        .await
        .ok()?;
    status["push"]["running"].as_bool()
}

// A job already running answers 200 with started: false; anything not 2xx is a failure.
async fn post(url: &str) -> Result<reqwest::Response, String> {
    let res = local_client()
        .await?
        .post(url)
        .header("x-lifer-launch-token", local_credential::launch_token())
        .header("x-lifer-client", "1")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("{url} answered {}", res.status()));
    }
    Ok(res)
}

async fn run(app: &AppHandle) -> Result<(), String> {
    // Without a link there's nothing to sync, so a server-only install never starts the local
    // database.
    if !linked(app) {
        return Ok(());
    }
    api::start_api(app, crate::commands::remembered_local_dir(app)).await?;
    let client = local_client().await?;
    let token = local_credential::launch_token();
    post(&local("/api/sync/packs/reconcile")).await?;
    if !linked(app) {
        return Ok(());
    }
    // Then the collection: this computer's additions up, the server's collection down. Neither
    // needs anything from the user.
    push_then_pull(app).await?;
    for _ in 0..MAX_POLLS {
        tokio::time::sleep(std::time::Duration::from_secs(POLL_SECS)).await;
        let status: SyncStatus = client
            .get(local("/api/sync/status"))
            .header("x-lifer-launch-token", token)
            .send()
            .await
            .map_err(|e| e.to_string())?
            .json()
            .await
            .map_err(|e| e.to_string())?;
        if status.packs.running {
            continue;
        }
        if let Some(result) = status.packs.result {
            if !result.server_only.is_empty() {
                offer_pull(app, result.server_only);
            }
        }
        return Ok(());
    }
    Ok(())
}

/// The local API's sync status, for Settings while the window is on the server (which can't
/// reach the local API itself). Null when the local API isn't up.
#[tauri::command]
pub(crate) async fn sync_status(
    window: tauri::WebviewWindow,
) -> Result<Option<serde_json::Value>, String> {
    if !crate::security::is_trusted_sender(&window) {
        return Err("Not allowed from this page.".into());
    }
    let Ok(client) = local_client().await else {
        return Ok(None);
    };
    let res = client
        .get(local("/api/sync/status"))
        .header("x-lifer-launch-token", local_credential::launch_token())
        .send()
        .await;
    match res {
        Ok(r) if r.status().is_success() => Ok(r.json().await.ok()),
        _ => Ok(None),
    }
}

#[tauri::command]
pub(crate) async fn sync_set_derivative(
    window: tauri::WebviewWindow,
    derivative: String,
) -> Result<(), String> {
    if !crate::security::is_trusted_sender(&window) {
        return Err("Not allowed from this page.".into());
    }
    let res = local_client()
        .await?
        .post(local("/api/sync/settings"))
        .header("x-lifer-launch-token", local_credential::launch_token())
        .header("x-lifer-client", "1")
        .json(&serde_json::json!({ "derivative": derivative }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if res.status().is_success() {
        post(&local("/api/sync/pull")).await?;
        Ok(())
    } else {
        Err(format!(
            "The library on this computer answered {}",
            res.status()
        ))
    }
}

/// The user's yes to "this server looks new": send this library to it again from the start.
#[tauri::command]
pub(crate) async fn sync_adopt(window: tauri::WebviewWindow, app: AppHandle) -> Result<(), String> {
    if !crate::security::is_trusted_sender(&window) {
        return Err("Not allowed from this page.".into());
    }
    post(&local("/api/sync/adopt")).await?;
    kick(&app);
    Ok(())
}

/// Settings' "Sync now".
#[tauri::command]
pub(crate) async fn sync_now(window: tauri::WebviewWindow, app: AppHandle) -> Result<(), String> {
    if !crate::security::is_trusted_sender(&window) {
        return Err("Not allowed from this page.".into());
    }
    kick(&app);
    Ok(())
}

fn pack_label(p: &PackOnServer) -> String {
    let place = p
        .region
        .clone()
        .or_else(|| p.sea_zone.clone())
        .unwrap_or_else(|| p.id.clone());
    match &p.taxon {
        Some(taxon) => format!("{place} ({taxon})"),
        None => place,
    }
}

fn offer_pull(app: &AppHandle, packs: Vec<PackOnServer>) {
    let names: Vec<String> = packs.iter().map(pack_label).collect();
    let ids: Vec<String> = packs.iter().map(|p| p.id.clone()).collect();
    let app2 = app.clone();
    app.dialog()
        .message(format!(
            "Your server has downloaded regions this computer doesn't:\n\n{}\n\nDownload them here too, so your library looks the same when the server can't be reached?",
            names.join("\n")
        ))
        .title("Regions on your server")
        .buttons(tauri_plugin_dialog::MessageDialogButtons::OkCancelCustom(
            "Download".into(),
            "Not Now".into(),
        ))
        .show(move |yes| {
            if !yes {
                return;
            }
            tauri::async_runtime::spawn(async move {
                let client = match local_client().await {
                    Ok(client) => client,
                    Err(e) => {
                        app2.dialog()
                            .message(format!("Couldn't start the region download: {e}"))
                            .kind(tauri_plugin_dialog::MessageDialogKind::Error)
                            .show(|_| {});
                        return;
                    }
                };
                let res = client
                    .post(local("/api/sync/packs/pull"))
                    .header("x-lifer-launch-token", local_credential::launch_token())
                    .header("x-lifer-client", "1")
                    .json(&serde_json::json!({ "packIds": ids }))
                    .send()
                    .await;
                if let Err(e) = res {
                    app2.dialog()
                        .message(format!("Couldn't start the region download: {e}"))
                        .kind(tauri_plugin_dialog::MessageDialogKind::Error)
                        .show(|_| {});
                }
            });
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_second_sync_is_skipped_while_one_runs() {
        let first = InFlight::begin().expect("nothing running yet");
        assert!(InFlight::begin().is_none(), "skipped while the first runs");
        drop(first);
        assert!(InFlight::begin().is_some(), "free again once it finishes");
    }
}
