// The LAN listener a paired phone talks to (plan: mobile-implementation-plan.md, A-03).
//
// Safety rules, each tested below:
//   - TLS 1.3 only, with a self-signed certificate made once; the phone pins its SHA-256.
//   - A strict allowlist of method and path. Everything else is a 404 without touching the API:
//     pair-codes and devices (the signed-in user's own routes) are not on it.
//   - The phone's device key (x-api-key) is forwarded and nothing else of its credentials. The
//     desktop's launch credential is never added, so the API's gate (desktopGate.ts) checks
//     the device key on every request. Cookies, Origin and forwarded headers are dropped.
//   - Paths are plain ASCII with no encoded or dot segments; bodies are capped per route and
//     streamed to the API, never buffered.
//   - Every request reaches the API from 127.0.0.1, so per-peer limits live here: a few
//     connections and pairing tries per LAN address. No header naming the peer is sent. The API
//     also caps guesses per pairing code across all peers (pairing.ts).
//   - Only the instance id is advertised over mDNS.
use std::collections::HashMap;
use std::convert::Infallible;
use std::net::{IpAddr, Ipv4Addr};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use http_body_util::combinators::BoxBody;
use http_body_util::{BodyExt, Full, LengthLimitError, Limited};
use hyper::body::{Bytes, Incoming};
use hyper::header::{HeaderName, HeaderValue};
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::client::legacy::{connect::HttpConnector, Client};
use hyper_util::rt::{TokioExecutor, TokioIo, TokioTimer};
use sha2::{Digest, Sha256};
use tokio::net::TcpListener;
use tokio::sync::Semaphore;
use tokio::task::JoinSet;
use tokio_rustls::rustls::pki_types::{pem::PemObject, CertificateDer, PrivateKeyDer};
use tokio_rustls::rustls::{self, ServerConfig};
use tokio_rustls::TlsAcceptor;

use crate::fsutil::write_atomic;

pub const PREFERRED_PORT: u16 = 4311;
const SERVICE_TYPE: &str = "_lifer-companion._tcp.local.";
const MAX_CONNECTIONS: usize = 64;
const MAX_CONNECTIONS_PER_PEER: usize = 8;
// Below the API's own 5 per minute, which every LAN host shares.
const PAIR_TRIES_PER_PEER: usize = 3;
const PAIR_WINDOW: Duration = Duration::from_secs(60);
// Covers the upload too: a 16 MiB tus chunk on slow Wi-Fi.
const UPSTREAM_TIMEOUT: Duration = Duration::from_secs(300);
const MAX_QUERY: usize = 2048;
const MAX_KEY_LEN: usize = 256;
const MAX_SEGMENT: usize = 64;
const KB: u64 = 1024;

// ---- Certificate -------------------------------------------------------------------------

pub struct Identity {
    cert: CertificateDer<'static>,
    key: PrivateKeyDer<'static>,
    /// Lowercase hex SHA-256 of the certificate, what the QR code carries.
    pub sha256: String,
}

fn fingerprint(cert: &CertificateDer<'_>) -> String {
    Sha256::digest(cert.as_ref())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn parse_identity(cert_pem: &[u8], key_pem: &[u8]) -> Option<Identity> {
    let cert = CertificateDer::from_pem_slice(cert_pem).ok()?;
    let key = PrivateKeyDer::from_pem_slice(key_pem).ok()?;
    let sha256 = fingerprint(&cert);
    Some(Identity { cert, key, sha256 })
}

/// The certificate in the app data folder, made on first use. The key file is user-only (0600 on
/// Unix; on Windows the app data folder is already private to the user's profile).
pub fn load_or_create_identity(dir: &Path) -> Result<Identity, String> {
    let cert_path = dir.join("companion-cert.pem");
    let key_path = dir.join("companion-key.pem");
    if let (Ok(cert), Ok(key)) = (std::fs::read(&cert_path), std::fs::read(&key_path)) {
        if let Some(identity) = parse_identity(&cert, &key) {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                for p in [&cert_path, &key_path] {
                    let _ = std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o600));
                }
            }
            return Ok(identity);
        }
    }
    let key_pair = rcgen::KeyPair::generate().map_err(|e| e.to_string())?;
    let mut params = rcgen::CertificateParams::new(vec!["lifer.local".to_string()])
        .map_err(|e| e.to_string())?;
    params
        .distinguished_name
        .push(rcgen::DnType::CommonName, "Lifer");
    let cert = params.self_signed(&key_pair).map_err(|e| e.to_string())?;
    let (cert_pem, key_pem) = (cert.pem(), key_pair.serialize_pem());
    // Key first: a crash between the two leaves a pair that fails to parse and is remade.
    write_atomic(&key_path, key_pem.as_bytes(), Some(0o600)).map_err(|e| e.to_string())?;
    write_atomic(&cert_path, cert_pem.as_bytes(), Some(0o600)).map_err(|e| e.to_string())?;
    parse_identity(cert_pem.as_bytes(), key_pem.as_bytes())
        .ok_or_else(|| "The new certificate could not be read back.".to_string())
}

fn tls_acceptor(identity: Identity) -> Result<TlsAcceptor, String> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let config = ServerConfig::builder_with_provider(provider)
        .with_protocol_versions(&[&rustls::version::TLS13])
        .map_err(|e| e.to_string())?
        .with_no_client_auth()
        .with_single_cert(vec![identity.cert], identity.key)
        .map_err(|e| e.to_string())?;
    Ok(TlsAcceptor::from(Arc::new(config)))
}

// ---- Allowlist ---------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Access {
    /// Needs the phone's device key.
    Key,
    /// No key: pairs with a scanned code. A guess at the code, limited per peer.
    PairCode,
    /// No key: starts a typed pairing (one guess at the code), limited per peer.
    PairStart,
    /// No key: finishes a typed pairing by its random session id.
    PairFinish,
}

impl Access {
    fn is_guess(self) -> bool {
        matches!(self, Access::PairCode | Access::PairStart)
    }
    fn pairs(self) -> bool {
        matches!(self, Access::PairCode | Access::PairFinish)
    }
}

struct Rule {
    method: &'static str,
    /// "/"-separated; ":id" matches one id-like segment.
    pattern: &'static str,
    max_body: u64,
    access: Access,
}

const fn rule(method: &'static str, pattern: &'static str, max_body: u64) -> Rule {
    Rule {
        method,
        pattern,
        max_body,
        access: Access::Key,
    }
}

const fn open_rule(method: &'static str, pattern: &'static str, access: Access) -> Rule {
    Rule {
        method,
        pattern,
        max_body: 4 * KB,
        access,
    }
}

// The phone's routes from the plan's additions table. Routes the API doesn't have yet answer 404
// from the API itself; the API's gate admits a device key only on routes scoped for it. Not here
// on purpose: companion/v1/pair-codes and companion/v1/devices.
const RULES: &[Rule] = &[
    open_rule("POST", "/api/companion/v1/pair", Access::PairCode),
    open_rule("POST", "/api/companion/v1/pair/start", Access::PairStart),
    open_rule("POST", "/api/companion/v1/pair/finish", Access::PairFinish),
    rule("GET", "/api/companion/v1/snapshot", 0),
    rule("GET", "/api/companion/v1/showcase", 0),
    rule("GET", "/api/companion/v1/regions/:id/bundle", 0),
    // Offline picture search: the text encoder's manifest and files (Range), photo vectors, and each
    // photo's frame (subject box, light, background vector).
    rule("GET", "/api/companion/v1/model/text", 0),
    rule("GET", "/api/companion/v1/model/text/:id", 0),
    rule("GET", "/api/companion/v1/model/vectors", 0),
    rule("GET", "/api/companion/v1/model/frames", 0),
    // Smart albums' photos, and a species' reference photo (named by its scientific name, letters and "_").
    rule("GET", "/api/companion/v1/albums/smart", 0),
    rule("GET", "/api/companion/v1/reference/:id", 0),
    rule("GET", "/api/companion/v1/reference/:id/thumb", 0),
    rule("GET", "/api/companion/v1/reference/:id/display", 0),
    // A featured photo cut to its crop: /square/{species|album|trip}/{id}?photo={photo id}.
    rule("GET", "/api/companion/v1/square/:id/:id", 0),
    rule("POST", "/api/companion/v1/push", 4 * KB * KB),
    rule("GET", "/api/sync/changes", 0),
    rule("GET", "/api/sync/albums", 0),
    rule("GET", "/api/sync/trips", 0),
    rule("GET", "/api/sync/saved-spots", 0),
    rule("GET", "/api/sync/album-captures", 0),
    rule("GET", "/api/sync/album-exclusions", 0),
    rule("GET", "/api/sync/user-species", 0),
    // Species marks the phone changed, with the versions it last saw.
    rule("POST", "/api/sync/user-species", KB * KB),
    rule("GET", "/api/sync/preferences", 0),
    rule("GET", "/api/sync/search-vocab", 0),
    rule("GET", "/api/sync/region-tree", 0),
    rule("GET", "/api/sync/regions/:id/checklist", 0),
    rule("GET", "/api/gallery/search", 0),
    rule("GET", "/api/gallery", 0),
    rule("GET", "/api/photos/:id/thumb", 0),
    rule("GET", "/api/photos/:id/medium", 0),
    rule("GET", "/api/photos/:id/display", 0),
    rule("GET", "/api/photos/:id/phone", 0),
    rule("GET", "/api/photos/:id/full", 0),
    rule("POST", "/api/uploads/tus", 64 * KB),
    rule("OPTIONS", "/api/uploads/tus", 0),
    rule("PATCH", "/api/uploads/tus/:id", 16 * KB * KB),
    rule("HEAD", "/api/uploads/tus/:id", 0),
    rule("DELETE", "/api/uploads/tus/:id", 0),
    rule("OPTIONS", "/api/uploads/tus/:id", 0),
];

pub struct Allowed {
    pub max_body: u64,
    pub access: Access,
}

fn plain_segment_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.'
}

fn segment_matches(pattern: &str, segment: &str) -> bool {
    if pattern == ":id" {
        return !segment.is_empty()
            && segment.len() <= MAX_SEGMENT
            && segment
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    }
    pattern == segment
}

/// Whether a request line may be forwarded, and with what body cap. Refuses anything that isn't
/// an exact allowlisted method and path: encoded characters, dot or empty segments, backslashes,
/// long or odd queries.
pub fn allow(method: &str, target: &str) -> Option<Allowed> {
    let (path, query) = match target.split_once('?') {
        Some((p, q)) => (p, Some(q)),
        None => (target, None),
    };
    if let Some(q) = query {
        if q.len() > MAX_QUERY || !q.bytes().all(|b| b.is_ascii_graphic()) {
            return None;
        }
    }
    if !path.starts_with('/') || !path.chars().all(|c| c == '/' || plain_segment_char(c)) {
        return None;
    }
    let segments: Vec<&str> = path[1..].split('/').collect();
    if segments
        .iter()
        .any(|s| s.is_empty() || *s == "." || *s == "..")
    {
        return None;
    }
    RULES.iter().find_map(|r| {
        let pattern: Vec<&str> = r.pattern[1..].split('/').collect();
        let same = r.method == method
            && pattern.len() == segments.len()
            && pattern
                .iter()
                .zip(&segments)
                .all(|(p, s)| segment_matches(p, s));
        same.then_some(Allowed {
            max_body: r.max_body,
            access: r.access,
        })
    })
}

// Request headers that reach the API. Anything else (cookies, Origin, Authorization, forwarded
// headers, the desktop credential header) is dropped.
const FORWARDED_HEADERS: &[&str] = &[
    "x-api-key",
    "content-type",
    "accept",
    "if-none-match",
    "range",
    "tus-resumable",
    "upload-offset",
    "upload-length",
    "upload-metadata",
];

fn plausible_key(value: &HeaderValue) -> bool {
    let b = value.as_bytes();
    !b.is_empty() && b.len() <= MAX_KEY_LEN && b.iter().all(|c| c.is_ascii_graphic())
}

// ---- Server ------------------------------------------------------------------------------

type Body = BoxBody<Bytes, hyper::Error>;

fn text(status: StatusCode, message: &str) -> Response<Body> {
    let body = format!("{{\"error\":\"{message}\"}}");
    let mut res = Response::new(Full::new(Bytes::from(body)).map_err(|n| match n {}).boxed());
    *res.status_mut() = status;
    res.headers_mut()
        .insert("content-type", HeaderValue::from_static("application/json"));
    res
}

pub struct Hooks {
    /// A phone just paired.
    pub on_paired: Box<dyn Fn() + Send + Sync>,
    /// A phone's request was accepted by the API.
    pub on_synced: Box<dyn Fn() + Send + Sync>,
}

struct Context {
    upstream_port: u16,
    client: Client<HttpConnector, Limited<Incoming>>,
    hooks: Hooks,
    connections: Mutex<HashMap<IpAddr, usize>>,
    pair_tries: Mutex<HashMap<IpAddr, Vec<Instant>>>,
}

impl Context {
    /// Records a pairing try from this peer; false once it has used its share for the minute.
    fn pair_try_allowed(&self, peer: IpAddr) -> bool {
        let Ok(mut tries) = self.pair_tries.lock() else {
            return false;
        };
        let now = Instant::now();
        tries.retain(|_, t| {
            t.retain(|at| now.duration_since(*at) < PAIR_WINDOW);
            !t.is_empty()
        });
        let mine = tries.entry(peer).or_default();
        if mine.len() >= PAIR_TRIES_PER_PEER {
            return false;
        }
        mine.push(now);
        true
    }
}

// One open connection from a peer; dropping it frees the peer's slot.
struct PeerSlot {
    ctx: Arc<Context>,
    peer: IpAddr,
}

impl PeerSlot {
    fn take(ctx: &Arc<Context>, peer: IpAddr) -> Option<PeerSlot> {
        let mut map = ctx.connections.lock().ok()?;
        let n = map.entry(peer).or_insert(0);
        if *n >= MAX_CONNECTIONS_PER_PEER {
            return None;
        }
        *n += 1;
        Some(PeerSlot {
            ctx: ctx.clone(),
            peer,
        })
    }
}

impl Drop for PeerSlot {
    fn drop(&mut self) {
        if let Ok(mut map) = self.ctx.connections.lock() {
            if let Some(n) = map.get_mut(&self.peer) {
                *n -= 1;
                if *n == 0 {
                    map.remove(&self.peer);
                }
            }
        }
    }
}

fn is_too_large(e: &(dyn std::error::Error + 'static)) -> bool {
    let mut cur = Some(e);
    while let Some(err) = cur {
        if err.is::<LengthLimitError>() {
            return true;
        }
        cur = err.source();
    }
    false
}

async fn handle(
    req: Request<Incoming>,
    ctx: Arc<Context>,
    peer: IpAddr,
) -> Result<Response<Body>, Infallible> {
    Ok(forward(req, &ctx, peer).await.unwrap_or_else(|r| r))
}

#[allow(clippy::result_large_err)] // the Err is the reply to send
async fn forward(
    req: Request<Incoming>,
    ctx: &Context,
    peer: IpAddr,
) -> Result<Response<Body>, Response<Body>> {
    let target = req
        .uri()
        .path_and_query()
        .map(|p| p.as_str())
        .unwrap_or("/");
    let Some(rule) = allow(req.method().as_str(), target) else {
        return Err(text(StatusCode::NOT_FOUND, "Not found"));
    };
    // Phone apps send no Origin; a web page on the network always does.
    if req.headers().contains_key("origin") {
        return Err(text(StatusCode::FORBIDDEN, "Forbidden"));
    }
    if rule.access == Access::Key && !req.headers().get("x-api-key").is_some_and(plausible_key) {
        return Err(text(StatusCode::UNAUTHORIZED, "Not authenticated"));
    }
    let declared = req
        .headers()
        .get("content-length")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok());
    if declared.is_some_and(|n| n > rule.max_body) {
        return Err(text(StatusCode::PAYLOAD_TOO_LARGE, "Too large"));
    }

    if rule.access.is_guess() && !ctx.pair_try_allowed(peer) {
        let mut res = text(
            StatusCode::TOO_MANY_REQUESTS,
            "Too many tries. Wait a minute.",
        );
        res.headers_mut()
            .insert("retry-after", HeaderValue::from_static("60"));
        return Err(res);
    }
    let method: Method = req.method().clone();
    let target = target.to_string();
    let mut builder = Request::builder()
        .method(method)
        .uri(format!("http://127.0.0.1:{}{}", ctx.upstream_port, target))
        .header("host", format!("127.0.0.1:{}", ctx.upstream_port));
    for name in FORWARDED_HEADERS {
        if let Some(v) = req.headers().get(*name) {
            builder = builder.header(HeaderName::from_static(name), v);
        }
    }
    // Requests with an Origin were refused above, so none come from a web page; mark them as a
    // Lifer client so the API's cross-site write guard lets keyless pairing through.
    builder = builder.header("x-lifer-client", "1");
    // Streamed with the cap enforced as it flows, so 64 uploads don't sit in memory at once.
    let (_, body) = req.into_parts();
    let upstream = builder
        .body(Limited::new(body, rule.max_body as usize))
        .map_err(|_| text(StatusCode::BAD_REQUEST, "Bad request"))?;
    let res = tokio::time::timeout(UPSTREAM_TIMEOUT, ctx.client.request(upstream))
        .await
        .map_err(|_| text(StatusCode::GATEWAY_TIMEOUT, "Lifer took too long to answer"))?
        .map_err(|e| {
            if is_too_large(&e) {
                text(StatusCode::PAYLOAD_TOO_LARGE, "Too large")
            } else {
                text(StatusCode::BAD_GATEWAY, "Lifer isn't answering")
            }
        })?;

    if res.status().is_success() || res.status() == StatusCode::NOT_MODIFIED {
        if rule.access == Access::Key {
            (ctx.hooks.on_synced)();
        } else if rule.access.pairs() {
            (ctx.hooks.on_paired)();
        }
    }
    let (mut parts, body) = res.into_parts();
    parts.headers.remove("set-cookie");
    Ok(Response::from_parts(parts, body.boxed()))
}

async fn serve_connection(
    tcp: tokio::net::TcpStream,
    peer: IpAddr,
    acceptor: TlsAcceptor,
    ctx: Arc<Context>,
) {
    let Ok(Ok(tls)) = tokio::time::timeout(Duration::from_secs(10), acceptor.accept(tcp)).await
    else {
        return;
    };
    let _ = hyper::server::conn::http1::Builder::new()
        .timer(TokioTimer::new())
        .header_read_timeout(Duration::from_secs(10))
        .serve_connection(
            TokioIo::new(tls),
            hyper::service::service_fn(move |req| handle(req, ctx.clone(), peer)),
        )
        .await;
}

async fn accept_loop(listener: TcpListener, acceptor: TlsAcceptor, ctx: Arc<Context>) {
    let slots = Arc::new(Semaphore::new(MAX_CONNECTIONS));
    // Dropping the set (when this task is aborted) ends every open connection.
    let mut tasks = JoinSet::new();
    loop {
        let Ok((tcp, addr)) = listener.accept().await else {
            tokio::time::sleep(Duration::from_millis(100)).await;
            continue;
        };
        while tasks.try_join_next().is_some() {}
        // Over either cap: drop the connection.
        let Some(peer_slot) = PeerSlot::take(&ctx, addr.ip()) else {
            continue;
        };
        let Ok(permit) = slots.clone().try_acquire_owned() else {
            continue;
        };
        let (acceptor, ctx) = (acceptor.clone(), ctx.clone());
        tasks.spawn(async move {
            serve_connection(tcp, addr.ip(), acceptor, ctx).await;
            drop((permit, peer_slot));
        });
    }
}

// ---- Discovery ---------------------------------------------------------------------------

/// The addresses a phone on this network could use: this computer's IPv4 addresses that aren't
/// loopback or link-local.
pub fn lan_addresses(port: u16) -> Vec<String> {
    let ips = if_addrs::get_if_addrs()
        .unwrap_or_default()
        .into_iter()
        .map(|i| i.ip());
    address_strings(ips, port)
}

fn address_strings(ips: impl Iterator<Item = IpAddr>, port: u16) -> Vec<String> {
    let mut out: Vec<String> = ips
        .filter_map(|ip| match ip {
            IpAddr::V4(v4) if !v4.is_loopback() && !v4.is_link_local() && !v4.is_unspecified() => {
                Some(format!("{v4}:{port}"))
            }
            _ => None,
        })
        .collect();
    out.dedup();
    out
}

// The service name carries a slice of the instance id, never the computer's name; the TXT record
// is the id alone.
fn advertise(instance_id: &str, port: u16) -> Result<mdns_sd::ServiceDaemon, String> {
    let short: String = instance_id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .take(8)
        .collect();
    let name = format!("lifer-{short}");
    let daemon = mdns_sd::ServiceDaemon::new().map_err(|e| e.to_string())?;
    let info = mdns_sd::ServiceInfo::new(
        SERVICE_TYPE,
        &name,
        &format!("{name}.local."),
        "",
        port,
        &[("id", instance_id)][..],
    )
    .map_err(|e| e.to_string())?
    .enable_addr_auto();
    daemon.register(info).map_err(|e| e.to_string())?;
    Ok(daemon)
}

// ---- Start and stop ----------------------------------------------------------------------

pub struct Running {
    pub port: u16,
    pub sha256: String,
    task: tauri::async_runtime::JoinHandle<()>,
    mdns: Option<mdns_sd::ServiceDaemon>,
}

impl Running {
    pub fn stop(self) {
        self.task.abort();
        if let Some(daemon) = self.mdns {
            let _ = daemon.shutdown();
        }
    }
}

/// Binds the LAN port (the preferred one, else any free one) and starts answering. With an
/// instance id the service is also advertised over mDNS; a network that blocks mDNS only loses
/// discovery, the phone still has the addresses from the QR code.
pub fn start(
    app_data_dir: &Path,
    upstream_port: u16,
    instance_id: Option<&str>,
    preferred_port: u16,
    hooks: Hooks,
) -> Result<Running, String> {
    // An untokened dev API would treat every forwarded LAN request as the local user.
    if std::env::var("LIFER_ALLOW_UNTOKENED_DESKTOP").as_deref() == Ok("1") {
        return Err("Phone sync is off while LIFER_ALLOW_UNTOKENED_DESKTOP is set.".into());
    }
    let identity = load_or_create_identity(app_data_dir)?;
    let sha256 = identity.sha256.clone();
    let acceptor = tls_acceptor(identity)?;
    let any = |port| std::net::TcpListener::bind((Ipv4Addr::UNSPECIFIED, port));
    let std_listener = any(preferred_port)
        .or_else(|_| any(0))
        .map_err(|e| format!("Couldn't open a port for your phone: {e}"))?;
    std_listener
        .set_nonblocking(true)
        .map_err(|e| e.to_string())?;
    let port = std_listener.local_addr().map_err(|e| e.to_string())?.port();

    let client = Client::builder(TokioExecutor::new()).build_http();
    let ctx = Arc::new(Context {
        upstream_port,
        client,
        hooks,
        connections: Mutex::default(),
        pair_tries: Mutex::default(),
    });
    let task = tauri::async_runtime::spawn(async move {
        match TcpListener::from_std(std_listener) {
            Ok(listener) => accept_loop(listener, acceptor, ctx).await,
            Err(e) => eprintln!("[lifer] companion listener: {e}"),
        }
    });
    let mdns = instance_id.and_then(|id| {
        advertise(id, port)
            .map_err(|e| eprintln!("[lifer] companion discovery unavailable: {e}"))
            .ok()
    });
    Ok(Running {
        port,
        sha256,
        task,
        mdns,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("lifer-companion-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn allowlist_admits_only_exact_routes() {
        let access = |m: &str, t: &str| allow(m, t).map(|a| a.access);
        assert_eq!(
            access("POST", "/api/companion/v1/pair"),
            Some(Access::PairCode)
        );
        assert_eq!(
            access("POST", "/api/companion/v1/pair/start"),
            Some(Access::PairStart)
        );
        assert_eq!(
            access("POST", "/api/companion/v1/pair/finish"),
            Some(Access::PairFinish)
        );
        assert_eq!(
            access("GET", "/api/sync/changes?cursor=abc&limit=50"),
            Some(Access::Key)
        );
        assert!(allow("POST", "/api/companion/v1/pair/other").is_none());
        assert!(allow("GET", "/api/companion/v1/pair/start").is_none());
        assert!(allow("GET", "/api/companion/v1/regions/abc-123/bundle").is_some());
        assert!(allow("PATCH", "/api/uploads/tus/ab12").is_some());
        // The signed-in user's own routes never cross the network.
        assert!(allow("POST", "/api/companion/v1/pair-codes").is_none());
        assert!(allow("GET", "/api/companion/v1/devices").is_none());
        assert!(allow("DELETE", "/api/companion/v1/devices/abc").is_none());
        // Wrong method, other API routes, the web app, the health check.
        assert!(allow("GET", "/api/companion/v1/pair").is_none());
        assert!(allow("DELETE", "/api/sync/changes").is_none());
        assert!(allow("GET", "/api/captures").is_none());
        assert!(allow("GET", "/").is_none());
        assert!(allow("GET", "/health").is_none());
        assert!(allow("GET", "/api/sync/changes/extra").is_none());
    }

    #[test]
    fn offline_search_routes_are_get_only_with_no_body() {
        for path in [
            "/api/companion/v1/model/text",
            "/api/companion/v1/model/text/encoder",
            "/api/companion/v1/model/text/tokenizer-config",
            "/api/companion/v1/model/vectors?since=2026-01-01T00:00:00Z&limit=500",
            "/api/companion/v1/model/frames?background=1&limit=500",
        ] {
            let a = allow("GET", path).unwrap_or_else(|| panic!("{path} should be admitted"));
            assert_eq!((a.max_body, a.access), (0, Access::Key));
            assert!(allow("POST", path.split('?').next().unwrap()).is_none());
            assert!(allow("DELETE", path.split('?').next().unwrap()).is_none());
        }
        assert!(allow("GET", "/api/companion/v1/model/text/a/b").is_none());
        assert!(allow("GET", "/api/companion/v1/model/text/encoder.onnx").is_none());
    }

    #[test]
    fn phone_library_routes_are_get_only_with_no_body() {
        for path in [
            "/api/companion/v1/albums/smart",
            "/api/companion/v1/reference/Turdus_migratorius",
            "/api/companion/v1/reference/Turdus_migratorius/thumb",
            "/api/companion/v1/reference/Turdus_migratorius/display",
            "/api/companion/v1/square/species/Turdus_migratorius?photo=0c8e5c1e-1b2c-4d3e-8f90-a1b2c3d4e5f6",
            "/api/companion/v1/square/album/0c8e5c1e-1b2c-4d3e-8f90-a1b2c3d4e5f6?photo=0c8e5c1e-1b2c-4d3e-8f90-a1b2c3d4e5f6",
        ] {
            let a = allow("GET", path).unwrap_or_else(|| panic!("{path} should be admitted"));
            assert_eq!((a.max_body, a.access), (0, Access::Key));
            assert!(allow("POST", path).is_none());
        }
        assert!(allow("GET", "/api/companion/v1/reference/Turdus%20migratorius").is_none());
        assert!(allow("GET", "/api/companion/v1/reference/a/b/c").is_none());
        assert!(allow("GET", "/api/companion/v1/albums/smart/x").is_none());
        assert!(allow("GET", "/api/companion/v1/square/species").is_none());
        assert!(allow("GET", "/api/companion/v1/square/species/a/b").is_none());
    }

    #[test]
    fn allowlist_refuses_traversal_and_odd_paths() {
        for bad in [
            "/api/photos/../captures/thumb",
            "/api/photos/%2e%2e/thumb",
            "/api/sync/changes%2f..%2fcaptures",
            "/api/photos/a%2fb/thumb",
            "/api//sync/changes",
            "/api/sync/changes/",
            "/api/photos/./thumb",
            "/api\\sync\\changes",
            "/api/photos/a b/thumb",
            "/api/photos/a.b/thumb",
            "/api/sync/changes\0",
            "/api/sync/changes?x=a b",
            "api/sync/changes",
            "http://evil/api/sync/changes",
        ] {
            assert!(allow("GET", bad).is_none(), "{bad:?} should be refused");
        }
        let long_query = format!("/api/sync/changes?q={}", "a".repeat(MAX_QUERY + 1));
        assert!(allow("GET", &long_query).is_none());
        let long_id = format!("/api/photos/{}/thumb", "a".repeat(MAX_SEGMENT + 1));
        assert!(allow("GET", &long_id).is_none());
    }

    #[test]
    fn phone_routes_are_admitted_and_the_rest_of_sync_is_not() {
        for path in [
            "/api/sync/albums",
            "/api/sync/trips",
            "/api/sync/saved-spots",
            "/api/sync/album-captures",
            "/api/sync/album-exclusions",
            "/api/sync/user-species",
            "/api/sync/preferences",
            "/api/sync/search-vocab",
            "/api/sync/region-tree",
            "/api/sync/regions/abc-123/checklist",
            "/api/gallery",
            "/api/gallery/search?q=owl",
            "/api/photos/abc-123/phone",
            "/api/photos/abc-123/full",
        ] {
            assert_eq!(allow("GET", path).map(|a| a.max_body), Some(0), "{path}");
        }
        assert_eq!(
            allow("POST", "/api/sync/user-species").unwrap().max_body,
            KB * KB
        );
        for (method, path) in [
            ("POST", "/api/sync/push"),
            ("GET", "/api/sync/status"),
            ("GET", "/api/sync/link/proof"),
            ("POST", "/api/sync/link/revoke"),
            ("GET", "/api/photos/abc-123/original"),
            ("GET", "/api/photos/abc-123/original-raw"),
            ("POST", "/api/sync/albums"),
            ("POST", "/api/gallery"),
            ("GET", "/api/sync/regions/abc-123"),
        ] {
            assert!(allow(method, path).is_none(), "{method} {path}");
        }
    }

    #[test]
    fn body_caps_are_per_route() {
        assert_eq!(
            allow("POST", "/api/companion/v1/pair").unwrap().max_body,
            4 * KB
        );
        assert_eq!(allow("GET", "/api/sync/changes").unwrap().max_body, 0);
        assert!(
            allow("PATCH", "/api/uploads/tus/x").unwrap().max_body
                > allow("POST", "/api/companion/v1/push").unwrap().max_body
        );
    }

    #[test]
    fn only_lan_addresses_are_listed() {
        let ips = [
            "127.0.0.1",
            "169.254.1.5",
            "0.0.0.0",
            "192.168.1.20",
            "10.0.0.4",
            "::1",
            "fe80::1",
        ]
        .iter()
        .map(|s| s.parse::<IpAddr>().unwrap());
        assert_eq!(
            address_strings(ips, 4311),
            vec!["192.168.1.20:4311", "10.0.0.4:4311"]
        );
    }

    #[test]
    fn certificate_is_made_once_and_fingerprinted() {
        let dir = temp_dir("cert");
        let first = load_or_create_identity(&dir).unwrap();
        assert_eq!(first.sha256.len(), 64);
        assert!(first
            .sha256
            .chars()
            .all(|c| matches!(c, '0'..='9' | 'a'..='f')));
        let second = load_or_create_identity(&dir).unwrap();
        assert_eq!(first.sha256, second.sha256, "the certificate is reused");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            for f in ["companion-key.pem", "companion-cert.pem"] {
                let mode = std::fs::metadata(dir.join(f)).unwrap().permissions().mode() & 0o777;
                assert_eq!(mode, 0o600, "{f}");
            }
        }
        // A damaged pair is replaced rather than trusted.
        std::fs::write(dir.join("companion-key.pem"), b"junk").unwrap();
        let third = load_or_create_identity(&dir).unwrap();
        assert_ne!(first.sha256, third.sha256);
        let _ = std::fs::remove_dir_all(&dir);
    }

    // Accepts any certificate: the test only checks what the listener answers.
    #[derive(Debug)]
    struct AcceptAny;
    impl rustls::client::danger::ServerCertVerifier for AcceptAny {
        fn verify_server_cert(
            &self,
            _: &CertificateDer<'_>,
            _: &[CertificateDer<'_>],
            _: &rustls::pki_types::ServerName<'_>,
            _: &[u8],
            _: rustls::pki_types::UnixTime,
        ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
            Ok(rustls::client::danger::ServerCertVerified::assertion())
        }
        fn verify_tls12_signature(
            &self,
            _: &[u8],
            _: &CertificateDer<'_>,
            _: &rustls::DigitallySignedStruct,
        ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
            Ok(rustls::client::danger::HandshakeSignatureValid::assertion())
        }
        fn verify_tls13_signature(
            &self,
            _: &[u8],
            _: &CertificateDer<'_>,
            _: &rustls::DigitallySignedStruct,
        ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
            Ok(rustls::client::danger::HandshakeSignatureValid::assertion())
        }
        fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
            rustls::crypto::ring::default_provider()
                .signature_verification_algorithms
                .supported_schemes()
        }
    }

    async fn https(
        port: u16,
        versions: &[&'static rustls::SupportedProtocolVersion],
        request: &str,
    ) -> Option<String> {
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let config = rustls::ClientConfig::builder_with_provider(provider)
            .with_protocol_versions(versions)
            .unwrap()
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(AcceptAny))
            .with_no_client_auth();
        let tcp = tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .ok()?;
        let name = rustls::pki_types::ServerName::try_from("lifer.local").unwrap();
        let mut tls = tokio_rustls::TlsConnector::from(Arc::new(config))
            .connect(name, tcp)
            .await
            .ok()?;
        tls.write_all(request.as_bytes()).await.ok()?;
        let mut out = Vec::new();
        let _ = tls.read_to_end(&mut out).await;
        Some(String::from_utf8_lossy(&out).into_owned())
    }

    fn quiet_hooks() -> Hooks {
        Hooks {
            on_paired: Box::new(|| {}),
            on_synced: Box::new(|| {}),
        }
    }

    #[test]
    fn starts_answers_only_allowlisted_and_stops() {
        let dir = temp_dir("serve");
        tauri::async_runtime::block_on(async {
            // Port 9 (discard) stands in for an API that must never be reached by these requests.
            let running = start(&dir, 9, None, 0, quiet_hooks()).unwrap();
            let port = running.port;
            let get = |path: &str, extra: &str| {
                format!("GET {path} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n{extra}\r\n")
            };

            let tls13 = [&rustls::version::TLS13];
            let status = |r: Option<String>| {
                r.expect("tls session")
                    .lines()
                    .next()
                    .unwrap_or("")
                    .to_string()
            };
            assert!(
                status(https(port, &tls13, &get("/api/sync/changes", "")).await).contains("401")
            );
            assert!(status(
                https(
                    port,
                    &tls13,
                    &get("/api/companion/v1/devices", "x-api-key: k\r\n")
                )
                .await
            )
            .contains("404"));
            assert!(status(
                https(
                    port,
                    &tls13,
                    &get("/api/photos/%2e%2e/thumb", "x-api-key: k\r\n")
                )
                .await
            )
            .contains("404"));
            assert!(status(
                https(
                    port,
                    &tls13,
                    &get(
                        "/api/sync/changes",
                        "x-api-key: k\r\nOrigin: http://evil\r\n"
                    )
                )
                .await
            )
            .contains("403"));
            let big = "POST /api/companion/v1/pair HTTP/1.1\r\nHost: x\r\nConnection: close\r\nContent-Length: 99999\r\n\r\n";
            assert!(status(https(port, &tls13, big).await).contains("413"));
            // TLS 1.2 clients are refused at the handshake.
            assert!(https(port, &[&rustls::version::TLS12], &get("/", ""))
                .await
                .is_none());

            running.stop();
            tokio::time::sleep(Duration::from_millis(200)).await;
            assert!(
                tokio::net::TcpStream::connect(("127.0.0.1", port))
                    .await
                    .is_err(),
                "nothing listens after stop"
            );
        });
        let _ = std::fs::remove_dir_all(&dir);
    }

    // A stand-in API that records each raw request it gets and answers 200 with a cookie.
    async fn fake_api() -> (u16, Arc<Mutex<Vec<String>>>) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = seen.clone();
        tokio::spawn(async move {
            while let Ok((mut tcp, _)) = listener.accept().await {
                let log = log.clone();
                tokio::spawn(async move {
                    let mut raw = Vec::new();
                    let mut buf = [0u8; 4096];
                    loop {
                        let n = match tokio::time::timeout(
                            Duration::from_millis(500),
                            tcp.read(&mut buf),
                        )
                        .await
                        {
                            Ok(Ok(n)) if n > 0 => n,
                            _ => break,
                        };
                        raw.extend_from_slice(&buf[..n]);
                        let text = String::from_utf8_lossy(&raw);
                        if let Some((head, body)) = text.split_once("\r\n\r\n") {
                            let len = head
                                .lines()
                                .find_map(|l| l.strip_prefix("content-length: "))
                                .and_then(|v| v.trim().parse::<usize>().ok());
                            if len.is_some_and(|l| body.len() >= l) || body.ends_with("0\r\n\r\n") {
                                break;
                            }
                        }
                    }
                    log.lock()
                        .unwrap()
                        .push(String::from_utf8_lossy(&raw).into_owned());
                    let _ = tcp
                        .write_all(
                            b"HTTP/1.1 200 OK\r\ncontent-length: 2\r\nset-cookie: s=1\r\n\r\nok",
                        )
                        .await;
                });
            }
        });
        (port, seen)
    }

    #[test]
    fn forwards_only_the_first_device_key_and_safe_headers() {
        let dir = temp_dir("forward");
        tauri::async_runtime::block_on(async {
            let (api_port, seen) = fake_api().await;
            let running = start(&dir, api_port, None, 0, quiet_hooks()).unwrap();
            let req = "PATCH http://evil.example/api/uploads/tus/ab12 HTTP/1.1\r\nHost: evil.example\r\nConnection: close\r\n\
                x-api-key: phone-key\r\nx-api-key: second-key\r\nCookie: lifer_desktop=abc\r\n\
                x-lifer-launch-token: stolen\r\nX-Forwarded-For: 10.0.0.9\r\nForwarded: for=1.2.3.4\r\n\
                Authorization: Bearer x\r\nContent-Length: 5\r\n\r\nhello";
            let reply = https(running.port, &[&rustls::version::TLS13], req)
                .await
                .unwrap();
            assert!(reply.starts_with("HTTP/1.1 200"), "{reply}");
            assert!(!reply.to_ascii_lowercase().contains("set-cookie"));
            let got = seen.lock().unwrap().join("\n").to_ascii_lowercase();
            assert!(
                got.starts_with("patch /api/uploads/tus/ab12 http/1.1"),
                "{got}"
            );
            assert!(
                got.contains(&format!("host: 127.0.0.1:{api_port}")),
                "{got}"
            );
            assert!(got.contains("x-api-key: phone-key"));
            assert!(got.contains("content-length: 5") && got.ends_with("hello"));
            for absent in [
                "second-key",
                "cookie",
                "launch-token",
                "forwarded",
                "authorization",
                "evil",
            ] {
                assert!(!got.contains(absent), "{absent} reached the API: {got}");
            }
            running.stop();
        });
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn chunked_bodies_over_the_cap_are_refused() {
        let dir = temp_dir("chunked");
        tauri::async_runtime::block_on(async {
            let (api_port, _) = fake_api().await;
            let running = start(&dir, api_port, None, 0, quiet_hooks()).unwrap();
            let chunk = "a".repeat(5 * 1024);
            let req = format!(
                "POST /api/companion/v1/pair HTTP/1.1\r\nHost: x\r\nConnection: close\r\nTransfer-Encoding: chunked\r\n\r\n{:x}\r\n{chunk}\r\n0\r\n\r\n",
                chunk.len()
            );
            let reply = https(running.port, &[&rustls::version::TLS13], &req)
                .await
                .unwrap();
            assert!(reply.starts_with("HTTP/1.1 413"), "{reply}");
            running.stop();
        });
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn one_peer_gets_only_its_share_of_pairing_tries_and_connections() {
        let dir = temp_dir("peer");
        tauri::async_runtime::block_on(async {
            let (api_port, seen) = fake_api().await;
            let running = start(&dir, api_port, None, 0, quiet_hooks()).unwrap();
            let post = |path: &str| {
                format!("POST {path} HTTP/1.1\r\nHost: x\r\nConnection: close\r\nContent-Length: 2\r\n\r\n{{}}")
            };
            // Scanned codes and typed starts share one budget per peer.
            for i in 0..PAIR_TRIES_PER_PEER {
                let path = if i % 2 == 0 {
                    "/api/companion/v1/pair"
                } else {
                    "/api/companion/v1/pair/start"
                };
                let r = https(running.port, &[&rustls::version::TLS13], &post(path)).await;
                assert!(r.unwrap().starts_with("HTTP/1.1 200"));
            }
            for path in ["/api/companion/v1/pair", "/api/companion/v1/pair/start"] {
                let r = https(running.port, &[&rustls::version::TLS13], &post(path)).await;
                assert!(r.unwrap().starts_with("HTTP/1.1 429"), "{path}");
            }
            assert_eq!(seen.lock().unwrap().len(), PAIR_TRIES_PER_PEER);
            // Finishing needs the API's random session id, so it isn't a guess and isn't throttled.
            let r = https(
                running.port,
                &[&rustls::version::TLS13],
                &post("/api/companion/v1/pair/finish"),
            )
            .await;
            assert!(r.unwrap().starts_with("HTTP/1.1 200"));

            // Idle connections hold the peer's slots; one more is dropped.
            let mut idle = Vec::new();
            for _ in 0..MAX_CONNECTIONS_PER_PEER {
                idle.push(
                    tokio::net::TcpStream::connect(("127.0.0.1", running.port))
                        .await
                        .unwrap(),
                );
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
            let get = "GET /api/sync/changes HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n";
            assert!(https(running.port, &[&rustls::version::TLS13], get)
                .await
                .is_none());
            drop(idle);
            tokio::time::sleep(Duration::from_millis(200)).await;
            assert!(https(running.port, &[&rustls::version::TLS13], get)
                .await
                .is_some());
            running.stop();
        });
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn hooks_are_not_called_for_refused_requests() {
        let dir = temp_dir("hooks");
        let calls = Arc::new(AtomicUsize::new(0));
        let c = calls.clone();
        let hooks = Hooks {
            on_paired: Box::new({
                let c = c.clone();
                move || {
                    c.fetch_add(1, Ordering::SeqCst);
                }
            }),
            on_synced: Box::new(move || {
                c.fetch_add(1, Ordering::SeqCst);
            }),
        };
        tauri::async_runtime::block_on(async {
            let running = start(&dir, 9, None, 0, hooks).unwrap();
            let req = "GET /api/sync/changes HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n";
            let _ = https(running.port, &[&rustls::version::TLS13], req).await;
            running.stop();
        });
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn only_a_finished_pairing_counts_as_paired() {
        let dir = temp_dir("paired-hook");
        let paired = Arc::new(AtomicUsize::new(0));
        let p = paired.clone();
        let hooks = Hooks {
            on_paired: Box::new(move || {
                p.fetch_add(1, Ordering::SeqCst);
            }),
            on_synced: Box::new(|| {}),
        };
        tauri::async_runtime::block_on(async {
            let (api_port, _) = fake_api().await;
            let running = start(&dir, api_port, None, 0, hooks).unwrap();
            let post = |path: &str| {
                format!("POST {path} HTTP/1.1\r\nHost: x\r\nConnection: close\r\nContent-Length: 2\r\n\r\n{{}}")
            };
            let tls13 = [&rustls::version::TLS13];
            let _ = https(running.port, &tls13, &post("/api/companion/v1/pair/start")).await;
            tokio::time::sleep(Duration::from_millis(50)).await;
            assert_eq!(
                paired.load(Ordering::SeqCst),
                0,
                "a started pairing isn't one yet"
            );
            let _ = https(running.port, &tls13, &post("/api/companion/v1/pair/finish")).await;
            let _ = https(running.port, &tls13, &post("/api/companion/v1/pair")).await;
            tokio::time::sleep(Duration::from_millis(50)).await;
            assert_eq!(paired.load(Ordering::SeqCst), 2);
            running.stop();
        });
        let _ = std::fs::remove_dir_all(&dir);
    }
}
