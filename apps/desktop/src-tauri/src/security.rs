// Which pages may load in the window and what they may call: the local API's pages, the
// bundled ones, and the servers in the saved config.
use std::collections::HashSet;
use std::sync::Mutex;
use tauri::ipc::CapabilityBuilder;
use tauri::{AppHandle, Manager, WebviewWindow};
use tauri_plugin_opener::OpenerExt;

use crate::{api, app_data_dir, store, WINDOW_LABEL};

pub(crate) fn is_local_api(url: &url::Url) -> bool {
    url.scheme() == "http"
        && matches!(url.host_str(), Some("127.0.0.1") | Some("localhost"))
        && url.port() == Some(api::LOCAL_PORT)
}

// Full origin (scheme + host + port), so a different service on the same host isn't trusted.
pub(crate) fn is_configured_server(cfg: store::DesktopConfig, url: &url::Url) -> bool {
    let mut candidates = vec![cfg.server_url, cfg.local_url];
    candidates.extend(cfg.external_urls.unwrap_or_default().into_iter().map(Some));
    candidates
        .into_iter()
        .flatten()
        .any(|s| url::Url::parse(&s).is_ok_and(|server| server.origin() == url.origin()))
}

// What a connected server's pages may call. Registered at runtime for the configured origins
// only (see grant_remote_capabilities); there is deliberately no static wildcard capability.
// fs writes are limited to paths the user picked in a save dialog (the dialog plugin adds them
// to the fs scope). capabilities/default.json grants the local API's pages the same set.
const REMOTE_PERMISSIONS: &[&str] = &[
    "core:default",
    "core:window:allow-start-dragging",
    "core:window:allow-set-fullscreen",
    "core:window:allow-is-fullscreen",
    "allow-app-commands",
    "opener:default",
    "dialog:default",
    // downloadFile.ts and the Stats CSV export save through a native Save As dialog.
    "fs:allow-write-file",
    "fs:allow-write-text-file",
];

// Settings > Updates and the update banner update the desktop app itself in remote mode too,
// then relaunch (no process exit). Not for plain-http pages from the internet, which anyone on
// the path could inject script into; installs are signature-checked against tauri.conf.json's
// pubkey either way.
const UPDATE_PERMISSIONS: &[&str] = &[
    "updater:allow-check",
    "updater:allow-download",
    "updater:allow-install",
    "process:allow-restart",
];

// HTTPS, or plain http that stays on this computer or the local network: a home server is
// usually reached as http://192.168.x.x or http://nas.local, never over the public internet.
fn is_secure_origin(url: &url::Url) -> bool {
    url.scheme() == "https" || url.host().is_some_and(|host| is_local_network_host(&host))
}

fn is_local_network_host(host: &url::Host<&str>) -> bool {
    match host {
        url::Host::Ipv4(ip) => {
            let [a, b, ..] = ip.octets();
            // 100.64.0.0/10 is carrier-grade NAT, which Tailscale addresses come from.
            ip.is_loopback()
                || ip.is_private()
                || ip.is_link_local()
                || (a == 100 && (b & 0xc0) == 64)
        }
        url::Host::Ipv6(ip) => {
            ip.is_loopback() || ip.is_unique_local() || ip.is_unicast_link_local()
        }
        // Names only a local resolver answers: single labels like "nas", and suffixes reserved
        // for local networks.
        url::Host::Domain(name) => {
            let name = name.trim_end_matches('.').to_ascii_lowercase();
            !name.contains('.')
                || [".local", ".lan", ".home.arpa", ".internal"]
                    .iter()
                    .any(|suffix| name.ends_with(suffix))
        }
    }
}

fn permissions_for(url: &url::Url) -> Vec<&'static str> {
    let mut permissions = REMOTE_PERMISSIONS.to_vec();
    if is_secure_origin(url) {
        permissions.extend_from_slice(UPDATE_PERMISSIONS);
    }
    permissions
}

// Origins already granted this run. Tauri can add capabilities at runtime but not remove them,
// so a server dropped from the config keeps its grant until relaunch; on_navigation still
// refuses to load it.
#[derive(Default)]
pub(crate) struct RemoteCapabilities(Mutex<HashSet<String>>);

fn configured_origins(cfg: &store::DesktopConfig) -> Vec<url::Url> {
    let mut candidates = vec![cfg.server_url.clone(), cfg.local_url.clone()];
    candidates.extend(
        cfg.external_urls
            .clone()
            .unwrap_or_default()
            .into_iter()
            .map(Some),
    );
    let mut origins: Vec<url::Url> = candidates
        .into_iter()
        .flatten()
        .filter_map(|s| url::Url::parse(&s).ok())
        .filter(|u| matches!(u.scheme(), "http" | "https") && !is_local_api(u))
        .filter_map(|u| u.origin().ascii_serialization().parse().ok())
        .collect();
    origins.sort();
    origins.dedup();
    origins
}

pub(crate) fn grant_remote_capabilities(app: &AppHandle, cfg: &store::DesktopConfig) {
    if cfg.mode.as_deref() != Some("remote") {
        return;
    }
    let state = app.state::<RemoteCapabilities>();
    let mut granted = api::lock(&state.0);
    for url in configured_origins(cfg) {
        let origin = url.origin().ascii_serialization();
        if granted.contains(&origin) {
            continue;
        }
        // Tauri panics on a pattern it can't parse, so check it first.
        if origin
            .parse::<tauri::utils::acl::RemoteUrlPattern>()
            .is_err()
        {
            eprintln!("[lifer] skipping IPC grant for unparseable origin {origin:?}");
            continue;
        }
        let capability = permissions_for(&url).into_iter().fold(
            CapabilityBuilder::new(format!("remote-server-{}", granted.len()))
                .window(WINDOW_LABEL)
                .local(false)
                .remote(origin.clone()),
            |cap, permission| cap.permission(permission),
        );
        match app.add_capability(capability) {
            Ok(()) => {
                granted.insert(origin);
            }
            Err(e) => eprintln!("[lifer] couldn't grant IPC access to {origin}: {e}"),
        }
    }
}

// Only hand safe schemes to the OS; file:// or custom schemes could launch local programs.
pub(crate) fn open_external(app: &AppHandle, url: &url::Url) {
    if matches!(url.scheme(), "http" | "https" | "mailto") {
        let _ = app.opener().open_url(url.to_string(), None::<&str>);
    } else {
        eprintln!("[lifer] blocked opening {} URL", url.scheme());
    }
}

// Setup commands can reconfigure the app, so only honor them from trusted pages. Capability
// allowlists can't express "the server currently in our config," so it's checked here.
pub(crate) fn is_trusted_sender(window: &WebviewWindow) -> bool {
    let url = match window.url() {
        Ok(u) => u,
        Err(_) => return false,
    };
    if url.scheme() == "tauri" {
        return true; // our own bundled index.html/picker.html
    }
    if is_local_api(&url) {
        return true;
    }
    // Any of server_url/local_url/external_urls counts: Automatic URL Switching moves this
    // window between them.
    store::read_config(&app_data_dir(window.app_handle()))
        .is_some_and(|cfg| cfg.mode.as_deref() == Some("remote") && is_configured_server(cfg, &url))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(s: &str) -> url::Url {
        s.parse().unwrap()
    }

    #[test]
    fn plain_http_from_the_internet_gets_no_update_or_restart_permissions() {
        for public in [
            "http://lifer.example.com:4000",
            "http://203.0.113.7:4000",
            "http://[2001:db8::1]:4000",
            "http://nas.local.example.com",
        ] {
            let granted = permissions_for(&url(public));
            assert!(granted.contains(&"fs:allow-write-file"), "{public}");
            for p in UPDATE_PERMISSIONS {
                assert!(!granted.contains(p), "{public} got {p}");
            }
        }
    }

    #[test]
    fn https_and_local_network_servers_can_update_the_app() {
        for trusted in [
            "https://lifer.example.com",
            "http://localhost:3000",
            "http://127.0.0.1:8080",
            "http://[::1]:8080",
            "http://192.168.1.253:4000",
            "http://10.0.0.5:4000",
            "http://172.20.1.2:4000",
            "http://169.254.10.1:4000",
            "http://100.101.102.103:4000",
            "http://[fd12:3456::1]:4000",
            "http://[fe80::1]:4000",
            "http://nas:4000",
            "http://nas.local:4000",
            "http://NAS.LOCAL.:4000",
            "http://lifer.home.arpa:4000",
            "http://lifer.lan",
            "http://lifer.internal",
        ] {
            let granted = permissions_for(&url(trusted));
            for p in UPDATE_PERMISSIONS {
                assert!(granted.contains(p), "{trusted} lacks {p}");
            }
        }
    }

    #[test]
    fn configured_origins_skip_the_local_api_and_dedupe() {
        let cfg = store::DesktopConfig {
            mode: Some("remote".into()),
            server_url: Some("https://lifer.example.com/".into()),
            local_url: Some(format!("http://127.0.0.1:{}", api::LOCAL_PORT)),
            external_urls: Some(vec![
                "https://lifer.example.com/photos".into(),
                "not a url".into(),
                "file:///etc/passwd".into(),
            ]),
            ..Default::default()
        };
        let origins: Vec<String> = configured_origins(&cfg)
            .iter()
            .map(|u| u.origin().ascii_serialization())
            .collect();
        assert_eq!(origins, vec!["https://lifer.example.com".to_string()]);
    }
}
