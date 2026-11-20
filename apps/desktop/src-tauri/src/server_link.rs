// The link between this app and a server: the API key the local API uses to talk to the server
// on the user's behalf (packs, pushes, the mirror) while the window isn't signed in there. Written
// once per server by the server's own page after sign-in (store_server_link), keyed by the
// server's instance id, and dropped whenever the app stops being connected to that server
// (reconcile, called on every config change). Owner-only file next to the database password.
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, WebviewWindow};

use crate::security::{is_bundled_page, is_local_api, is_trusted_sender};
use crate::{app_data_dir, store};

const FILE: &str = "server-link.json";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ServerLink {
    #[serde(rename = "instanceId")]
    pub instance_id: String,
    // The key's id on the server, so signing out can revoke it.
    #[serde(rename = "keyId")]
    pub key_id: String,
    pub token: String,
    // What the server proves itself with before the key is sent to it (apps/api/src/sync/linkProof.ts).
    // Absent on a link made before servers proved themselves.
    #[serde(
        rename = "linkSecret",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub link_secret: Option<String>,
    // The addresses to try, in the config's order, so the local API needn't read the config.
    #[serde(default)]
    pub urls: Vec<String>,
}

fn urls_for(cfg: &store::DesktopConfig) -> Vec<String> {
    let mut urls: Vec<String> = cfg
        .server_url
        .iter()
        .chain(cfg.local_url.iter())
        .cloned()
        .collect();
    urls.extend(cfg.external_urls.clone().unwrap_or_default());
    urls
}

fn path(app_data: &Path) -> PathBuf {
    app_data.join("app-data").join(FILE)
}

pub fn read(app_data: &Path) -> Option<ServerLink> {
    let text = std::fs::read_to_string(path(app_data)).ok()?;
    serde_json::from_str(&text).ok()
}

fn write(app_data: &Path, link: &ServerLink) -> Result<(), String> {
    let json = serde_json::to_string(link).map_err(|e| e.to_string())?;
    crate::embedded_db::write_secret_file(&path(app_data), &json)
}

pub fn forget(app_data: &Path) -> Option<ServerLink> {
    let link = read(app_data);
    let _ = std::fs::remove_file(path(app_data));
    link
}

/// Keeps the link only while the config still points at the server it was made for, with the
/// config's current addresses.
pub fn reconcile(app_data: &Path, cfg: &store::DesktopConfig) {
    let Some(link) = read(app_data) else { return };
    let same_server = cfg.mode.as_deref() == Some("remote")
        && cfg.server_instance_id.as_deref() == Some(link.instance_id.as_str());
    if !same_server {
        if let Some(old) = forget(app_data) {
            revoke_in_background(app_data, old);
        }
    } else if link.urls != urls_for(cfg) {
        let _ = write(
            app_data,
            &ServerLink {
                urls: urls_for(cfg),
                ..link
            },
        );
    }
}

// Keys whose server couldn't be reached when they were dropped: retried at each launch until it
// answers. Owner-only, like the link itself.
const PENDING_REVOKES: &str = "server-link-revokes.json";
static PENDING_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn pending_path(app_data: &Path) -> PathBuf {
    app_data.join("app-data").join(PENDING_REVOKES)
}

fn read_pending(app_data: &Path) -> Vec<ServerLink> {
    std::fs::read_to_string(pending_path(app_data))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

fn write_pending(app_data: &Path, links: &[ServerLink]) {
    if links.is_empty() {
        let _ = std::fs::remove_file(pending_path(app_data));
    } else if let Ok(json) = serde_json::to_string(links) {
        let _ = crate::embedded_db::write_secret_file(&pending_path(app_data), &json);
    }
}

fn is_link_server(link: &ServerLink, reported_instance: Option<&str>) -> bool {
    reported_instance == Some(link.instance_id.as_str())
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// The proof the linked server gives for a nonce: HMAC-SHA256 of "proof:<nonce>" under the link secret.
fn expected_proof(secret: &str, nonce: &str) -> Option<String> {
    use hmac::{KeyInit, Mac};
    let mut mac = hmac::Hmac::<sha2::Sha256>::new_from_slice(secret.as_bytes()).ok()?;
    mac.update(format!("proof:{nonce}").as_bytes());
    Some(hex(&mac.finalize().into_bytes()))
}

/// Whether the server at `base` answers a fresh nonce with the proof only the linked server can
/// make. A link without a secret is taken on its instance id.
async fn proves_itself(link: &ServerLink, base: &str) -> bool {
    let Some(secret) = &link.link_secret else {
        return true;
    };
    let mut raw = [0u8; 16];
    if getrandom::fill(&mut raw).is_err() {
        return false;
    }
    let nonce = hex(&raw);
    let Ok(client) = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(4))
        .redirect(reqwest::redirect::Policy::none())
        .build()
    else {
        return false;
    };
    let Ok(res) = client
        .get(format!(
            "{base}/api/sync/link/proof?keyId={}&nonce={nonce}",
            link.key_id
        ))
        .send()
        .await
    else {
        return false;
    };
    if !res.status().is_success() {
        return false;
    }
    let Ok(body) = res.json::<serde_json::Value>().await else {
        return false;
    };
    body["proof"].as_str().map(str::to_owned) == expected_proof(secret, &nonce)
}

/// `url` without its trailing slash, when the link's key may be sent there: a secure origin
/// (plain http only on this computer or the local network, since the instance id checked next is
/// public and proves nothing across the internet) that reports the link's own server and proves
/// it holds the link's secret.
pub(crate) async fn trusted_base(link: &ServerLink, url: &str) -> Option<String> {
    let base = url.trim_end_matches('/');
    if !url::Url::parse(base).is_ok_and(|u| crate::security::is_secure_origin(&u)) {
        return None;
    }
    // An address can come to point at another server; the key goes only to its own.
    let reported = crate::api::health_info(&format!("{base}/health"))
        .await
        .and_then(|h| h.instance_id);
    if !is_link_server(link, reported.as_deref()) || !proves_itself(link, base).await {
        return None;
    }
    Some(base.to_string())
}

/// Revokes the key with itself (the app has no session on that server once it's switched away).
/// True once the server answered: revoked, or the key was already gone.
async fn try_revoke(link: &ServerLink) -> bool {
    let Ok(client) = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        // The key goes only to the server's own addresses, never on to a redirect.
        .redirect(reqwest::redirect::Policy::none())
        .build()
    else {
        return false;
    };
    for url in &link.urls {
        let Some(base) = trusted_base(link, url).await else {
            continue;
        };
        let sent = client
            .post(format!("{base}/api/sync/link/revoke"))
            .header("x-api-key", &link.token)
            .send()
            .await;
        if sent.is_ok_and(|r| r.status().is_success() || r.status().as_u16() == 401) {
            return true;
        }
    }
    false
}

/// Revokes a dropped link's key on its server in the background, and remembers it for the next
/// launch if the server can't be reached now.
fn revoke_in_background(app_data: &Path, link: ServerLink) {
    if cfg!(test) {
        return;
    }
    let app_data = app_data.to_path_buf();
    tauri::async_runtime::spawn(async move {
        if !try_revoke(&link).await {
            let _guard = PENDING_LOCK.lock();
            let mut pending = read_pending(&app_data);
            if !pending.iter().any(|p| p.token == link.token) {
                pending.push(link);
                write_pending(&app_data, &pending);
            }
        }
    });
}

/// Retries the keys an earlier launch couldn't revoke. Called once at startup.
pub fn retry_pending_revokes(app_data: &Path) {
    if cfg!(test) || read_pending(app_data).is_empty() {
        return;
    }
    let app_data = app_data.to_path_buf();
    tauri::async_runtime::spawn(async move {
        let tried = read_pending(&app_data);
        let mut still = Vec::new();
        for link in &tried {
            if !try_revoke(link).await {
                still.push(link.clone());
            }
        }
        let _guard = PENDING_LOCK.lock();
        // Keep any a server switch added during this pass.
        still.extend(
            read_pending(&app_data)
                .into_iter()
                .filter(|p| !tried.iter().any(|t| t.token == p.token)),
        );
        write_pending(&app_data, &still);
    });
}

// Only the connected server's own page may ask about or write the link: the local library's
// pages and the picker have no server to link.
fn on_server_page(window: &WebviewWindow) -> bool {
    is_trusted_sender(window)
        && window
            .url()
            .map(|u| !is_bundled_page(window.app_handle(), &u) && !is_local_api(&u))
            .unwrap_or(false)
}

/// Whether the server's page should mint a key for this app: connected to a server, and no key
/// for that server yet.
#[tauri::command]
pub(crate) fn server_link_needed(window: WebviewWindow, app: AppHandle) -> bool {
    if !on_server_page(&window) {
        return false;
    }
    let app_data = app_data_dir(&app);
    let Some(cfg) = store::read_config(&app_data) else {
        return false;
    };
    let Some(instance_id) = cfg.server_instance_id else {
        return false;
    };
    read(&app_data).is_none_or(|link| link.instance_id != instance_id)
}

#[tauri::command]
pub(crate) fn store_server_link(
    window: WebviewWindow,
    app: AppHandle,
    key_id: String,
    token: String,
    link_secret: Option<String>,
) -> Result<(), String> {
    if !on_server_page(&window) {
        return Err("Not allowed from this page.".into());
    }
    let app_data = app_data_dir(&app);
    let cfg = store::read_config(&app_data).ok_or("This app isn't connected to a server.")?;
    let instance_id = cfg
        .server_instance_id
        .clone()
        .ok_or("This app isn't connected to a server.")?;
    write(
        &app_data,
        &ServerLink {
            instance_id,
            key_id,
            token,
            link_secret,
            urls: urls_for(&cfg),
        },
    )?;
    crate::sync::kick(&app);
    Ok(())
}

/// Drops the link and returns the key id so the page can revoke it on the server.
#[tauri::command]
pub(crate) fn forget_server_link(window: WebviewWindow, app: AppHandle) -> Option<String> {
    if !is_trusted_sender(&window) {
        return None;
    }
    forget(&app_data_dir(&app)).map(|link| link.key_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("lifer-server-link-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    fn remote(instance: &str) -> store::DesktopConfig {
        store::DesktopConfig {
            mode: Some("remote".into()),
            server_url: Some("http://nas:4000".into()),
            server_instance_id: Some(instance.into()),
            ..Default::default()
        }
    }

    #[test]
    fn keys_are_revoked_only_at_the_server_they_were_made_for() {
        let link = ServerLink {
            instance_id: "a".into(),
            key_id: "k".into(),
            token: "t".into(),
            link_secret: None,
            urls: vec![],
        };
        assert!(is_link_server(&link, Some("a")));
        assert!(!is_link_server(&link, Some("b")));
        assert!(!is_link_server(&link, None));
    }

    #[test]
    fn the_proof_matches_the_servers_hmac() {
        // HMAC-SHA256(key "s", "proof:n"), as apps/api/src/sync/linkProof.ts computes it.
        assert_eq!(
            expected_proof("s", "n").unwrap(),
            "69d8138853c8c15bb8b61b39525bc600d265dcb2615b273154749a141fb31f23"
        );
        assert_ne!(expected_proof("s", "n"), expected_proof("s", "m"));
    }

    #[test]
    fn unrevoked_keys_are_kept_until_the_list_is_empty() {
        let dir = std::env::temp_dir().join(format!("lifer-revokes-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("app-data")).unwrap();
        let link = ServerLink {
            instance_id: "old".into(),
            key_id: "k1".into(),
            token: "t1".into(),
            link_secret: None,
            urls: vec!["http://old:4000".into()],
        };
        write_pending(&dir, std::slice::from_ref(&link));
        assert_eq!(read_pending(&dir), vec![link]);
        write_pending(&dir, &[]);
        assert!(!pending_path(&dir).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn link_survives_only_while_connected_to_its_server() {
        let dir = temp_dir();
        let link = ServerLink {
            instance_id: "a".into(),
            key_id: "k".into(),
            token: "t".into(),
            link_secret: None,
            urls: vec![],
        };
        write(&dir, &link).unwrap();
        assert_eq!(read(&dir), Some(link.clone()));

        reconcile(&dir, &remote("a"));
        assert_eq!(
            read(&dir).unwrap().urls,
            vec!["http://nas:4000".to_string()],
            "same server keeps it, with its addresses"
        );
        reconcile(&dir, &remote("b"));
        assert!(read(&dir).is_none(), "another server drops it");

        write(&dir, &link).unwrap();
        reconcile(
            &dir,
            &store::DesktopConfig {
                mode: Some("local".into()),
                ..Default::default()
            },
        );
        assert!(read(&dir).is_none(), "leaving the server drops it");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
