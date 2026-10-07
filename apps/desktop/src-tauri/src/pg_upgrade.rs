// Upgrades the embedded database's data folder to the bundled PostgreSQL major version, once,
// when the app moves to a new major (see "Upgrading the bundled PostgreSQL to a new major
// version" in docs/docs/contributing/desktop-app.md).
//
// A PostgreSQL major can't open a data folder made by an older one, so before embedded_db.rs
// starts the server, prepare() compares the folder's PG_VERSION with BUNDLED_PG_MAJOR. When it's
// older, it runs pg_upgrade with the previous major's server, which the release that changes
// majors bundles in Resources/postgres-previous/<major> (stage-postgres.js), so it works
// offline:
//
// 1. Check free space and write a marker file (app-data/postgres-upgrade.json), so a crash or
//    force-quit part way through is cleaned up on the next launch, which then starts over.
// 2. Build the new cluster in postgres-data.upgrading, with the old one's encoding, locale and
//    checksum setting, and the same superuser and password.
// 3. pg_upgrade --clone (a copy-on-write clone: free on APFS, Btrfs and XFS), else --copy, else
//    a pg_dump and pg_restore of the lifer database. Not --link: its files would be shared with
//    the old folder, so the old copy kept below would be ruined as soon as the new server ran.
// 4. ANALYZE (vacuumdb --analyze-in-stages), so the first queries aren't planned blind.
// 5. Rename postgres-data to postgres-data.pg<old>-backup and the new folder into its place.
//
// The old folder is never deleted here. Once the API has started on the new cluster (so the
// migrations ran) and /health answers, the marker is removed and a dialog offers to delete the
// old copy, or keep it; the docs explain where it is.
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;

/// The PostgreSQL major the app bundles: data folders made by an older major are upgraded to
/// it. POSTGRES_VERSION in scripts/stage-postgres.js and BUNDLED_MAJOR in
/// scripts/build-postgres-macos.sh change with it (bundled_major_matches_the_build_scripts).
pub const BUNDLED_PG_MAJOR: u32 = 18;

const DATA_DIR: &str = "postgres-data";
const NEW_DATA_DIR: &str = "postgres-data.upgrading";
const WORK_DIR: &str = "postgres-upgrade-work";
const MARKER_FILE: &str = "postgres-upgrade.json";
const PREVIOUS_DIR: &str = "postgres-previous";
const DB_USER: &str = "postgres";
const DB_NAME: &str = "lifer";
const MB: u64 = 1024 * 1024;

pub const UPGRADE_TITLE: &str = "Upgrading your database (one time)…";

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum Phase {
    // Building the new cluster. The old folder is untouched; recovery deletes the new one.
    Converting,
    // Renaming the folders. Recovery finishes or undoes the renames.
    Swapping,
    // The new cluster is in place, waiting for the API to answer on it.
    Swapped,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
struct Marker {
    from: u32,
    to: u32,
    phase: Phase,
    backup_dir: PathBuf,
    method: Option<String>,
    // pg_upgrade's pid while it runs, so a relaunch can stop one a crash left running.
    child_pid: Option<u32>,
}

struct Layout {
    app_data: PathBuf,
}

impl Layout {
    fn new(app_data_dir: &Path) -> Self {
        Self {
            app_data: app_data_dir.join("app-data"),
        }
    }
    fn data(&self) -> PathBuf {
        self.app_data.join(DATA_DIR)
    }
    fn new_data(&self) -> PathBuf {
        self.app_data.join(NEW_DATA_DIR)
    }
    fn work(&self) -> PathBuf {
        self.app_data.join(WORK_DIR)
    }
    fn marker(&self) -> PathBuf {
        self.app_data.join(MARKER_FILE)
    }
    // postgres-data.pg17-backup, or -2, -3... if an earlier upgrade's copy is still there.
    fn backup_for(&self, from: u32) -> PathBuf {
        let base = format!("{DATA_DIR}.pg{from}-backup");
        let mut candidate = self.app_data.join(&base);
        let mut n = 2;
        while candidate.exists() {
            candidate = self.app_data.join(format!("{base}-{n}"));
            n += 1;
        }
        candidate
    }
}

fn read_marker(layout: &Layout) -> Option<Marker> {
    let text = std::fs::read_to_string(layout.marker()).ok()?;
    match serde_json::from_str(&text) {
        Ok(marker) => Some(marker),
        Err(e) => {
            eprintln!("[pg_upgrade] ignoring an unreadable {MARKER_FILE}: {e}");
            None
        }
    }
}

// Written to a temp file and renamed, so a crash never leaves half a marker.
fn write_marker(layout: &Layout, marker: &Marker) -> Result<(), String> {
    let path = layout.marker();
    let tmp = path.with_extension("json.tmp");
    let err = |e: std::io::Error| format!("Couldn't save {}: {e}", path.display());
    let json = serde_json::to_vec_pretty(marker).map_err(|e| e.to_string())?;
    {
        use std::io::Write;
        let mut file = std::fs::File::create(&tmp).map_err(err)?;
        file.write_all(&json).map_err(err)?;
        file.sync_all().map_err(err)?;
    }
    std::fs::rename(&tmp, &path).map_err(err)
}

fn remove_marker(layout: &Layout) {
    let _ = std::fs::remove_file(layout.marker());
}

/// The major version a data folder was made by (its PG_VERSION file), or None for no cluster.
pub fn data_major(data_dir: &Path) -> Option<u32> {
    std::fs::read_to_string(data_dir.join("PG_VERSION"))
        .ok()?
        .trim()
        .parse()
        .ok()
}

fn exe(name: &str) -> String {
    if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    }
}

/// The previous major's server, bundled by a release that changed majors.
fn previous_installation(resources: &Path, major: u32) -> Option<PathBuf> {
    let dir = resources.join(PREVIOUS_DIR).join(major.to_string());
    dir.join("bin").join(exe("pg_ctl")).is_file().then_some(dir)
}

// ---- Startup status ----------------------------------------------------------------------

static STATUS_WINDOW: Mutex<Option<tauri::WebviewWindow>> = Mutex::new(None);

/// The window whose startup page (src/index.html) shows upgrade progress, and whose app shows
/// the dialog about the old copy afterwards.
pub fn set_status_window(window: &tauri::WebviewWindow) {
    *STATUS_WINDOW.lock().unwrap() = Some(window.clone());
}

fn status_window() -> Option<tauri::WebviewWindow> {
    STATUS_WINDOW.lock().unwrap().clone()
}

// Shown on index.html while the app starts; a no-op on any other page.
fn report(detail: &str) {
    eprintln!("[pg_upgrade] {detail}");
    let Some(window) = status_window() else {
        return;
    };
    let (Ok(title), Ok(detail)) = (
        serde_json::to_string(UPGRADE_TITLE),
        serde_json::to_string(detail),
    ) else {
        return;
    };
    let _ = window.eval(format!(
        "window.__liferStartupStatus && window.__liferStartupStatus({title}, {detail});"
    ));
}

// ---- Running the PostgreSQL programs --------------------------------------------------------

fn command(program: &Path) -> Command {
    let mut cmd = Command::new(program);
    cmd.stdin(Stdio::null());
    // No console window flashing up for each program on Windows.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd
}

fn tail(text: &str, lines: usize) -> String {
    let all: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
    all[all.len().saturating_sub(lines)..].join("\n")
}

fn run(cmd: &mut Command, what: &str) -> Result<String, String> {
    let out = cmd
        .output()
        .map_err(|e| format!("couldn't run {what}: {e}"))?;
    let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
    if out.status.success() {
        return Ok(stdout);
    }
    let stderr = String::from_utf8_lossy(&out.stderr);
    Err(format!(
        "{what} failed ({}):\n{}",
        out.status,
        tail(&format!("{stdout}\n{stderr}"), 15)
    ))
}

fn free_port() -> Result<u16, String> {
    std::net::TcpListener::bind(("127.0.0.1", 0))
        .and_then(|l| l.local_addr())
        .map(|a| a.port())
        .map_err(|e| format!("couldn't find a free port: {e}"))
}

/// The two installs, and where their servers listen while upgrading: a private Unix socket
/// directory (no TCP port at all) on macOS and Linux, localhost on Windows.
struct Servers {
    old_bin: PathBuf,
    new_bin: PathBuf,
    socket_dir: Option<PathBuf>,
    old_port: u16,
    new_port: u16,
    work: PathBuf,
    password: String,
}

impl Servers {
    fn host(&self) -> String {
        match &self.socket_dir {
            Some(dir) => dir.to_string_lossy().into_owned(),
            None => "127.0.0.1".into(),
        }
    }

    fn server_options(&self, port: u16) -> String {
        match &self.socket_dir {
            Some(dir) => format!(
                "-p {port} -c listen_addresses='' -k \"{}\"",
                dir.to_string_lossy()
            ),
            None => format!("-p {port} -c listen_addresses=127.0.0.1"),
        }
    }

    fn start(&self, bin: &Path, data: &Path, port: u16, log: &str) -> Result<(), String> {
        run(
            command(&bin.join(exe("pg_ctl")))
                .arg("start")
                .arg("-w")
                .args(["-t", "300"])
                .arg("-D")
                .arg(data)
                .arg("-l")
                .arg(self.work.join(log))
                .arg("-o")
                .arg(self.server_options(port)),
            "pg_ctl start",
        )
        .map(|_| ())
        .map_err(|e| {
            let log = std::fs::read_to_string(self.work.join(log)).unwrap_or_default();
            format!("{e}\n{}", tail(&log, 10))
        })
    }

    fn client(&self, program: &str, port: u16) -> Command {
        let mut cmd = command(&self.new_bin.join(exe(program)));
        cmd.env("PGPASSWORD", &self.password)
            .args(["-h", &self.host()])
            .args(["-p", &port.to_string()])
            .args(["-U", DB_USER]);
        cmd
    }

    fn psql(&self, port: u16, db: &str, sql: &str) -> Result<String, String> {
        run(
            self.client("psql", port)
                .args(["-d", db, "-X", "-q", "-A", "-t"])
                .args(["-v", "ON_ERROR_STOP=1", "-c", sql]),
            "psql",
        )
        .map(|s| s.trim().to_string())
    }
}

/// Stops a server running on `data` (fast shutdown), if one is. Never fails: used to clean up.
fn stop_server(bin: &Path, data: &Path) {
    if !data.join("postmaster.pid").exists() {
        return;
    }
    let _ = command(&bin.join(exe("pg_ctl")))
        .arg("stop")
        .arg("-D")
        .arg(data)
        .args(["-m", "fast", "-w", "-t", "60"])
        .output();
    crate::embedded_db::clear_stale_lock_if_dead(data);
}

// ---- Disk space ------------------------------------------------------------------------------

fn dir_size(dir: &Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    entries
        .flatten()
        .map(|e| match e.metadata() {
            Ok(m) if m.is_dir() => dir_size(&e.path()),
            Ok(m) => m.len(),
            Err(_) => 0,
        })
        .sum()
}

/// Free bytes on the volume holding `dir`, or None when it can't be told.
#[cfg(unix)]
fn free_bytes(dir: &Path) -> Option<u64> {
    let out = Command::new("df").arg("-Pk").arg(dir).output().ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    let kb: u64 = text
        .lines()
        .nth(1)?
        .split_whitespace()
        .nth(3)?
        .parse()
        .ok()?;
    Some(kb * 1024)
}
#[cfg(windows)]
fn free_bytes(dir: &Path) -> Option<u64> {
    let out = command(Path::new("powershell"))
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "(Get-Item -LiteralPath $env:LIFER_FREE_SPACE_DIR).PSDrive.Free",
        ])
        .env("LIFER_FREE_SPACE_DIR", dir)
        .output()
        .ok()?;
    String::from_utf8_lossy(&out.stdout).trim().parse().ok()
}

fn gb(bytes: u64) -> String {
    format!("{:.1} GB", bytes as f64 / 1e9)
}

// ---- The upgrade -----------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Method {
    Clone,
    Copy,
    Dump,
}

impl Method {
    fn name(self) -> &'static str {
        match self {
            Method::Clone => "clone",
            Method::Copy => "copy",
            Method::Dump => "dump",
        }
    }
    fn detail(self) -> &'static str {
        match self {
            Method::Clone | Method::Copy => "Converting your library's database",
            Method::Dump => "Copying your library's database (this can take a few minutes)",
        }
    }
}

// LIFER_PG_UPGRADE_METHOD=clone|copy|dump forces one method (for tests and support).
fn methods(full_copy_fits: bool) -> Vec<Method> {
    match std::env::var("LIFER_PG_UPGRADE_METHOD").as_deref() {
        Ok("clone") => vec![Method::Clone],
        Ok("copy") => vec![Method::Copy],
        Ok("dump") => vec![Method::Dump],
        _ if full_copy_fits => vec![Method::Clone, Method::Copy, Method::Dump],
        _ => vec![Method::Clone],
    }
}

/// What the new cluster must match for pg_upgrade to accept it.
#[derive(Debug, Deserialize)]
struct OldCluster {
    encoding: String,
    collate: String,
    ctype: String,
    provider: String,
    locale: Option<String>,
    checksums: String,
}

// Starts the old server on its own socket to read what initdb must match, and which of the
// passwords this install may have is the cluster's. Also replays any WAL a crash left behind,
// since pg_upgrade only takes a cleanly shut down cluster.
fn inspect_old(
    servers: &mut Servers,
    data: &Path,
    passwords: &[String],
) -> Result<OldCluster, String> {
    crate::embedded_db::clear_stale_lock_if_dead(data);
    servers.start(
        &servers.old_bin.clone(),
        data,
        servers.old_port,
        "old-server.log",
    )?;
    let sql = "SELECT json_build_object(\
        'encoding', pg_encoding_to_char(d.encoding), \
        'collate', d.datcollate, 'ctype', d.datctype, \
        'provider', d.datlocprovider, \
        'locale', to_jsonb(d)->>'datlocale', \
        'checksums', current_setting('data_checksums')) \
        FROM pg_database d WHERE datname = 'template0'";
    let mut result = Err("no password to try".to_string());
    for password in passwords {
        servers.password = password.clone();
        result = servers.psql(servers.old_port, "postgres", sql);
        if result.is_ok() {
            break;
        }
    }
    stop_server(&servers.old_bin, data);
    let json = result.map_err(|e| format!("couldn't read the current database: {e}"))?;
    serde_json::from_str(&json).map_err(|e| format!("unexpected answer from the database: {e}"))
}

// initdb as postgresql_embedded runs it (superuser postgres, password auth, the install's
// password), matching the old cluster's encoding, locale and checksums as pg_upgrade requires.
fn initdb_new(servers: &Servers, new_data: &Path, old: &OldCluster) -> Result<(), String> {
    let _ = std::fs::remove_dir_all(new_data);
    let pwfile = servers.work.join("initdb-password");
    crate::embedded_db::write_secret_file(&pwfile, &servers.password)?;
    let mut cmd = command(&servers.new_bin.join(exe("initdb")));
    cmd.arg("-D")
        .arg(new_data)
        .args(["-U", DB_USER, "--auth=password"])
        .arg(format!("--pwfile={}", pwfile.to_string_lossy()))
        .arg(format!("--encoding={}", old.encoding))
        .arg(format!("--lc-collate={}", old.collate))
        .arg(format!("--lc-ctype={}", old.ctype))
        .arg("--no-instructions");
    match old.provider.as_str() {
        "c" => {
            cmd.arg("--locale-provider=libc");
        }
        "b" => {
            cmd.arg("--locale-provider=builtin").arg(format!(
                "--builtin-locale={}",
                old.locale.as_deref().unwrap_or("C")
            ));
        }
        other => {
            let _ = std::fs::remove_file(&pwfile);
            return Err(format!(
                "the database uses locale provider '{other}', which this build of PostgreSQL doesn't have"
            ));
        }
    }
    // PostgreSQL 18's initdb turns checksums on by default; pg_upgrade needs them to match.
    cmd.arg(if old.checksums == "on" {
        "--data-checksums"
    } else {
        "--no-data-checksums"
    });
    let result = run(&mut cmd, "initdb").map(|_| ());
    let _ = std::fs::remove_file(&pwfile);
    result
}

fn run_pg_upgrade(
    servers: &Servers,
    layout: &Layout,
    marker: &mut Marker,
    method: Method,
) -> Result<(), String> {
    let mut cmd = command(&servers.new_bin.join(exe("pg_upgrade")));
    cmd.current_dir(&servers.work)
        .env("PGPASSWORD", &servers.password)
        .arg("-b")
        .arg(&servers.old_bin)
        .arg("-B")
        .arg(&servers.new_bin)
        .arg("-d")
        .arg(layout.data())
        .arg("-D")
        .arg(layout.new_data())
        .args(["-U", DB_USER])
        .args(["-p", &servers.old_port.to_string()])
        .args(["-P", &servers.new_port.to_string()])
        .arg(if method == Method::Clone {
            "--clone"
        } else {
            "--copy"
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(dir) = &servers.socket_dir {
        cmd.arg("-s").arg(dir);
    }
    let child = cmd
        .spawn()
        .map_err(|e| format!("couldn't run pg_upgrade: {e}"))?;
    marker.child_pid = Some(child.id());
    write_marker(layout, marker)?;
    let out = child
        .wait_with_output()
        .map_err(|e| format!("pg_upgrade didn't finish: {e}"))?;
    marker.child_pid = None;
    write_marker(layout, marker)?;
    if out.status.success() {
        return Ok(());
    }
    // pg_upgrade names the log that explains it; include the end of each.
    let mut detail = format!(
        "{}\n{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    for log in find_logs(&layout.new_data().join("pg_upgrade_output.d")) {
        if let Ok(text) = std::fs::read_to_string(&log) {
            detail.push_str(&format!("\n{}:\n{}", log.display(), tail(&text, 10)));
        }
    }
    Err(format!(
        "pg_upgrade --{} failed ({}):\n{}",
        method.name(),
        out.status,
        tail(&detail, 40)
    ))
}

fn find_logs(dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut logs = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            logs.extend(find_logs(&path));
        } else if path.extension().is_some_and(|e| e == "log" || e == "txt") {
            logs.push(path);
        }
    }
    logs
}

// The fallback when pg_upgrade can't: both servers running, the new pg_dump reads the lifer
// database from the old one and pg_restore --create recreates it in the new one. The only role
// is the bootstrap superuser, which initdb already made with the same password.
fn dump_and_restore(servers: &Servers, layout: &Layout) -> Result<(), String> {
    let data = layout.data();
    let new_data = layout.new_data();
    let result = (|| {
        servers.start(&servers.old_bin, &data, servers.old_port, "old-server.log")?;
        servers.start(
            &servers.new_bin,
            &new_data,
            servers.new_port,
            "new-server.log",
        )?;
        let exists = servers.psql(
            servers.old_port,
            "postgres",
            &format!("SELECT count(*) FROM pg_database WHERE datname = '{DB_NAME}'"),
        )?;
        if exists != "1" {
            return Ok(());
        }
        let dump = servers.work.join("lifer.dump");
        run(
            servers
                .client("pg_dump", servers.old_port)
                .args(["-Fc", "-d", DB_NAME, "-f"])
                .arg(&dump),
            "pg_dump",
        )?;
        run(
            servers
                .client("pg_restore", servers.new_port)
                .args(["--create", "--exit-on-error", "-d", "postgres"])
                .arg(&dump),
            "pg_restore",
        )?;
        let _ = std::fs::remove_file(&dump);
        Ok(())
    })();
    stop_server(&servers.old_bin, &data);
    stop_server(&servers.new_bin, &new_data);
    result
}

// pg_upgrade carries most planner statistics over (PostgreSQL 18 and later), so only what's
// missing is gathered; after a dump and restore, everything is. In stages, so it's quick.
fn analyze(servers: &Servers, new_data: &Path, method: Method) -> Result<(), String> {
    servers.start(
        &servers.new_bin,
        new_data,
        servers.new_port,
        "new-server.log",
    )?;
    let mut cmd = servers.client("vacuumdb", servers.new_port);
    cmd.args(["--all", "--analyze-in-stages"]);
    if method != Method::Dump {
        cmd.arg("--missing-stats-only");
    }
    let result = run(&mut cmd, "vacuumdb").map(|_| ());
    stop_server(&servers.new_bin, new_data);
    result
}

// Moves the old folder aside and the new one into place. Safe to repeat after a crash at any
// point: each step checks what's already been done.
fn swap(layout: &Layout, marker: &mut Marker) -> Result<(), String> {
    let data = layout.data();
    let new_data = layout.new_data();
    let rename = |from: &Path, to: &Path| {
        std::fs::rename(from, to).map_err(|e| {
            format!(
                "couldn't rename {} to {}: {e}",
                from.display(),
                to.display()
            )
        })
    };
    marker.phase = Phase::Swapping;
    write_marker(layout, marker)?;
    if data_major(&data) == Some(marker.from) && data_major(&new_data) == Some(marker.to) {
        rename(&data, &marker.backup_dir)?;
    }
    if !data.exists() {
        if data_major(&new_data) == Some(marker.to) {
            rename(&new_data, &data)?;
        } else if data_major(&marker.backup_dir) == Some(marker.from) {
            // The new cluster is gone: put the old one back and upgrade again.
            rename(&marker.backup_dir, &data)?;
            remove_marker(layout);
            return Err("the upgraded database went missing, so the old one was restored".into());
        }
    }
    if data_major(&data) != Some(marker.to) {
        return Err(format!(
            "{} isn't a PostgreSQL {} database after the upgrade",
            data.display(),
            marker.to
        ));
    }
    marker.phase = Phase::Swapped;
    write_marker(layout, marker)
}

fn kill_stray_pg_upgrade(pid: u32) {
    #[cfg(unix)]
    {
        let is_pg_upgrade = Command::new("ps")
            .args(["-p", &pid.to_string(), "-o", "comm="])
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).contains("pg_upgrade"))
            .unwrap_or(false);
        if is_pg_upgrade {
            eprintln!("[pg_upgrade] stopping pg_upgrade {pid}, left running by a previous launch");
            let _ = Command::new("kill").args(["-9", &pid.to_string()]).status();
            std::thread::sleep(Duration::from_millis(500));
        }
    }
    #[cfg(windows)]
    {
        let listed = command(Path::new("tasklist"))
            .args(["/FI", &format!("PID eq {pid}"), "/NH"])
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).contains("pg_upgrade"))
            .unwrap_or(false);
        if listed {
            let _ = command(Path::new("taskkill"))
                .args(["/F", "/T", "/PID", &pid.to_string()])
                .status();
        }
    }
}

// A previous launch stopped part way through an upgrade (crash, force-quit, power loss).
fn recover(layout: &Layout, resources: &Path, installation: Option<&Path>, marker: &Marker) {
    match marker.phase {
        Phase::Converting => {
            eprintln!(
                "[pg_upgrade] a previous upgrade from PostgreSQL {} didn't finish; cleaning up to start over",
                marker.from
            );
            if let Some(pid) = marker.child_pid {
                kill_stray_pg_upgrade(pid);
            }
            // Servers pg_upgrade or this module started outlive the app that started them.
            if let Some(new_install) = installation {
                stop_server(&new_install.join("bin"), &layout.new_data());
            }
            if let Some(old_install) = previous_installation(resources, marker.from) {
                stop_server(&old_install.join("bin"), &layout.data());
            }
            let _ = std::fs::remove_dir_all(layout.new_data());
            let _ = std::fs::remove_dir_all(layout.work());
            remove_marker(layout);
        }
        Phase::Swapping => {
            let mut marker = marker.clone();
            if let Err(e) = swap(layout, &mut marker) {
                eprintln!("[pg_upgrade] couldn't finish the interrupted upgrade: {e}");
            }
        }
        // Waiting for the API: after_start() watches for it.
        Phase::Swapped => {}
    }
}

fn upgrade(
    layout: &Layout,
    old_install: &Path,
    new_install: &Path,
    from: u32,
    passwords: &[String],
) -> Result<(), String> {
    report("Checking free space");
    let data = layout.data();
    let data_bytes = dir_size(&data);
    // A clone shares the old files, so it needs little; a copy or a dump needs the whole size
    // again, plus room for the new cluster's own WAL and catalogs.
    let clone_needs = data_bytes / 10 + 256 * MB;
    let copy_needs = data_bytes + data_bytes / 5 + 512 * MB;
    let free = free_bytes(&layout.app_data);
    if let Some(free) = free {
        if free < clone_needs {
            return Err(format!(
                "There isn't enough free disk space to upgrade your library's database: it needs at least {} free, and {} is. Free up some space and open Lifer again.",
                gb(clone_needs),
                gb(free)
            ));
        }
    }
    let full_copy_fits = free.is_none_or(|f| f >= copy_needs);

    let mut marker = Marker {
        from,
        to: BUNDLED_PG_MAJOR,
        phase: Phase::Converting,
        backup_dir: layout.backup_for(from),
        method: None,
        child_pid: None,
    };
    write_marker(layout, &marker)?;
    let _ = std::fs::remove_dir_all(layout.new_data());
    let _ = std::fs::remove_dir_all(layout.work());
    std::fs::create_dir_all(layout.work())
        .map_err(|e| format!("couldn't create {}: {e}", layout.work().display()))?;

    // Unix socket paths are limited to about 100 bytes, so not under the app data folder (nor a
    // long TMPDIR).
    let socket_dir = if cfg!(unix) {
        let tmp = std::env::temp_dir();
        let base = if tmp.as_os_str().len() > 60 {
            PathBuf::from("/tmp")
        } else {
            tmp
        };
        let dir = base.join(format!("lifer-pgu-{}", std::process::id()));
        std::fs::create_dir_all(&dir)
            .map_err(|e| format!("couldn't create {}: {e}", dir.display()))?;
        Some(dir)
    } else {
        None
    };
    let mut servers = Servers {
        old_bin: old_install.join("bin"),
        new_bin: new_install.join("bin"),
        socket_dir: socket_dir.clone(),
        old_port: free_port()?,
        new_port: free_port()?,
        work: layout.work(),
        password: String::new(),
    };

    let result = (|| {
        report("Reading your library's database");
        let old = inspect_old(&mut servers, &data, passwords)?;
        let mut failures = Vec::new();
        let mut used = None;
        for method in methods(full_copy_fits) {
            initdb_new(&servers, &layout.new_data(), &old)?;
            report(method.detail());
            let attempt = match method {
                Method::Clone | Method::Copy => {
                    run_pg_upgrade(&servers, layout, &mut marker, method)
                }
                Method::Dump => dump_and_restore(&servers, layout),
            };
            match attempt {
                Ok(()) => {
                    used = Some(method);
                    break;
                }
                Err(e) => {
                    eprintln!("[pg_upgrade] {e}");
                    failures.push(e);
                    stop_server(&servers.old_bin, &data);
                    stop_server(&servers.new_bin, &layout.new_data());
                }
            }
        }
        let Some(method) = used else {
            let space = if full_copy_fits {
                String::new()
            } else {
                format!(
                    " With {} free, Lifer could only try a copy-on-write clone; a full copy needs {}.",
                    gb(free.unwrap_or(0)),
                    gb(copy_needs)
                )
            };
            return Err(format!(
                "Lifer couldn't upgrade your library's database to PostgreSQL {BUNDLED_PG_MAJOR}. Nothing was changed.{space}\n\n{}",
                failures.join("\n\n")
            ));
        };
        eprintln!("[pg_upgrade] converted with {}", method.name());
        marker.method = Some(method.name().into());

        report("Optimizing your database");
        if let Err(e) = analyze(&servers, &layout.new_data(), method) {
            // Only slower first queries; autovacuum analyzes the tables soon anyway.
            eprintln!("[pg_upgrade] warning: ANALYZE after the upgrade failed: {e}");
        }

        report("Finishing up");
        swap(layout, &mut marker)
    })();

    if let Some(dir) = socket_dir {
        let _ = std::fs::remove_dir_all(dir);
    }
    match result {
        Ok(()) => {
            let _ = std::fs::remove_dir_all(layout.work());
            Ok(())
        }
        Err(e) => {
            // Back to how it was: the old folder is untouched until swap() renames it.
            if marker.phase == Phase::Converting {
                let _ = std::fs::remove_dir_all(layout.new_data());
                let _ = std::fs::remove_dir_all(layout.work());
                remove_marker(layout);
            }
            Err(e)
        }
    }
}

fn prepare_blocking(
    layout: Layout,
    resources: PathBuf,
    installation: Option<PathBuf>,
    passwords: Vec<String>,
) -> Result<(), String> {
    if let Some(marker) = read_marker(&layout) {
        recover(&layout, &resources, installation.as_deref(), &marker);
    }
    let Some(major) = data_major(&layout.data()) else {
        return Ok(()); // A fresh install: initdb makes it with the bundled major.
    };
    if major == BUNDLED_PG_MAJOR {
        return Ok(());
    }
    if major > BUNDLED_PG_MAJOR {
        return Err(format!(
            "Your library's database was made by a newer version of Lifer (PostgreSQL {major}), and this version uses PostgreSQL {BUNDLED_PG_MAJOR}. Install the latest version of Lifer to open it."
        ));
    }
    let Some(new_install) = installation else {
        // A build without a bundled server downloads one, so there's no matching old one either.
        eprintln!("[pg_upgrade] the data folder is PostgreSQL {major}, but this build bundles no server to upgrade it with");
        return Ok(());
    };
    let Some(old_install) = previous_installation(&resources, major) else {
        return Err(format!(
            "Your library's database was made by PostgreSQL {major}, and this version of Lifer can't upgrade it directly to PostgreSQL {BUNDLED_PG_MAJOR}. Install the previous release of Lifer first and open your library with it once, then install this one. Your data is unchanged."
        ));
    };
    eprintln!(
        "[pg_upgrade] upgrading the data folder from PostgreSQL {major} to {BUNDLED_PG_MAJOR}"
    );
    upgrade(&layout, &old_install, &new_install, major, &passwords)
}

/// Before embedded_db starts the server: finishes or cleans up an interrupted upgrade, and
/// upgrades a data folder made by the previous major. `passwords` are the ones the cluster may
/// have (this install's, a pending one, the legacy default), in that order.
pub async fn prepare(
    app_data_dir: &Path,
    resources: &Path,
    installation: Option<&Path>,
    passwords: Vec<String>,
) -> Result<(), String> {
    let layout = Layout::new(app_data_dir);
    let resources = resources.to_path_buf();
    let installation = installation.map(Path::to_path_buf);
    tauri::async_runtime::spawn_blocking(move || {
        prepare_blocking(layout, resources, installation, passwords)
    })
    .await
    .map_err(|e| format!("The database upgrade stopped unexpectedly: {e}"))?
}

/// Marks an upgrade done once the app is running on it: removes the marker, and returns the old
/// copy that's kept (and its size), or None when there was no upgrade waiting.
pub fn confirm_upgrade(app_data_dir: &Path) -> Option<(PathBuf, u64)> {
    let layout = Layout::new(app_data_dir);
    let marker = read_marker(&layout)?;
    if marker.phase != Phase::Swapped {
        return None;
    }
    remove_marker(&layout);
    eprintln!(
        "[pg_upgrade] the upgrade to PostgreSQL {} is confirmed; the old copy is in {}",
        marker.to,
        marker.backup_dir.display()
    );
    let bytes = dir_size(&marker.backup_dir);
    marker
        .backup_dir
        .exists()
        .then_some((marker.backup_dir, bytes))
}

/// After the server started: if it's a just-upgraded cluster, wait for the API to answer on it
/// (so the migrations ran too), then confirm the upgrade and offer to delete the old copy.
pub fn after_start(app_data_dir: &Path) {
    let layout = Layout::new(app_data_dir);
    // Tests confirm explicitly (a real app may be answering on LOCAL_PORT meanwhile).
    if cfg!(test) || read_marker(&layout).map(|m| m.phase) != Some(Phase::Swapped) {
        return;
    }
    let app_data_dir = app_data_dir.to_path_buf();
    tauri::async_runtime::spawn(async move {
        let url = format!("http://127.0.0.1:{}/health", crate::api::LOCAL_PORT);
        // Generous: the first launch after an upgrade may also restore or migrate a lot.
        for _ in 0..900 {
            if crate::api::is_reachable(&url).await {
                if let Some((backup, bytes)) = confirm_upgrade(&app_data_dir) {
                    offer_to_delete(backup, bytes);
                }
                return;
            }
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
        eprintln!(
            "[pg_upgrade] the API didn't answer after the upgrade; checking again next launch"
        );
    });
}

fn offer_to_delete(backup: PathBuf, bytes: u64) {
    use tauri::Manager;
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
    let Some(window) = status_window() else {
        return;
    };
    let message = format!(
        "Lifer upgraded your library's database to PostgreSQL {BUNDLED_PG_MAJOR}.\n\n\
         A copy of the old database ({}) is kept in case anything looks wrong:\n{}\n\n\
         Once your library looks right, you can delete it. If you keep it, you can delete that folder yourself later.",
        gb(bytes),
        backup.display()
    );
    window
        .app_handle()
        .dialog()
        .message(message)
        .title("Database upgraded")
        .kind(MessageDialogKind::Info)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Delete Old Copy".into(),
            "Keep for Now".into(),
        ))
        .show(move |delete| {
            if delete {
                std::thread::spawn(move || match std::fs::remove_dir_all(&backup) {
                    Ok(()) => eprintln!("[pg_upgrade] deleted {}", backup.display()),
                    Err(e) => eprintln!("[pg_upgrade] couldn't delete {}: {e}", backup.display()),
                });
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_app_dir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("lifer-pg-upgrade-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("app-data")).unwrap();
        dir
    }

    fn fake_cluster(dir: &Path, major: u32) {
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(dir.join("PG_VERSION"), format!("{major}\n")).unwrap();
    }

    // The one constant and the two build scripts must name the same major.
    #[test]
    fn bundled_major_matches_the_build_scripts() {
        let scripts = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../scripts");
        let stage = std::fs::read_to_string(scripts.join("stage-postgres.js")).unwrap();
        let version = stage
            .lines()
            .find_map(|l| l.strip_prefix("export const POSTGRES_VERSION = \""))
            .expect("POSTGRES_VERSION in stage-postgres.js");
        assert_eq!(
            version.split('.').next().unwrap(),
            BUNDLED_PG_MAJOR.to_string()
        );
        let build = std::fs::read_to_string(scripts.join("build-postgres-macos.sh")).unwrap();
        assert!(build.contains(&format!("BUNDLED_MAJOR=\"{BUNDLED_PG_MAJOR}\"")));
    }

    #[test]
    fn reads_pg_version() {
        let app = temp_app_dir("version");
        let layout = Layout::new(&app);
        assert_eq!(data_major(&layout.data()), None);
        fake_cluster(&layout.data(), 17);
        assert_eq!(data_major(&layout.data()), Some(17));
        let _ = std::fs::remove_dir_all(&app);
    }

    #[test]
    fn backup_names_never_overwrite_an_earlier_copy() {
        let app = temp_app_dir("backup-name");
        let layout = Layout::new(&app);
        let first = layout.backup_for(17);
        assert!(first.ends_with("postgres-data.pg17-backup"));
        std::fs::create_dir_all(&first).unwrap();
        assert!(layout
            .backup_for(17)
            .ends_with("postgres-data.pg17-backup-2"));
        let _ = std::fs::remove_dir_all(&app);
    }

    // A crash at each point of the folder swap, then the next launch's recovery.
    #[test]
    fn interrupted_swap_is_finished_or_undone() {
        let app = temp_app_dir("swap");
        let layout = Layout::new(&app);
        let marker = |layout: &Layout| Marker {
            from: 17,
            to: 18,
            phase: Phase::Swapping,
            backup_dir: layout.app_data.join("postgres-data.pg17-backup"),
            method: Some("clone".into()),
            child_pid: None,
        };
        let check_done = |layout: &Layout| {
            assert_eq!(data_major(&layout.data()), Some(18));
            assert_eq!(
                data_major(&layout.app_data.join("postgres-data.pg17-backup")),
                Some(17)
            );
            assert!(!layout.new_data().exists());
            assert_eq!(read_marker(layout).unwrap().phase, Phase::Swapped);
        };
        let reset = |layout: &Layout| {
            for d in [
                "postgres-data",
                "postgres-data.upgrading",
                "postgres-data.pg17-backup",
            ] {
                let _ = std::fs::remove_dir_all(layout.app_data.join(d));
            }
            remove_marker(layout);
        };

        // Crashed before either rename.
        fake_cluster(&layout.data(), 17);
        fake_cluster(&layout.new_data(), 18);
        write_marker(&layout, &marker(&layout)).unwrap();
        recover(&layout, Path::new("/nonexistent"), None, &marker(&layout));
        check_done(&layout);
        reset(&layout);

        // Crashed between the two renames.
        fake_cluster(&layout.app_data.join("postgres-data.pg17-backup"), 17);
        fake_cluster(&layout.new_data(), 18);
        write_marker(&layout, &marker(&layout)).unwrap();
        recover(&layout, Path::new("/nonexistent"), None, &marker(&layout));
        check_done(&layout);
        reset(&layout);

        // Crashed after both: nothing left to do but record it.
        fake_cluster(&layout.data(), 18);
        fake_cluster(&layout.app_data.join("postgres-data.pg17-backup"), 17);
        write_marker(&layout, &marker(&layout)).unwrap();
        recover(&layout, Path::new("/nonexistent"), None, &marker(&layout));
        check_done(&layout);

        // Confirming removes the marker and reports the old copy, and only once.
        let (backup, _) = confirm_upgrade(&app).unwrap();
        assert!(backup.ends_with("postgres-data.pg17-backup"));
        assert!(confirm_upgrade(&app).is_none());
        reset(&layout);

        // The new cluster vanished mid-swap: the old one goes back, to be upgraded again.
        fake_cluster(&layout.app_data.join("postgres-data.pg17-backup"), 17);
        write_marker(&layout, &marker(&layout)).unwrap();
        recover(&layout, Path::new("/nonexistent"), None, &marker(&layout));
        assert_eq!(data_major(&layout.data()), Some(17));
        assert!(read_marker(&layout).is_none());
        let _ = std::fs::remove_dir_all(&app);
    }

    // A crash while converting leaves the old folder as it was; recovery removes the rest.
    #[test]
    fn interrupted_conversion_is_cleaned_up() {
        let app = temp_app_dir("converting");
        let layout = Layout::new(&app);
        fake_cluster(&layout.data(), 17);
        fake_cluster(&layout.new_data(), 18);
        std::fs::create_dir_all(layout.work()).unwrap();
        let marker = Marker {
            from: 17,
            to: 18,
            phase: Phase::Converting,
            backup_dir: layout.backup_for(17),
            method: None,
            child_pid: None,
        };
        write_marker(&layout, &marker).unwrap();
        recover(&layout, Path::new("/nonexistent"), None, &marker);
        assert_eq!(data_major(&layout.data()), Some(17));
        assert!(!layout.new_data().exists());
        assert!(!layout.work().exists());
        assert!(read_marker(&layout).is_none());
        let _ = std::fs::remove_dir_all(&app);
    }

    #[test]
    fn refuses_newer_and_unsupported_older_data() {
        let app = temp_app_dir("refuse");
        let layout = Layout::new(&app);
        let resources = app.join("resources");
        let installation = Some(resources.join("postgres"));

        fake_cluster(&layout.data(), BUNDLED_PG_MAJOR + 1);
        let err = prepare_blocking(
            Layout::new(&app),
            resources.clone(),
            installation.clone(),
            vec![],
        )
        .unwrap_err();
        assert!(err.contains("newer version of Lifer"), "{err}");

        fake_cluster(&layout.data(), BUNDLED_PG_MAJOR - 1);
        let err = prepare_blocking(Layout::new(&app), resources, installation, vec![]).unwrap_err();
        assert!(err.contains("Install the previous release"), "{err}");
        assert_eq!(data_major(&layout.data()), Some(BUNDLED_PG_MAJOR - 1));
        let _ = std::fs::remove_dir_all(&app);
    }

    // ---- A real upgrade from the previous major: tests/pg-upgrade-test.sh sets these up --------
    //   LIFER_PG_UPGRADE_TEST_TEMPLATE   an app data folder whose app-data/postgres-data is a
    //                                    migrated cluster of the previous major, with its
    //                                    fingerprint.txt (tests/pg-upgrade/fingerprint.sql)
    //   LIFER_PG_UPGRADE_TEST_RESOURCES  resources with postgres/ and postgres-previous/<major>/
    //   LIFER_PG_UPGRADE_TEST_OUT        where the upgraded copies go (out/auto is kept for the
    //                                    script's API check)

    use crate::embedded_db::start_embedded_postgres;
    use postgresql_commands::psql::PsqlBuilder;
    use postgresql_commands::traits::{CommandBuilder, CommandExecutor};
    use postgresql_embedded::PostgreSQL;

    struct Fixture {
        template: PathBuf,
        resources: PathBuf,
        out: PathBuf,
    }

    fn fixture() -> Option<Fixture> {
        let var = |name: &str| std::env::var_os(name).map(PathBuf::from);
        let fixture = Fixture {
            template: var("LIFER_PG_UPGRADE_TEST_TEMPLATE")?,
            resources: var("LIFER_PG_UPGRADE_TEST_RESOURCES")?,
            out: var("LIFER_PG_UPGRADE_TEST_OUT")?,
        };
        Some(fixture)
    }

    // Keeps permissions (a data folder must stay 0700).
    fn copy_tree(from: &Path, to: &Path) {
        std::fs::create_dir_all(to).unwrap();
        for entry in std::fs::read_dir(from).unwrap().flatten() {
            let target = to.join(entry.file_name());
            if entry.file_type().unwrap().is_dir() {
                copy_tree(&entry.path(), &target);
            } else {
                std::fs::copy(entry.path(), &target).unwrap();
            }
        }
        std::fs::set_permissions(to, std::fs::metadata(from).unwrap().permissions()).unwrap();
    }

    fn fresh_copy(fixture: &Fixture, name: &str) -> PathBuf {
        let app = fixture.out.join(name);
        let _ = std::fs::remove_dir_all(&app);
        copy_tree(&fixture.template, &app);
        app
    }

    fn query(postgresql: &PostgreSQL, sql: &str) -> String {
        let (stdout, _) = PsqlBuilder::from(postgresql.settings())
            .dbname("lifer")
            .no_psqlrc()
            .command(sql)
            .tuples_only()
            .no_align()
            .variable(("ON_ERROR_STOP", "1"))
            .build()
            .execute()
            .unwrap_or_else(|e| panic!("{sql}: {e}"));
        stdout.trim().to_string()
    }

    // What every upgraded copy must show: the new major, the same contents, the extensions
    // working, the indexes used, planner statistics, and the old copy kept.
    fn verify(fixture: &Fixture, app: &Path, postgresql: &PostgreSQL) -> String {
        let layout = Layout::new(app);
        assert_eq!(data_major(&layout.data()), Some(BUNDLED_PG_MAJOR));
        assert!(
            query(postgresql, "SHOW server_version_num").starts_with(&BUNDLED_PG_MAJOR.to_string())
        );

        let fingerprint_sql = std::fs::read_to_string(
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/pg-upgrade/fingerprint.sql"),
        )
        .unwrap();
        let expected = std::fs::read_to_string(fixture.template.join("fingerprint.txt")).unwrap();
        assert_eq!(query(postgresql, &fingerprint_sql), expected.trim());

        for (sql, index) in [
            (
                "SELECT id FROM upgrade_sentinel WHERE name % 'Nandu comun 42'",
                "upgrade_sentinel_trgm",
            ),
            (
                "SELECT id FROM upgrade_sentinel WHERE lifer_unaccent(name) = 'Nandu comun 7'",
                "upgrade_sentinel_unaccent",
            ),
            (
                "SELECT id FROM species WHERE common_name % 'nandu heron'",
                "idx_species_common_name_trgm",
            ),
        ] {
            let plan = query(
                postgresql,
                &format!("SET enable_seqscan = off; EXPLAIN (COSTS OFF) {sql}"),
            );
            assert!(plan.contains(index), "{sql} doesn't use {index}:\n{plan}");
        }
        assert_eq!(
            query(postgresql, "SELECT encode(digest('lifer', 'sha256'), 'hex') = encode(sha256('lifer'::bytea), 'hex')"),
            "t"
        );
        assert_eq!(
            query(
                postgresql,
                "SELECT count(*) > 0 FROM pg_stats WHERE tablename = 'upgrade_sentinel'"
            ),
            "t"
        );

        let marker = read_marker(&layout).expect("an upgrade marker waiting for /health");
        assert_eq!(marker.phase, Phase::Swapped);
        assert_eq!(data_major(&marker.backup_dir), Some(marker.from));
        assert!(!layout.new_data().exists() && !layout.work().exists());
        let method = marker.method.clone().unwrap();
        let (backup, bytes) = confirm_upgrade(app).unwrap();
        assert_eq!(backup, marker.backup_dir);
        assert!(bytes > 0);
        eprintln!(
            "[pg_upgrade test] {} upgraded with {method}; old copy {} MB",
            app.display(),
            bytes / MB
        );
        method
    }

    fn upgrade_and_verify(fixture: &Fixture, app: &Path) -> String {
        tauri::async_runtime::block_on(async {
            let (postgresql, _url) = start_embedded_postgres(app, &fixture.resources)
                .await
                .expect("start after the upgrade");
            let method = verify(fixture, app, &postgresql);
            postgresql.stop().await.expect("stop");
            method
        })
    }

    #[test]
    #[ignore = "needs tests/pg-upgrade-test.sh's fixture"]
    fn pg_upgrade_each_method() {
        let Some(fixture) = fixture() else {
            panic!("run tests/pg-upgrade-test.sh, which sets LIFER_PG_UPGRADE_TEST_*");
        };
        for (name, forced) in [
            ("auto", None),
            ("copy", Some("copy")),
            ("dump", Some("dump")),
        ] {
            let app = fresh_copy(&fixture, name);
            match forced {
                Some(method) => std::env::set_var("LIFER_PG_UPGRADE_METHOD", method),
                None => std::env::remove_var("LIFER_PG_UPGRADE_METHOD"),
            }
            let method = upgrade_and_verify(&fixture, &app);
            std::env::remove_var("LIFER_PG_UPGRADE_METHOD");
            match forced {
                Some(m) => assert_eq!(method, m),
                // A clone where the filesystem has them (APFS), else a copy.
                None => assert!(method == "clone" || method == "copy", "{method}"),
            }
            if cfg!(target_os = "macos") && forced.is_none() {
                assert_eq!(method, "clone", "APFS should take a clone");
            }
            // A second launch on the upgraded folder: nothing to upgrade, starts as usual.
            tauri::async_runtime::block_on(async {
                let (postgresql, _) = start_embedded_postgres(&app, &fixture.resources)
                    .await
                    .unwrap();
                assert!(read_marker(&Layout::new(&app)).is_none());
                postgresql.stop().await.unwrap();
            });
        }
    }

    // The process the crash test kills part way through an upgrade.
    #[test]
    #[ignore = "run by pg_upgrade_crash_recovery"]
    fn pg_upgrade_child_process() {
        let (Some(app), Some(fixture)) =
            (std::env::var_os("LIFER_PG_UPGRADE_CHILD_APP"), fixture())
        else {
            return;
        };
        let app = PathBuf::from(app);
        let installation = fixture.resources.join("postgres");
        let password = std::fs::read_to_string(app.join("app-data/postgres-password")).unwrap();
        let _ = tauri::async_runtime::block_on(prepare(
            &app,
            &fixture.resources,
            Some(&installation),
            vec![password],
        ));
    }

    #[test]
    #[ignore = "needs tests/pg-upgrade-test.sh's fixture"]
    fn pg_upgrade_crash_recovery() {
        let Some(fixture) = fixture() else {
            panic!("run tests/pg-upgrade-test.sh, which sets LIFER_PG_UPGRADE_TEST_*");
        };
        let app = fresh_copy(&fixture, "crash");
        let layout = Layout::new(&app);
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "pg_upgrade::tests::pg_upgrade_child_process",
                "--ignored",
                "--nocapture",
            ])
            .env("LIFER_PG_UPGRADE_CHILD_APP", &app)
            .env("LIFER_PG_UPGRADE_METHOD", "copy")
            .spawn()
            .unwrap();
        // Killed (like a force-quit) once pg_upgrade is running.
        let started = std::time::Instant::now();
        let pg_upgrade_pid = loop {
            if let Some(pid) = read_marker(&layout).and_then(|m| m.child_pid) {
                break pid;
            }
            assert!(
                started.elapsed() < Duration::from_secs(120),
                "pg_upgrade never started"
            );
            assert!(
                child.try_wait().unwrap().is_none(),
                "the upgrade finished before it could be killed"
            );
            std::thread::sleep(Duration::from_millis(50));
        };
        std::thread::sleep(Duration::from_millis(1500));
        child.kill().unwrap();
        child.wait().unwrap();
        let marker = read_marker(&layout).unwrap();
        assert_eq!(
            marker.phase,
            Phase::Converting,
            "killed too late to test a mid-upgrade crash"
        );
        assert_eq!(data_major(&layout.data()), Some(marker.from));
        eprintln!("[pg_upgrade test] killed the upgrade mid-way (pg_upgrade {pg_upgrade_pid})");

        // Relaunch: cleans up, upgrades again, and leaves nothing of the crashed attempt running.
        let method = upgrade_and_verify(&fixture, &app);
        assert!(method == "clone" || method == "copy", "{method}");
        let alive = Command::new("kill")
            .args(["-0", &pg_upgrade_pid.to_string()])
            .status()
            .unwrap()
            .success();
        assert!(!alive, "the crashed launch's pg_upgrade is still running");
        let backup = app.join(format!("app-data/postgres-data.pg{}-backup", marker.from));
        assert!(
            !backup.join("postmaster.pid").exists(),
            "a server is still running on the old copy"
        );
    }
}
