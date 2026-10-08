// Runs an embedded Postgres server as a managed sidecar so local mode needs no manual setup.
// Plain Postgres, no PostGIS: the schema never calls a PostGIS function, and geometry lives in TS.
// The server is bundled with the app (scripts/stage-postgres.js), so nothing is downloaded.
// A data folder made by an older PostgreSQL major is upgraded first (pg_upgrade.rs).
use crate::pg_upgrade;
use postgresql_commands::pg_ctl::{Mode, PgCtlBuilder};
use postgresql_commands::psql::PsqlBuilder;
use postgresql_commands::traits::{AsyncCommandExecutor, CommandBuilder};
use postgresql_embedded::{PostgreSQL, Settings};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;

const DB_NAME: &str = "lifer";
const DB_USER: &str = "postgres";
// Every install before per-install passwords used this one. Only used to migrate those clusters.
const LEGACY_DB_PASSWORD: &str = "lifer-embedded";
// Per-install random password, 0600, next to postgres-data (never inside it: initdb needs that
// dir empty). scripts/headless-postgres.js reads the same file.
const PASSWORD_FILE: &str = "postgres-password";

// The base species/region catalog every install needs, on its own rolling GitHub Release.
// A --data-only, --disable-triggers pg_dump of build-catalog-seed.ts's CATALOG_TABLES. Never user data.
const CATALOG_SEED_URL: &str =
    "https://github.com/Sparklysparkspark/lifer-app/releases/download/catalog-latest/lifer-catalog-seed.sql.gz";
// Published next to the seed, with its sha256 (seed.sha256). fetch-catalog-seed.js bundles a
// copy next to the bundled seed.
const CATALOG_MANIFEST_URL: &str =
    "https://github.com/Sparklysparkspark/lifer-app/releases/download/catalog-latest/catalog-manifest.json";
const CATALOG_MANIFEST_FILE: &str = "catalog-manifest.json";

/// Builds this instance's own connection URL from its resolved settings (host/port are only
/// known for certain after start() resolves a dynamic port=0 to a real one).
pub fn connection_url(postgresql: &PostgreSQL) -> String {
    let s = postgresql.settings();
    format!(
        "postgres://{}:{}@{}:{}/{}",
        s.username, s.password, s.host, s.port, DB_NAME
    )
}

/// pg_ctl and the data dir, for the API sidecar's watchdog to stop Postgres if this app dies.
pub fn pg_ctl_and_data_dir(postgresql: &PostgreSQL) -> (PathBuf, PathBuf) {
    let settings = postgresql.settings();
    let exe = if cfg!(windows) {
        "pg_ctl.exe"
    } else {
        "pg_ctl"
    };
    (settings.binary_dir().join(exe), settings.data_dir.clone())
}

// A crash or force-quit leaves postmaster.pid behind, and pg_ctl then refuses to start. Only
// remove it when its pid is confirmed dead; a live instance is a real conflict and is left alone.
#[cfg(unix)]
pub(crate) fn clear_stale_lock_if_dead(data_dir: &Path) {
    let pid_file = data_dir.join("postmaster.pid");
    let Ok(contents) = std::fs::read_to_string(&pid_file) else {
        return;
    };
    let Some(pid) = contents
        .lines()
        .next()
        .and_then(|l| l.trim().parse::<i32>().ok())
    else {
        return;
    };
    let alive = std::process::Command::new("kill")
        .args(["-0", &pid.to_string()])
        .status()
        .map(|s| s.success())
        .unwrap_or(true); // can't tell, so assume alive and leave the lock
    if !alive {
        let _ = std::fs::remove_file(&pid_file);
    }
}
#[cfg(not(unix))]
pub(crate) fn clear_stale_lock_if_dead(_data_dir: &Path) {}

// Unix pid-reuse guard: only treat the lock's pid as ours if it's actually a postgres process.
#[cfg(unix)]
fn lock_pid_is_postgres(data_dir: &Path) -> bool {
    let Ok(contents) = std::fs::read_to_string(data_dir.join("postmaster.pid")) else {
        return false;
    };
    let Some(pid) = contents.lines().next().map(str::trim) else {
        return false;
    };
    std::process::Command::new("ps")
        .args(["-p", pid, "-o", "comm="])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).contains("postgres"))
        .unwrap_or(false)
}
#[cfg(not(unix))]
fn lock_pid_is_postgres(_data_dir: &Path) -> bool {
    // pg_ctl on Windows signals through a per-data-dir named event, not the pid, so a reused
    // pid can't be hit by the stop below.
    true
}

// A force-quit skips stop_api() and can leave the previous postmaster running on this data dir.
// If pg_ctl status confirms it, stop it (fast mode) so this launch can start its own.
async fn stop_orphaned_postgres(postgresql: &PostgreSQL) {
    let data_dir = postgresql.settings().data_dir.clone();
    if !data_dir.join("postmaster.pid").exists() || !lock_pid_is_postgres(&data_dir) {
        return;
    }
    let running = PgCtlBuilder::from(postgresql.settings())
        .mode(Mode::Status)
        .pgdata(&data_dir)
        .build_tokio()
        .execute(Some(Duration::from_secs(10)))
        .await
        .is_ok();
    if !running {
        return;
    }
    eprintln!("[embedded_db] stopping a postgres left running by a previous launch");
    match tokio::time::timeout(Duration::from_secs(30), postgresql.stop()).await {
        Ok(Ok(())) => {}
        Ok(Err(e)) => eprintln!("[embedded_db] couldn't stop the orphaned postgres: {e}"),
        Err(_) => eprintln!("[embedded_db] orphaned postgres didn't stop within 30s"),
    }
}

fn password_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("app-data").join(PASSWORD_FILE)
}

fn read_password(path: &Path) -> Option<String> {
    let value = std::fs::read_to_string(path).ok()?;
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_string())
}

// Hex keeps it safe to embed in a connection URL and a SQL literal without escaping.
fn generate_password() -> Result<String, String> {
    let mut bytes = [0u8; 24];
    getrandom::fill(&mut bytes)
        .map_err(|e| format!("Couldn't generate a database password: {e}"))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

pub(crate) fn write_secret_file(path: &Path, contents: &str) -> Result<(), String> {
    let err = |e: std::io::Error| format!("Couldn't save {}: {e}", path.display());
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(err)?;
    }
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path).map_err(err)?;
    // mode() only applies on create; tighten a file that already existed too.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    file.write_all(contents.as_bytes()).map_err(err)?;
    file.sync_all().map_err(err)
}

/// The PostgreSQL install bundled in the app's resources (resources/postgres, staged by
/// scripts/stage-postgres.js), if this build has one. A local macOS build made without
/// LIFER_POSTGRES_DIR, or `tauri dev` before prepare-resources, has none.
fn bundled_installation(resources: &Path) -> Option<PathBuf> {
    let dir = resources.join("postgres");
    let pg_ctl = if cfg!(windows) {
        "pg_ctl.exe"
    } else {
        "pg_ctl"
    };
    dir.join("bin").join(pg_ctl).is_file().then_some(dir)
}

fn settings_for(data_dir: &Path, password: &str, installation: Option<&Path>) -> Settings {
    let mut settings = Settings {
        data_dir: data_dir.to_path_buf(),
        username: DB_USER.to_string(),
        password: password.to_string(),
        // Persist across launches. A temporary instance deletes its data dir on stop().
        temporary: false,
        // Let the OS pick a free port; start() resolves it into settings().port.
        port: 0,
        ..Settings::default()
    };
    // Run the bundled server in place: setup() then skips its download entirely and only runs
    // initdb on a fresh data dir. Without one, the crate downloads the latest theseus-rs build
    // into ~/.theseus/postgresql, as every build did before the server was bundled.
    if let Some(dir) = installation {
        settings.installation_dir = dir.to_path_buf();
        settings.trust_installation_dir = true;
    }
    settings
}

// A previous instance can still be mid-shutdown when this one starts; retry briefly, re-checking
// for a now-dead stale lock each time. A real, persistent conflict still fails every attempt.
async fn start_with_retries(postgresql: &mut PostgreSQL) -> Result<(), String> {
    const START_RETRIES: u32 = 5;
    let mut last_err = String::new();
    for attempt in 0..START_RETRIES {
        if attempt > 0 {
            tokio::time::sleep(Duration::from_millis(750)).await;
            clear_stale_lock_if_dead(&postgresql.settings().data_dir);
        }
        match postgresql.start().await {
            Ok(()) => return Ok(()),
            Err(e) => last_err = e.to_string(),
        }
    }
    Err(format!(
        "Couldn't start the embedded database after {START_RETRIES} attempts: {last_err}"
    ))
}

// Runs one statement from a 0600 temp file, so the new password never shows up in `ps`.
async fn run_sql_as(
    postgresql: &PostgreSQL,
    password: &str,
    sql: &str,
    scratch_dir: &Path,
) -> Result<(), String> {
    let sql_path = scratch_dir.join(format!("rotate-password-{}.sql", std::process::id()));
    write_secret_file(&sql_path, sql)?;
    let result = PsqlBuilder::from(postgresql.settings())
        .dbname("postgres")
        .no_psqlrc()
        .pg_password(password)
        .file(&sql_path)
        .variable(("ON_ERROR_STOP", "1"))
        .quiet()
        .build_tokio()
        .execute(Some(Duration::from_secs(30)))
        .await
        .map(|_| ())
        .map_err(|e| e.to_string());
    let _ = std::fs::remove_file(&sql_path);
    result
}

// Moves a cluster created with LEGACY_DB_PASSWORD onto `new_password`. The new password sits in
// a .pending file until ALTER USER succeeds, so a crash in between is recoverable next launch.
async fn rotate_legacy_password(
    data_dir: &Path,
    installation: Option<&Path>,
    new_password: &str,
    scratch_dir: &Path,
) -> Result<(), String> {
    let mut postgresql = PostgreSQL::new(settings_for(data_dir, LEGACY_DB_PASSWORD, installation));
    postgresql
        .setup()
        .await
        .map_err(|e| format!("Couldn't set up the embedded database: {e}"))?;
    stop_orphaned_postgres(&postgresql).await;
    start_with_retries(&mut postgresql).await?;

    let alter = format!("ALTER USER {DB_USER} PASSWORD '{new_password}';");
    let result = match run_sql_as(&postgresql, LEGACY_DB_PASSWORD, &alter, scratch_dir).await {
        Ok(()) => Ok(()),
        // An earlier launch may have applied the pending password but crashed before saving it.
        Err(legacy_err) => run_sql_as(&postgresql, new_password, "SELECT 1;", scratch_dir)
            .await
            .map_err(|_| format!("Couldn't update the embedded database password: {legacy_err}")),
    };

    if tokio::time::timeout(Duration::from_secs(30), postgresql.stop())
        .await
        .is_err()
    {
        eprintln!("[embedded_db] postgres didn't stop within 30s after the password update");
    }
    result
}

// Every password an existing cluster may have, most likely first: this install's, one a crash
// left pending mid-rotation, and the legacy shared one. For pg_upgrade, which runs before
// resolve_password() can start the (old) server.
fn password_candidates(app_data_dir: &Path) -> Vec<String> {
    let path = password_path(app_data_dir);
    [
        read_password(&path),
        read_password(&path.with_extension("pending")),
    ]
    .into_iter()
    .flatten()
    .chain(std::iter::once(LEGACY_DB_PASSWORD.to_string()))
    .collect()
}

// The password this install's cluster uses, creating or migrating it on first run.
async fn resolve_password(
    app_data_dir: &Path,
    data_dir: &Path,
    installation: Option<&Path>,
) -> Result<String, String> {
    let path = password_path(app_data_dir);
    if let Some(password) = read_password(&path) {
        return Ok(password);
    }
    if !data_dir.join("PG_VERSION").exists() {
        // Fresh cluster: initdb will use this password directly.
        let password = generate_password()?;
        write_secret_file(&path, &password)?;
        return Ok(password);
    }
    let pending = path.with_extension("pending");
    let password = match read_password(&pending) {
        Some(p) => p,
        None => {
            let p = generate_password()?;
            write_secret_file(&pending, &p)?;
            p
        }
    };
    eprintln!(
        "[embedded_db] replacing the shared default database password with a per-install one"
    );
    rotate_legacy_password(
        data_dir,
        installation,
        &password,
        path.parent().unwrap_or(app_data_dir),
    )
    .await?;
    std::fs::rename(&pending, &path)
        .map_err(|e| format!("Couldn't save {}: {e}", path.display()))?;
    Ok(password)
}

/// Sets up (first run only) and starts embedded Postgres, creating the `lifer` database if needed.
/// Runs the server bundled in `resources` when there is one. Returns the instance (dropping it
/// shuts the server down) and its connection URL.
pub async fn start_embedded_postgres(
    app_data_dir: &Path,
    resources: &Path,
) -> Result<(PostgreSQL, String), String> {
    let data_dir = app_data_dir.join("app-data").join("postgres-data");
    let installation = bundled_installation(resources);
    match &installation {
        Some(dir) => eprintln!(
            "[embedded_db] using the bundled PostgreSQL in {}",
            dir.display()
        ),
        None => eprintln!(
            "[embedded_db] this build has no bundled PostgreSQL, so it uses a downloaded one"
        ),
    }
    // A data folder from an older PostgreSQL major (or an upgrade a crash interrupted) is dealt
    // with before anything else starts a server on it.
    pg_upgrade::prepare(
        app_data_dir,
        resources,
        installation.as_deref(),
        password_candidates(app_data_dir),
    )
    .await?;
    clear_stale_lock_if_dead(&data_dir);
    let password = resolve_password(app_data_dir, &data_dir, installation.as_deref()).await?;

    let mut postgresql =
        PostgreSQL::new(settings_for(&data_dir, &password, installation.as_deref()));
    postgresql
        .setup()
        .await
        .map_err(|e| format!("Couldn't set up the embedded database: {e}"))?;
    // After setup(), since pg_ctl's binary path is only known once setup has resolved it.
    stop_orphaned_postgres(&postgresql).await;

    start_with_retries(&mut postgresql).await?;

    let db_exists = postgresql
        .database_exists(DB_NAME)
        .await
        .map_err(|e| format!("Couldn't check for the lifer database: {e}"))?;
    if !db_exists {
        postgresql
            .create_database(DB_NAME)
            .await
            .map_err(|e| format!("Couldn't create the lifer database: {e}"))?;
    }

    // Just upgraded: confirmed (and the old copy offered for deletion) once the API answers.
    pg_upgrade::after_start(app_data_dir);

    let database_url = connection_url(&postgresql);
    Ok((postgresql, database_url))
}

fn psql(postgresql: &PostgreSQL) -> PsqlBuilder {
    PsqlBuilder::from(postgresql.settings())
        .dbname(DB_NAME)
        .no_psqlrc()
}

async fn species_table_is_empty(postgresql: &PostgreSQL) -> Result<bool, String> {
    let (stdout, _stderr) = psql(postgresql)
        .command("SELECT count(*) FROM species")
        .tuples_only()
        .no_align()
        .build_tokio()
        .execute(Some(Duration::from_secs(30)))
        .await
        .map_err(|e| format!("Couldn't check the species catalog: {e}"))?;
    Ok(stdout.trim().parse::<i64>().unwrap_or(0) == 0)
}

/// A fresh database has the schema but no species catalog. Restores it from the copy bundled at
/// build time (fetch-catalog-seed.js), downloading it only when that copy is missing (`tauri dev`).
pub async fn restore_catalog_seed_if_needed(
    postgresql: &PostgreSQL,
    resources: &Path,
) -> Result<(), String> {
    if !species_table_is_empty(postgresql).await? {
        return Ok(());
    }

    let bundled_path = resources
        .join("catalog-seed")
        .join("lifer-catalog-seed.sql.gz");
    let tmp_dir = std::env::temp_dir();
    let pid = std::process::id();
    let downloaded_gz = tmp_dir.join(format!("lifer-catalog-seed-{pid}.sql.gz"));
    let sql_path = tmp_dir.join(format!("lifer-catalog-seed-{pid}.sql"));

    let result = async {
        let gz_path = if bundled_path.exists() {
            // Checked against the manifest bundled next to it, like the server's bundled seed
            // (verifiedBundledSeed in apps/api). Without a manifest, or one from before seeds had
            // checksums, there's nothing to check it against.
            let manifest =
                std::fs::read_to_string(resources.join("catalog-seed").join(CATALOG_MANIFEST_FILE))
                    .ok();
            if let Some(expected) = manifest.as_deref().and_then(manifest_seed_sha256) {
                verify_seed(
                    bundled_path.clone(),
                    expected,
                    "The species catalog bundled with Lifer",
                )
                .await?;
            }
            bundled_path.clone()
        } else {
            download_seed(&downloaded_gz).await?;
            downloaded_gz.clone()
        };

        eprintln!(
            "[embedded_db] decompressing species catalog from {}",
            gz_path.display()
        );
        let (gz, sql) = (gz_path.clone(), sql_path.clone());
        let sql_bytes = tauri::async_runtime::spawn_blocking(move || decompress_to_file(&gz, &sql))
            .await
            .map_err(|e| format!("Couldn't decompress the species catalog: {e}"))??;
        eprintln!(
            "[embedded_db] loading species catalog ({} MB of SQL)",
            sql_bytes / 1_000_000
        );

        // No timeout: a slow disk must not abort first launch. ON_ERROR_STOP makes a bad statement
        // fail loudly instead of psql exiting 0 after single_transaction silently rolled back.
        let started = std::time::Instant::now();
        psql(postgresql)
            .file(&sql_path)
            .single_transaction()
            .variable(("ON_ERROR_STOP", "1"))
            .quiet()
            .build_tokio()
            .execute(None)
            .await
            .map_err(|e| format!("Couldn't load the species catalog: {e}"))?;
        eprintln!(
            "[embedded_db] species catalog loaded in {}s",
            started.elapsed().as_secs()
        );
        refresh_search_names(postgresql).await;
        Ok(())
    }
    .await;

    let _ = std::fs::remove_file(&sql_path);
    let _ = std::fs::remove_file(&downloaded_gz);
    result
}

// The seed restore disables triggers, so the species search table starts empty. Best effort: the
// API also rebuilds it at startup when empty. Skipped on schemas older than migration 111.
async fn refresh_search_names(postgresql: &PostgreSQL) {
    let sql = "DO $$ BEGIN IF to_regproc('refresh_species_search_names') IS NOT NULL THEN \
               PERFORM refresh_species_search_names(NULL); END IF; END $$;";
    let started = std::time::Instant::now();
    let result = psql(postgresql)
        .command(sql)
        .variable(("ON_ERROR_STOP", "1"))
        .quiet()
        .build_tokio()
        .execute(None)
        .await;
    match result {
        Ok(_) => eprintln!(
            "[embedded_db] species search names built in {}s",
            started.elapsed().as_secs()
        ),
        Err(e) => eprintln!(
            "[embedded_db] warning: couldn't build species search names, the API will retry: {e}"
        ),
    }
}

// The seed's sha256 from a catalog manifest ({ seed: { url, sha256, bytes }, ... }), or None for
// one from before seeds had checksums.
fn manifest_seed_sha256(manifest: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(manifest).ok()?;
    value["seed"]["sha256"]
        .as_str()
        .map(|s| s.trim().to_ascii_lowercase())
        .filter(|s| !s.is_empty())
}

// The seed's URL from a catalog manifest (relative to the manifest), else the fixed one.
fn manifest_seed_url(manifest: &str) -> String {
    serde_json::from_str::<serde_json::Value>(manifest)
        .ok()
        .and_then(|v| v["seed"]["url"].as_str().map(str::to_string))
        .and_then(|u| {
            url::Url::parse(CATALOG_MANIFEST_URL)
                .ok()?
                .join(&u)
                .ok()
                .map(|u| u.to_string())
        })
        .unwrap_or_else(|| CATALOG_SEED_URL.to_string())
}

fn sha256_file(path: &Path) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    use std::io::Read;
    let read_err = |e: std::io::Error| format!("Couldn't read {}: {e}", path.display());
    let mut file = std::fs::File::open(path).map_err(read_err)?;
    let mut hasher = Sha256::new();
    // sha2 0.11 hashers no longer implement io::Write, so the file is fed in chunks.
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = file.read(&mut buf).map_err(read_err)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect())
}

fn check_seed_sha256(path: &Path, expected: &str, label: &str) -> Result<(), String> {
    let actual = sha256_file(path)?;
    if actual == expected.to_ascii_lowercase() {
        return Ok(());
    }
    Err(format!(
        "{label} ({}) doesn't match the checksum in its manifest, so Lifer won't load it. \
         Reinstall Lifer, or update the catalog from Settings once Lifer is open. \
         (sha256 {actual}, expected {expected})",
        path.display()
    ))
}

// Off the async runtime: hashing ~200 MB takes a moment.
async fn verify_seed(path: PathBuf, expected: String, label: &'static str) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || check_seed_sha256(&path, &expected, label))
        .await
        .map_err(|e| format!("Couldn't check the species catalog: {e}"))?
}

// Streams gzip -> .sql on disk so neither side is ever held in memory. Returns SQL byte count.
fn decompress_to_file(gz_path: &Path, sql_path: &Path) -> Result<u64, String> {
    let input = std::fs::File::open(gz_path)
        .map_err(|e| format!("Couldn't read the species catalog: {e}"))?;
    let mut decoder = flate2::read::GzDecoder::new(std::io::BufReader::new(input));
    let output = std::fs::File::create(sql_path)
        .map_err(|e| format!("Couldn't stage the species catalog: {e}"))?;
    let mut writer = std::io::BufWriter::new(output);
    let bytes = std::io::copy(&mut decoder, &mut writer)
        .map_err(|e| format!("Couldn't decompress the species catalog: {e}"))?;
    writer
        .flush()
        .map_err(|e| format!("Couldn't stage the species catalog: {e}"))?;
    Ok(bytes)
}

// Live fallback (`tauri dev` without the bundled copy). Streams to disk and aborts on a 60s stall
// rather than capping the whole transfer. The manifest comes first, and the download is checked
// against its sha256 (the server's downloadSeed does the same).
async fn download_seed(dest: &Path) -> Result<(), String> {
    const STALL: Duration = Duration::from_secs(60);
    let err = |e: String| format!("Couldn't download the species catalog: {e}");
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| err(e.to_string()))?;
    let manifest = tokio::time::timeout(STALL, async {
        let response = client.get(CATALOG_MANIFEST_URL).send().await?;
        response.error_for_status()?.text().await
    })
    .await
    .map_err(|_| err("no response for the catalog manifest".into()))?
    .map_err(|e| err(format!("couldn't read the catalog manifest: {e}")))?;
    let expected = manifest_seed_sha256(&manifest);
    let seed_url = manifest_seed_url(&manifest);
    eprintln!("[embedded_db] downloading species catalog from {seed_url}");
    let mut response = tokio::time::timeout(STALL, client.get(&seed_url).send())
        .await
        .map_err(|_| err("no response from the server".into()))?
        .map_err(|e| err(e.to_string()))?;
    if !response.status().is_success() {
        return Err(err(format!("HTTP {}", response.status())));
    }
    let total = response.content_length();
    let mut file = std::fs::File::create(dest).map_err(|e| err(e.to_string()))?;
    let mut downloaded: u64 = 0;
    let mut last_logged: u64 = 0;
    loop {
        let chunk = tokio::time::timeout(STALL, response.chunk())
            .await
            .map_err(|_| err("the download stalled".into()))?
            .map_err(|e| err(e.to_string()))?;
        let Some(chunk) = chunk else { break };
        file.write_all(&chunk).map_err(|e| err(e.to_string()))?;
        downloaded += chunk.len() as u64;
        if downloaded - last_logged >= 10_000_000 {
            last_logged = downloaded;
            match total {
                Some(t) => eprintln!(
                    "[embedded_db] downloaded {} of {} MB",
                    downloaded / 1_000_000,
                    t / 1_000_000
                ),
                None => eprintln!("[embedded_db] downloaded {} MB", downloaded / 1_000_000),
            }
        }
    }
    file.flush().map_err(|e| err(e.to_string()))?;
    if let Some(t) = total {
        if downloaded != t {
            return Err(err(format!("got {downloaded} of {t} bytes")));
        }
    }
    drop(file);
    match expected {
        Some(expected) => {
            verify_seed(
                dest.to_path_buf(),
                expected,
                "The downloaded species catalog",
            )
            .await
        }
        None => {
            eprintln!("[embedded_db] the catalog manifest has no checksum (an older one), so the download isn't checked");
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha256_file_matches_the_standard_digest_across_chunks() {
        use sha2::{Digest, Sha256};
        let dir = std::env::temp_dir().join(format!("lifer-sha256-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let small = dir.join("abc");
        std::fs::write(&small, b"abc").unwrap();
        assert_eq!(
            sha256_file(&small).unwrap(),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        // Larger than the read buffer, so several chunks are hashed.
        let large = dir.join("large");
        let bytes: Vec<u8> = (0..(5 << 20) + 7).map(|i| (i % 251) as u8).collect();
        std::fs::write(&large, &bytes).unwrap();
        let expected: String = Sha256::digest(&bytes)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        assert_eq!(sha256_file(&large).unwrap(), expected);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn catalog_seed_is_checked_against_its_manifest() {
        let dir = std::env::temp_dir().join(format!("lifer-seed-check-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let seed = dir.join("lifer-catalog-seed.sql.gz");
        std::fs::write(&seed, b"seed bytes").unwrap();
        let real = sha256_file(&seed).unwrap();

        let manifest = format!(
            r#"{{"version": 7, "seed": {{"url": "lifer-catalog-seed.sql.gz", "sha256": "{}"}}}}"#,
            real.to_uppercase()
        );
        let expected = manifest_seed_sha256(&manifest).unwrap();
        assert_eq!(expected, real);
        assert!(check_seed_sha256(&seed, &expected, "The seed").is_ok());
        assert_eq!(
            manifest_seed_url(&manifest),
            "https://github.com/Sparklysparkspark/lifer-app/releases/download/catalog-latest/lifer-catalog-seed.sql.gz"
        );

        std::fs::write(&seed, b"tampered seed").unwrap();
        let err = check_seed_sha256(&seed, &expected, "The seed").unwrap_err();
        assert!(err.contains("doesn't match the checksum"), "{err}");
        assert!(check_seed_sha256(&seed, &"0".repeat(64), "The seed").is_err());

        // An older manifest without a checksum, or none at all: nothing to check against.
        assert_eq!(manifest_seed_sha256(r#"{"version": 7}"#), None);
        assert_eq!(manifest_seed_sha256("not json"), None);
        assert_eq!(manifest_seed_url(r#"{"version": 7}"#), CATALOG_SEED_URL);
        let _ = std::fs::remove_dir_all(&dir);
    }

    // Starts the bundled server the way the app does (setup, initdb on first launch, start,
    // create the lifer database), twice on one data dir. Needs the staged server, so run it after
    // `npm run prepare-resources` (with LIFER_POSTGRES_DIR on macOS):
    //   cargo test --lib bundled_postgres -- --ignored
    #[test]
    #[ignore = "needs resources-staging/postgres from npm run prepare-resources"]
    fn bundled_postgres_starts_and_reopens() {
        let resources = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources-staging");
        let installation =
            bundled_installation(&resources).expect("no staged PostgreSQL in resources-staging");
        let app_data_dir =
            std::env::temp_dir().join(format!("lifer-embedded-db-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&app_data_dir);

        tauri::async_runtime::block_on(async {
            let (first, url) = start_embedded_postgres(&app_data_dir, &resources)
                .await
                .expect("first launch");
            assert_eq!(first.settings().installation_dir, installation);
            assert!(first.database_exists(DB_NAME).await.unwrap());
            first.stop().await.expect("stop");

            // Second launch: same data dir, same per-install password, nothing to set up.
            let (second, second_url) = start_embedded_postgres(&app_data_dir, &resources)
                .await
                .expect("second launch");
            let without_port = |u: &str| u.rsplit_once(':').map(|(a, _)| a.to_string());
            assert_eq!(without_port(&url), without_port(&second_url));
            assert!(second.database_exists(DB_NAME).await.unwrap());
            second.stop().await.expect("stop");
        });
        let _ = std::fs::remove_dir_all(&app_data_dir);
    }
}
