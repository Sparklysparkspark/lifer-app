// "Keep an offline cache after connecting" (server mode). A read-only copy of the signed-in
// user's collection on the connected server: names, collected/seen state and small cover
// thumbnails, never full photos. Lives in <app data>/offline-cache and is shown by the bundled
// offline.html page when the server can't be reached (see show_offline_or_local in lib.rs).
//
// The server's own web page fills it (apps/web/src/lib/offlineCache.ts), because only that page
// holds the server session; this side never sees a password, cookie or API key. The cache
// belongs to one server and one user (owner.json): a different user or server wipes it before
// anything is written, and store::write_config reconciles it on every config change, so turning
// the option off, switching servers or leaving server mode deletes it.
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use tauri::{Manager, WebviewWindow};

use crate::store::DesktopConfig;

pub const OFFLINE_PAGE: &str = "tauri://localhost/offline.html";
const DIR_NAME: &str = "offline-cache";
const MANIFEST: &str = "collection.json";
const OWNER: &str = "owner.json";
const THUMBS: &str = "thumbs";
const FORMAT_VERSION: u32 = 1;

// Bounds, so a large catalog or a misbehaving page can't fill the disk. 3,000 thumbnails of at
// most 48 KB is a hard ceiling of about 150 MB; the page sends ~192 px JPEGs of 5 to 15 KB.
pub const MAX_ITEMS: usize = 60_000;
pub const MAX_THUMBS: usize = 3_000;
pub const MAX_THUMB_BYTES: usize = 48 * 1024;
const MAX_TEXT: usize = 200;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CachedItem {
    pub species_id: String,
    #[serde(default)]
    pub common_name: Option<String>,
    pub scientific_name: String,
    #[serde(default)]
    pub taxon_class: Option<String>,
    #[serde(default)]
    pub family: Option<String>,
    /// "collected", "seen" or "unseen".
    pub state: String,
    /// Identifies the thumbnail's source version (the cover URL it was made from), so a sync only
    /// refetches covers that changed. None when no thumbnail is cached for this species.
    #[serde(default)]
    pub thumb_key: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub version: u32,
    pub server: String,
    pub user_id: String,
    /// Unix milliseconds of the last completed sync.
    pub synced_at: u64,
    pub items: Vec<CachedItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct Owner {
    server: String,
    user_id: String,
}

/// What a sync starts from: when the last one finished and which thumbnails it can reuse.
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SyncStart {
    pub synced_at: Option<u64>,
    pub thumbs: std::collections::BTreeMap<String, String>,
    pub max_thumbs: usize,
    pub max_thumb_bytes: usize,
}

/// For Settings, Server: how big the cache is and when it was last synced.
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CacheInfo {
    pub enabled: bool,
    pub synced_at: Option<u64>,
    pub species: usize,
    pub thumbs: usize,
    pub bytes: u64,
    pub path: String,
    /// The asking page is the connected server's own, the only kind that can sync.
    pub from_server: bool,
}

pub fn cache_dir(app_data: &Path) -> PathBuf {
    app_data.join(DIR_NAME)
}

/// The server a cache belongs to: the single address, or the local address under Automatic URL
/// Switching (its external addresses are the same server). None outside server mode.
pub fn server_key(cfg: &DesktopConfig) -> Option<String> {
    if cfg.mode.as_deref() != Some("remote") {
        return None;
    }
    cfg.server_url
        .as_ref()
        .or(cfg.local_url.as_ref())
        .map(|s| s.trim().trim_end_matches('/').to_string())
        .filter(|s| !s.is_empty())
}

/// On by default (the Settings checkbox starts ticked; the first-launch picker doesn't ask).
pub fn enabled(cfg: &DesktopConfig) -> bool {
    cfg.offline_mode != Some(false) && server_key(cfg).is_some()
}

pub fn clear(app_data: &Path) -> std::io::Result<()> {
    match fs::remove_dir_all(cache_dir(app_data)) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e),
        _ => Ok(()),
    }
}

/// Deletes the cache unless it's on and belongs to the configured server. Called on every config
/// write (store.rs), so unticking the option, switching servers or going local all remove it.
pub fn reconcile(app_data: &Path, cfg: &DesktopConfig) {
    let keep = enabled(cfg)
        && match read_owner(app_data) {
            Some(owner) => Some(owner.server) == server_key(cfg),
            // Nothing written yet, or a stray folder from an interrupted first sync.
            None => !cache_dir(app_data).exists(),
        };
    if !keep {
        if let Err(e) = clear(app_data) {
            eprintln!("[lifer] couldn't delete the offline cache: {e}");
        }
    }
}

fn read_owner(app_data: &Path) -> Option<Owner> {
    let text = fs::read_to_string(cache_dir(app_data).join(OWNER)).ok()?;
    serde_json::from_str(&text).ok()
}

pub fn read_manifest(app_data: &Path) -> Option<Manifest> {
    let text = fs::read_to_string(cache_dir(app_data).join(MANIFEST)).ok()?;
    let manifest: Manifest = serde_json::from_str(&text).ok()?;
    (manifest.version == FORMAT_VERSION).then_some(manifest)
}

/// The cache to show offline, only when it's on and belongs to the configured server and to the
/// user who synced it.
pub fn usable(app_data: &Path, cfg: &DesktopConfig) -> Option<Manifest> {
    if !enabled(cfg) {
        return None;
    }
    let owner = read_owner(app_data)?;
    let manifest = read_manifest(app_data)?;
    (Some(&owner.server) == server_key(cfg).as_ref()
        && manifest.server == owner.server
        && manifest.user_id == owner.user_id)
        .then_some(manifest)
}

fn valid_id(id: &str) -> bool {
    // Species ids are UUIDs. Anything else is refused, which also rules out path tricks.
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}

fn thumb_path(app_data: &Path, species_id: &str) -> PathBuf {
    cache_dir(app_data)
        .join(THUMBS)
        .join(format!("{species_id}.jpg"))
}

fn write_atomic(path: &Path, contents: &[u8]) -> std::io::Result<()> {
    let dir = path.parent().expect("cache paths have a parent");
    fs::create_dir_all(dir)?;
    let tmp = dir.join(format!(
        ".{}.{}.tmp",
        path.file_name().unwrap_or_default().to_string_lossy(),
        std::process::id()
    ));
    let result = (|| {
        let mut file = fs::File::create(&tmp)?;
        file.write_all(contents)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&tmp, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

fn require_owner(app_data: &Path, cfg: &DesktopConfig, user_id: &str) -> Result<String, String> {
    if !enabled(cfg) {
        return Err("The offline cache is turned off.".into());
    }
    let server = server_key(cfg).ok_or("Not connected to a server.")?;
    match read_owner(app_data) {
        Some(owner) if owner.server == server && owner.user_id == user_id => Ok(server),
        _ => {
            Err("The offline cache belongs to another account or server. Start a new sync.".into())
        }
    }
}

/// Starts a sync for this server and user, wiping a cache that belongs to anyone else first.
pub fn begin_sync(
    app_data: &Path,
    cfg: &DesktopConfig,
    user_id: &str,
) -> Result<SyncStart, String> {
    if !enabled(cfg) {
        return Err("The offline cache is turned off.".into());
    }
    let server = server_key(cfg).ok_or("Not connected to a server.")?;
    if user_id.is_empty() || user_id.len() > 128 {
        return Err("Missing user.".into());
    }
    let owner = Owner {
        server: server.clone(),
        user_id: user_id.to_string(),
    };
    if read_owner(app_data).as_ref() != Some(&owner) {
        clear(app_data).map_err(|e| e.to_string())?;
        let json = serde_json::to_vec(&owner).map_err(|e| e.to_string())?;
        write_atomic(&cache_dir(app_data).join(OWNER), &json).map_err(|e| e.to_string())?;
    }
    let manifest = read_manifest(app_data).filter(|m| m.server == server && m.user_id == user_id);
    let thumbs = manifest
        .as_ref()
        .map(|m| {
            m.items
                .iter()
                .filter_map(|i| {
                    let key = i.thumb_key.clone()?;
                    thumb_path(app_data, &i.species_id)
                        .exists()
                        .then(|| (i.species_id.clone(), key))
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(SyncStart {
        synced_at: manifest.map(|m| m.synced_at),
        thumbs,
        max_thumbs: MAX_THUMBS,
        max_thumb_bytes: MAX_THUMB_BYTES,
    })
}

fn is_jpeg(bytes: &[u8]) -> bool {
    bytes.len() > 4 && bytes[0] == 0xFF && bytes[1] == 0xD8 && bytes[2] == 0xFF
}

pub fn put_thumb(
    app_data: &Path,
    cfg: &DesktopConfig,
    user_id: &str,
    species_id: &str,
    bytes: &[u8],
) -> Result<(), String> {
    require_owner(app_data, cfg, user_id)?;
    if !valid_id(species_id) {
        return Err("Invalid species id.".into());
    }
    if bytes.len() > MAX_THUMB_BYTES {
        return Err("Thumbnail too large.".into());
    }
    if !is_jpeg(bytes) {
        return Err("Thumbnails must be JPEG.".into());
    }
    let path = thumb_path(app_data, species_id);
    if !path.exists() {
        let count = fs::read_dir(cache_dir(app_data).join(THUMBS))
            .map(|d| {
                d.filter(|e| e.as_ref().is_ok_and(|e| is_thumb_file(&e.path())))
                    .count()
            })
            .unwrap_or(0);
        if count >= MAX_THUMBS {
            return Err("The offline cache already holds the most thumbnails it keeps.".into());
        }
    }
    write_atomic(&path, bytes).map_err(|e| e.to_string())
}

fn is_thumb_file(path: &Path) -> bool {
    path.extension().is_some_and(|e| e == "jpg")
        && !path
            .file_name()
            .is_some_and(|n| n.to_string_lossy().starts_with('.'))
}

fn clip(s: String) -> String {
    if s.len() <= MAX_TEXT {
        return s;
    }
    let mut end = MAX_TEXT;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    s[..end].to_string()
}

fn clean_item(item: CachedItem) -> Option<CachedItem> {
    if !valid_id(&item.species_id) {
        return None;
    }
    let state = match item.state.as_str() {
        "collected" | "seen" => item.state,
        _ => "unseen".to_string(),
    };
    Some(CachedItem {
        species_id: item.species_id,
        common_name: item.common_name.map(clip),
        scientific_name: clip(item.scientific_name),
        taxon_class: item.taxon_class.map(clip),
        family: item.family.map(clip),
        state,
        thumb_key: item.thumb_key.map(clip),
    })
}

/// Finishes a sync: saves the collection and drops thumbnails nothing references any more.
pub fn commit(
    app_data: &Path,
    cfg: &DesktopConfig,
    user_id: &str,
    items: Vec<CachedItem>,
    now_ms: u64,
) -> Result<Manifest, String> {
    let server = require_owner(app_data, cfg, user_id)?;
    if items.len() > MAX_ITEMS {
        return Err("Too many species for the offline cache.".into());
    }
    let mut keep = std::collections::HashSet::new();
    let items: Vec<CachedItem> = items
        .into_iter()
        .filter_map(clean_item)
        .map(|mut item| {
            if item.thumb_key.is_some() && thumb_path(app_data, &item.species_id).exists() {
                keep.insert(format!("{}.jpg", item.species_id));
            } else {
                item.thumb_key = None;
            }
            item
        })
        .collect();
    if let Ok(entries) = fs::read_dir(cache_dir(app_data).join(THUMBS)) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if !keep.contains(&name) {
                let _ = fs::remove_file(entry.path());
            }
        }
    }
    let manifest = Manifest {
        version: FORMAT_VERSION,
        server,
        user_id: user_id.to_string(),
        synced_at: now_ms,
        items,
    };
    let json = serde_json::to_vec(&manifest).map_err(|e| e.to_string())?;
    write_atomic(&cache_dir(app_data).join(MANIFEST), &json).map_err(|e| e.to_string())?;
    Ok(manifest)
}

pub fn info(app_data: &Path, cfg: &DesktopConfig) -> CacheInfo {
    let manifest = usable(app_data, cfg);
    let mut bytes = 0;
    let mut thumbs = 0;
    if let Ok(entries) = fs::read_dir(cache_dir(app_data).join(THUMBS)) {
        for entry in entries.flatten() {
            if is_thumb_file(&entry.path()) {
                thumbs += 1;
                bytes += entry.metadata().map(|m| m.len()).unwrap_or(0);
            }
        }
    }
    bytes += fs::metadata(cache_dir(app_data).join(MANIFEST))
        .map(|m| m.len())
        .unwrap_or(0);
    CacheInfo {
        enabled: enabled(cfg),
        synced_at: manifest.as_ref().map(|m| m.synced_at),
        species: manifest.as_ref().map(|m| m.items.len()).unwrap_or(0),
        thumbs,
        bytes,
        path: cache_dir(app_data).to_string_lossy().into_owned(),
        from_server: false,
    }
}

/// A cached thumbnail as a data: URL (the bundled pages' CSP allows data: images, not blob:).
pub fn thumb_data_url(app_data: &Path, cfg: &DesktopConfig, species_id: &str) -> Option<String> {
    usable(app_data, cfg)?;
    if !valid_id(species_id) {
        return None;
    }
    let bytes = fs::read(thumb_path(app_data, species_id)).ok()?;
    Some(format!("data:image/jpeg;base64,{}", base64(&bytes)))
}

fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(ALPHABET[(n >> (18 - 6 * i) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ---- Switching the window -------------------------------------------------------------------

/// True while the window shows the cached collection.
pub fn showing(window: &WebviewWindow) -> bool {
    window.url().is_ok_and(|u| {
        u.path() == "/offline.html"
            && (u.scheme() == "tauri" || u.host_str() == Some("tauri.localhost"))
    })
}

/// The server can't be reached: show the cached collection when there is one for this server,
/// otherwise the library on this computer as before.
pub async fn show_offline_or_local(
    app: &tauri::AppHandle,
    window: &WebviewWindow,
    cfg: &DesktopConfig,
) {
    if usable(&crate::app_data_dir(app), cfg).is_some() {
        crate::navigate_or_picker(window, OFFLINE_PAGE);
    } else {
        crate::use_local_while_offline(app, window, cfg).await;
    }
}

// ---- Tauri commands -------------------------------------------------------------------------

// The offline page's "Try again": back to the server if any configured address answers.
#[tauri::command]
pub async fn offline_retry(window: WebviewWindow) -> Result<bool, String> {
    let (_, cfg) = require_bundled_page(&window)?;
    match crate::reachable_server(&cfg).await {
        Some(url) => {
            crate::navigate_or_picker(&window, &url);
            Ok(true)
        }
        None => Ok(false),
    }
}

// The offline page's "Work in this computer's library": the existing offline fallback, for adding
// photos while away (they're pushed to the server later, see watch_server in lib.rs).
#[tauri::command]
pub async fn offline_use_local_library(window: WebviewWindow) -> Result<(), String> {
    let (_, cfg) = require_bundled_page(&window)?;
    if cfg.mode.as_deref() != Some("remote") {
        return Err("Not connected to a server.".into());
    }
    crate::use_local_while_offline(window.app_handle(), &window, &cfg).await;
    Ok(())
}

fn config(window: &WebviewWindow) -> (PathBuf, DesktopConfig) {
    let app_data = crate::app_data_dir(window.app_handle());
    let cfg = crate::store::read_config(&app_data).unwrap_or_default();
    (app_data, cfg)
}

// Writes come only from the connected server's own pages (the ones holding its session).
fn require_server_page(window: &WebviewWindow) -> Result<(PathBuf, DesktopConfig), String> {
    let url = window
        .url()
        .map_err(|_| "Not allowed from this page.".to_string())?;
    let (app_data, cfg) = config(window);
    if cfg.mode.as_deref() == Some("remote") && crate::is_configured_server(cfg.clone(), &url) {
        Ok((app_data, cfg))
    } else {
        Err("Not allowed from this page.".into())
    }
}

// Reads come only from the bundled offline page.
fn require_bundled_page(window: &WebviewWindow) -> Result<(PathBuf, DesktopConfig), String> {
    match window.url() {
        Ok(url) if url.scheme() == "tauri" || url.host_str() == Some("tauri.localhost") => {
            Ok(config(window))
        }
        _ => Err("Not allowed from this page.".into()),
    }
}

#[tauri::command]
pub fn offline_cache_begin(window: WebviewWindow, user_id: String) -> Result<SyncStart, String> {
    let (app_data, cfg) = require_server_page(&window)?;
    begin_sync(&app_data, &cfg, &user_id)
}

// The JPEG arrives as the raw IPC body; x-lifer-user and x-lifer-species name it.
#[tauri::command]
pub fn offline_cache_put_thumb(
    window: WebviewWindow,
    request: tauri::ipc::Request<'_>,
) -> Result<(), String> {
    let (app_data, cfg) = require_server_page(&window)?;
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("Expected the thumbnail as raw bytes.".into());
    };
    let header = |name: &str| {
        request
            .headers()
            .get(name)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string()
    };
    put_thumb(
        &app_data,
        &cfg,
        &header("x-lifer-user"),
        &header("x-lifer-species"),
        bytes,
    )
}

#[tauri::command]
pub fn offline_cache_commit(
    window: WebviewWindow,
    user_id: String,
    items: Vec<CachedItem>,
) -> Result<u64, String> {
    let (app_data, cfg) = require_server_page(&window)?;
    commit(&app_data, &cfg, &user_id, items, now_ms()).map(|m| m.synced_at)
}

#[tauri::command]
pub fn offline_cache_clear(window: WebviewWindow) -> Result<(), String> {
    if !crate::is_trusted_sender(&window) {
        return Err("Not allowed from this page.".into());
    }
    let (app_data, _) = config(&window);
    clear(&app_data).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn offline_cache_info(window: WebviewWindow) -> Result<CacheInfo, String> {
    if !crate::is_trusted_sender(&window) {
        return Err("Not allowed from this page.".into());
    }
    let (app_data, cfg) = config(&window);
    Ok(CacheInfo {
        from_server: require_server_page(&window).is_ok(),
        ..info(&app_data, &cfg)
    })
}

// The Settings checkbox while connected. Turning it off deletes the cache (via store::write_config).
#[tauri::command]
pub fn set_offline_cache(window: WebviewWindow, enabled: bool) -> Result<(), String> {
    if !crate::is_trusted_sender(&window) {
        return Err("Not allowed from this page.".into());
    }
    let (app_data, mut cfg) = config(&window);
    if cfg.mode.as_deref() != Some("remote") {
        return Err("Only used when connected to a server.".into());
    }
    cfg.offline_mode = Some(enabled);
    crate::store::write_config(&app_data, &cfg).map_err(|e| e.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    server: String,
    synced_at: u64,
    items: Vec<CachedItem>,
}

#[tauri::command]
pub fn offline_cache_snapshot(window: WebviewWindow) -> Result<Option<Snapshot>, String> {
    let (app_data, cfg) = require_bundled_page(&window)?;
    Ok(usable(&app_data, &cfg).map(|m| Snapshot {
        server: m.server,
        synced_at: m.synced_at,
        items: m.items,
    }))
}

#[tauri::command]
pub fn offline_cache_thumb(
    window: WebviewWindow,
    species_id: String,
) -> Result<Option<String>, String> {
    let (app_data, cfg) = require_bundled_page(&window)?;
    Ok(thumb_data_url(&app_data, &cfg, &species_id))
}

#[cfg(test)]
mod tests {
    use super::*;

    const SPECIES_A: &str = "0b5c3f0e-1a2b-4c3d-8e9f-000000000001";
    const SPECIES_B: &str = "0b5c3f0e-1a2b-4c3d-8e9f-000000000002";
    const JPEG: &[u8] = &[0xFF, 0xD8, 0xFF, 0xE0, 1, 2, 3, 4];

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "lifer-offline-cache-test-{name}-{}-{}",
            std::process::id(),
            now_ms()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn remote(url: &str) -> DesktopConfig {
        DesktopConfig {
            mode: Some("remote".into()),
            server_url: Some(url.into()),
            ..Default::default()
        }
    }

    fn item(id: &str, state: &str, thumb: Option<&str>) -> CachedItem {
        CachedItem {
            species_id: id.into(),
            common_name: Some("Robin".into()),
            scientific_name: "Erithacus rubecula".into(),
            taxon_class: Some("aves".into()),
            family: None,
            state: state.into(),
            thumb_key: thumb.map(String::from),
        }
    }

    fn synced(dir: &Path, cfg: &DesktopConfig, user: &str) -> Manifest {
        begin_sync(dir, cfg, user).unwrap();
        put_thumb(dir, cfg, user, SPECIES_A, JPEG).unwrap();
        commit(
            dir,
            cfg,
            user,
            vec![
                item(SPECIES_A, "collected", Some("/api/photos/1/thumb")),
                item(SPECIES_B, "unseen", None),
            ],
            1_000,
        )
        .unwrap()
    }

    #[test]
    fn enabled_by_default_in_server_mode_only() {
        assert!(enabled(&remote("http://nas:4000")));
        let mut off = remote("http://nas:4000");
        off.offline_mode = Some(false);
        assert!(!enabled(&off));
        let local = DesktopConfig {
            mode: Some("local".into()),
            ..Default::default()
        };
        assert!(!enabled(&local));
    }

    #[test]
    fn server_key_prefers_single_url_then_local_url() {
        assert_eq!(
            server_key(&remote("http://nas:4000/")).as_deref(),
            Some("http://nas:4000")
        );
        let switching = DesktopConfig {
            mode: Some("remote".into()),
            local_url: Some("http://192.168.1.5:4000".into()),
            external_urls: Some(vec!["https://lifer.example.com".into()]),
            ..Default::default()
        };
        assert_eq!(
            server_key(&switching).as_deref(),
            Some("http://192.168.1.5:4000")
        );
    }

    #[test]
    fn sync_round_trip_and_snapshot() {
        let dir = temp_dir("roundtrip");
        let cfg = remote("http://nas:4000");
        let manifest = synced(&dir, &cfg, "user-1");
        assert_eq!(manifest.items.len(), 2);
        let shown = usable(&dir, &cfg).expect("usable");
        assert_eq!(shown.synced_at, 1_000);
        assert_eq!(shown.items[0].state, "collected");
        let url = thumb_data_url(&dir, &cfg, SPECIES_A).unwrap();
        assert!(url.starts_with("data:image/jpeg;base64,/9j/"));
        assert!(thumb_data_url(&dir, &cfg, SPECIES_B).is_none());
        // The next sync reuses the thumbnail it already has.
        let start = begin_sync(&dir, &cfg, "user-1").unwrap();
        assert_eq!(start.synced_at, Some(1_000));
        assert_eq!(
            start.thumbs.get(SPECIES_A).map(String::as_str),
            Some("/api/photos/1/thumb")
        );
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn another_user_or_server_starts_from_empty() {
        let dir = temp_dir("owner");
        let cfg = remote("http://nas:4000");
        synced(&dir, &cfg, "user-1");
        // A put or commit for someone who didn't begin is refused.
        assert!(put_thumb(&dir, &cfg, "user-2", SPECIES_A, JPEG).is_err());
        assert!(commit(&dir, &cfg, "user-2", vec![], 2_000).is_err());
        let start = begin_sync(&dir, &cfg, "user-2").unwrap();
        assert_eq!(start.synced_at, None);
        assert!(start.thumbs.is_empty());
        assert!(usable(&dir, &cfg).is_none());
        assert!(!thumb_path(&dir, SPECIES_A).exists());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn reconcile_deletes_on_untick_switch_or_local() {
        let dir = temp_dir("reconcile");
        let cfg = remote("http://nas:4000");

        synced(&dir, &cfg, "u");
        reconcile(&dir, &cfg);
        assert!(usable(&dir, &cfg).is_some(), "same server keeps it");

        let mut off = cfg.clone();
        off.offline_mode = Some(false);
        reconcile(&dir, &off);
        assert!(!cache_dir(&dir).exists(), "unticking deletes it");

        synced(&dir, &cfg, "u");
        reconcile(&dir, &remote("http://other:4000"));
        assert!(!cache_dir(&dir).exists(), "switching servers deletes it");

        synced(&dir, &cfg, "u");
        reconcile(
            &dir,
            &DesktopConfig {
                mode: Some("local".into()),
                ..Default::default()
            },
        );
        assert!(!cache_dir(&dir).exists(), "leaving server mode deletes it");

        synced(&dir, &cfg, "u");
        reconcile(&dir, &DesktopConfig::default());
        assert!(
            !cache_dir(&dir).exists(),
            "Change Server clears the config and the cache"
        );
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn write_config_reconciles() {
        let dir = temp_dir("store");
        let cfg = remote("http://nas:4000");
        crate::store::write_config(&dir, &cfg).unwrap();
        synced(&dir, &cfg, "u");
        let mut off = cfg.clone();
        off.offline_mode = Some(false);
        crate::store::write_config(&dir, &off).unwrap();
        assert!(!cache_dir(&dir).exists());
        synced(&dir, &cfg, "u");
        crate::store::clear_config(&dir).unwrap();
        assert!(!cache_dir(&dir).exists());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn rejects_bad_thumbnails_and_ids() {
        let dir = temp_dir("bounds");
        let cfg = remote("http://nas:4000");
        begin_sync(&dir, &cfg, "u").unwrap();
        assert!(put_thumb(&dir, &cfg, "u", "../../etc/passwd", JPEG).is_err());
        assert!(put_thumb(&dir, &cfg, "u", SPECIES_A, b"<svg>").is_err());
        let mut big = JPEG.to_vec();
        big.resize(MAX_THUMB_BYTES + 1, 0);
        assert!(put_thumb(&dir, &cfg, "u", SPECIES_A, &big).is_err());
        let mut off = cfg.clone();
        off.offline_mode = Some(false);
        assert!(begin_sync(&dir, &off, "u").is_err());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn thumbnail_count_is_capped() {
        let dir = temp_dir("cap");
        let cfg = remote("http://nas:4000");
        begin_sync(&dir, &cfg, "u").unwrap();
        for i in 0..MAX_THUMBS {
            put_thumb(&dir, &cfg, "u", &format!("{i:032x}"), JPEG).unwrap();
        }
        assert!(put_thumb(&dir, &cfg, "u", SPECIES_A, JPEG).is_err());
        // Replacing an existing one is still fine.
        put_thumb(&dir, &cfg, "u", &format!("{:032x}", 0), JPEG).unwrap();
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn commit_prunes_unreferenced_thumbs_and_cleans_items() {
        let dir = temp_dir("prune");
        let cfg = remote("http://nas:4000");
        synced(&dir, &cfg, "u");
        begin_sync(&dir, &cfg, "u").unwrap();
        let mut odd = item(SPECIES_B, "something-else", Some("/api/x"));
        odd.common_name = Some("x".repeat(500));
        let manifest = commit(
            &dir,
            &cfg,
            "u",
            vec![
                item(SPECIES_A, "seen", None),
                odd,
                item("not/an/id", "seen", None),
            ],
            2_000,
        )
        .unwrap();
        assert!(
            !thumb_path(&dir, SPECIES_A).exists(),
            "no longer referenced"
        );
        assert_eq!(manifest.items.len(), 2);
        assert_eq!(manifest.items[1].state, "unseen");
        assert_eq!(manifest.items[1].thumb_key, None, "no file behind it");
        assert_eq!(
            manifest.items[1].common_name.as_ref().unwrap().len(),
            MAX_TEXT
        );
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn info_reports_size() {
        let dir = temp_dir("info");
        let cfg = remote("http://nas:4000");
        synced(&dir, &cfg, "u");
        let i = info(&dir, &cfg);
        assert!(i.enabled);
        assert_eq!((i.species, i.thumbs, i.synced_at), (2, 1, Some(1_000)));
        assert!(i.bytes > JPEG.len() as u64);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn base64_matches_known_vectors() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
    }
}

// Against a real Lifer API with a throwaway database: connect, sync, stop the server, browse the
// cache, restart, switch back. Plays the part of the server's web page (session cookie, GET
// /api/collection, the cover thumbnails) and of lib.rs's watcher (the reachability check that
// decides between the server and the cached view). Ignored by default; run it with
// tests/offline-cache-integration.sh, which creates the database and sets the variables read here.
#[cfg(test)]
mod integration {
    use super::*;
    use std::process::{Child, Command, Stdio};

    const COLLECTED: &str = "11111111-1111-4111-8111-111111111111";
    const SEEN: &str = "22222222-2222-4222-8222-222222222222";
    // Starts like a JPEG; the server streams reference thumbnails byte for byte.
    const FIXTURE: &[u8] = &[
        0xFF, 0xD8, 0xFF, 0xE0, 0, 16, b'J', b'F', b'I', b'F', 0, 0xFF, 0xD9,
    ];

    struct Env {
        database_url: String,
        psql: String,
        api_dir: PathBuf,
        work: PathBuf,
        port: u16,
    }

    fn env() -> Option<Env> {
        let database_url = std::env::var("LIFER_IT_DATABASE_URL").ok()?;
        let work = temp_dir();
        let port = std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        Some(Env {
            database_url,
            psql: std::env::var("LIFER_IT_PSQL").unwrap_or_else(|_| "psql".into()),
            api_dir: Path::new(env!("CARGO_MANIFEST_DIR")).join("../../api"),
            work,
            port,
        })
    }

    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "lifer-offline-it-{}-{}",
            std::process::id(),
            now_ms()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn psql(env: &Env, sql: &str) -> String {
        let out = Command::new(&env.psql)
            .args([&env.database_url, "-v", "ON_ERROR_STOP=1", "-Atqc", sql])
            .output()
            .expect("psql runs");
        assert!(
            out.status.success(),
            "psql failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    fn start_api(env: &Env) -> Child {
        let log = fs::File::create(env.work.join("api.log")).unwrap();
        // The API's source by default; LIFER_IT_API_ENTRY=dist/index.js runs a build instead.
        let entry = std::env::var("LIFER_IT_API_ENTRY").unwrap_or_else(|_| "src/index.ts".into());
        let mut args = vec![entry.clone()];
        if entry.ends_with(".ts") {
            args.splice(0..0, ["--import".to_string(), "tsx".to_string()]);
        }
        Command::new("node")
            .args(&args)
            .current_dir(&env.api_dir)
            // Everything explicit, so the repo's own .env (dotenv never overrides) can't point the
            // server at another database or switch it to single-user desktop mode.
            .env("DATABASE_URL", &env.database_url)
            .env("PORT", env.port.to_string())
            .env("DATA_DIR", env.work.join("library"))
            .env("APP_DATA_DIR", env.work.join("app-data"))
            .env("SINGLE_USER_MODE", "0")
            .env("LIFER_ALLOW_UNTOKENED_DESKTOP", "")
            .env("GBIF_USER", "")
            .env("GBIF_PWD", "")
            .env("EBIRD_API_KEY", "")
            .stdout(Stdio::from(log.try_clone().unwrap()))
            .stderr(Stdio::from(log))
            .spawn()
            .expect("node starts the API")
    }

    async fn wait_for_api(env: &Env) {
        let health = format!("http://127.0.0.1:{}/health", env.port);
        crate::api::wait_for_server(&health, 90_000)
            .await
            .unwrap_or_else(|e| {
                panic!(
                    "API didn't start: {e}. See {}",
                    env.work.join("api.log").display()
                )
            });
    }

    fn stop_api(child: &mut Child) {
        let _ = child.kill();
        let _ = child.wait();
    }

    /// What the server's web page does in syncOfflineCache, with its session cookie.
    async fn page_sync(
        base: &str,
        cookie: &str,
        app_data: &Path,
        cfg: &DesktopConfig,
        user_id: &str,
    ) -> (SyncStart, usize) {
        let client = reqwest::Client::new();
        let start = begin_sync(app_data, cfg, user_id).unwrap();
        let body: serde_json::Value = client
            .get(format!("{base}/api/collection"))
            .header("cookie", cookie)
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap()
            .json()
            .await
            .unwrap();
        let mut items = Vec::new();
        let mut fetched = 0;
        for raw in body["items"].as_array().unwrap() {
            let mut item: CachedItem = serde_json::from_value(raw.clone()).unwrap();
            if let Some(url) = raw["coverPhotoUrl"]
                .as_str()
                .filter(|u| u.starts_with("/api/"))
            {
                if start.thumbs.get(&item.species_id).map(String::as_str) == Some(url) {
                    item.thumb_key = Some(url.into());
                } else {
                    let bytes = client
                        .get(format!("{base}{url}"))
                        .header("cookie", cookie)
                        .send()
                        .await
                        .unwrap()
                        .error_for_status()
                        .unwrap()
                        .bytes()
                        .await
                        .unwrap();
                    put_thumb(app_data, cfg, user_id, &item.species_id, &bytes).unwrap();
                    item.thumb_key = Some(url.into());
                    fetched += 1;
                }
            }
            items.push(item);
        }
        commit(app_data, cfg, user_id, items, now_ms()).unwrap();
        (start, fetched)
    }

    #[test]
    #[ignore = "needs a throwaway Postgres; run tests/offline-cache-integration.sh"]
    fn connect_sync_offline_and_back() {
        let Some(env) = env() else {
            eprintln!("LIFER_IT_DATABASE_URL not set, skipping");
            return;
        };
        let thumb = env.work.join("robin-thumb.jpg");
        fs::write(&thumb, FIXTURE).unwrap();
        // Before the API starts, so it sees a catalog and doesn't try to download one.
        psql(&env, &format!(
            "INSERT INTO species (id, gbif_key, scientific_name, common_name, taxon_class, reference_thumb_path) VALUES \
             ('{COLLECTED}', 990001, 'Erithacus rubecula', 'European Robin', 'aves', NULL), \
             ('{SEEN}', 990002, 'Turdus merula', 'Common Blackbird', 'aves', '{}') ON CONFLICT (id) DO NOTHING",
            thumb.display()
        ));

        let base = format!("http://127.0.0.1:{}", env.port);
        let health = format!("{base}/health");
        let app_data = env.work.join("desktop-app-data");
        let cfg = DesktopConfig {
            mode: Some("remote".into()),
            server_url: Some(base.clone()),
            ..Default::default()
        };
        crate::store::write_config(&app_data, &cfg).unwrap();

        let mut api = start_api(&env);
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            tauri::async_runtime::block_on(async {
                wait_for_api(&env).await;
                // Connect: the account and its session cookie, as the web page has after sign-in.
                let res = reqwest::Client::new()
                    .post(format!("{base}/api/auth/register"))
                    .header("x-lifer-client", "1")
                    .json(&serde_json::json!({ "email": "offline-it@example.com", "password": "correct horse battery" }))
                    .send()
                    .await
                    .unwrap();
                assert!(res.status().is_success(), "register: {}", res.status());
                let cookie = res
                    .headers()
                    .get_all("set-cookie")
                    .iter()
                    .filter_map(|v| v.to_str().ok())
                    .find(|v| v.starts_with("lifer_session="))
                    .and_then(|v| v.split(';').next())
                    .expect("session cookie")
                    .to_string();
                let user: serde_json::Value = res.json().await.unwrap();
                let user_id = user["id"].as_str().unwrap().to_string();
                psql(&env, &format!(
                    "INSERT INTO user_species (user_id, species_id, state) VALUES ('{user_id}', '{COLLECTED}', 'collected'), ('{user_id}', '{SEEN}', 'seen')"
                ));

                // Sync.
                let (first, fetched) = page_sync(&base, &cookie, &app_data, &cfg, &user_id).await;
                assert_eq!(first.synced_at, None);
                assert_eq!(fetched, 1, "the seen species' reference thumbnail");

                // Stop the server: the watcher's check fails and the cached view has data.
                stop_api(&mut api);
                assert!(!crate::api::is_reachable(&health).await);
                let cached = usable(&app_data, &cfg).expect("cache to show offline");
                let states: Vec<_> = cached
                    .items
                    .iter()
                    .map(|i| (i.species_id.as_str(), i.state.as_str()))
                    .collect();
                assert_eq!(states, vec![(COLLECTED, "collected"), (SEEN, "seen")]);
                assert_eq!(
                    cached.items[1].common_name.as_deref(),
                    Some("Common Blackbird")
                );
                assert!(thumb_data_url(&app_data, &cfg, SEEN)
                    .unwrap()
                    .starts_with("data:image/jpeg;base64,/9j/"));
                assert!(
                    thumb_data_url(&app_data, &cfg, COLLECTED).is_none(),
                    "no cover, no thumbnail"
                );

                // Restart: the check answers again, so the watcher switches back to the server. The
                // server's per-boot ?v= on reference photos makes the next sync refetch that one
                // thumbnail; a sync after that reuses it.
                api = start_api(&env);
                wait_for_api(&env).await;
                assert!(crate::api::is_reachable(&health).await);
                let (second, fetched) = page_sync(&base, &cookie, &app_data, &cfg, &user_id).await;
                assert!(second.synced_at.is_some());
                assert_eq!(fetched, 1);
                let (_, fetched) = page_sync(&base, &cookie, &app_data, &cfg, &user_id).await;
                assert_eq!(fetched, 0);

                // Signing out (AuthProvider calls offline_cache_clear) leaves nothing behind.
                clear(&app_data).unwrap();
                assert!(usable(&app_data, &cfg).is_none());
                assert!(!cache_dir(&app_data).exists());
            });
        }));
        stop_api(&mut api);
        if result.is_ok() {
            let _ = fs::remove_dir_all(&env.work);
        } else {
            eprintln!("Kept {} for inspection.", env.work.display());
        }
        if let Err(panic) = result {
            std::panic::resume_unwind(panic);
        }
    }
}
