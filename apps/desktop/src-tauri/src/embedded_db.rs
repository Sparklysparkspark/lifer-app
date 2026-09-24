// Embeds a real Postgres server as a managed sidecar, the Tauri equivalent of api.rs's own
// Node sidecar management. This is what actually removes the desktop app's last manual-setup
// requirement — previously "local/offline mode" needed a separately-running Postgres (either a
// docker-compose service or a system install the user set up themselves).
//
// No PostGIS: despite docker-compose.yml using a postgis/postgis image (kept for the server
// path), the schema never actually calls any PostGIS function — see migrations/
// 001_phase1_species.sql's own comment on gbif_area_wkt ("confirmed dead/unused... plain text,
// no PostGIS dependency needed"). All bbox/geometry logic lives in plain TS (data-pipeline's
// geometry.ts). That's what makes embedding *plain* Postgres (well-supported prebuilt binaries
// for every OS, via the theseus release archives postgresql_embedded downloads and caches
// under ~/.theseus/postgresql) viable at all — bundling PostGIS's native GEOS/PROJ/GDAL
// dependencies portably across three OSes would have been a much harder problem.
use postgresql_commands::pg_ctl::{Mode, PgCtlBuilder};
use postgresql_commands::psql::PsqlBuilder;
use postgresql_commands::traits::{AsyncCommandExecutor, CommandBuilder};
use postgresql_embedded::{PostgreSQL, Settings};
use std::io::Write;
use std::path::Path;
use std::time::Duration;

const DB_NAME: &str = "lifer";
const DB_USER: &str = "postgres";
// Fixed rather than Settings::new()'s randomly-generated default: the data directory persists
// across launches (temporary: false, below), so a different random password every start would
// no longer match what initdb actually wrote into the cluster the first time it ran.
const DB_PASSWORD: &str = "lifer-embedded";

// Hosted separately from packs-latest (see offlinePacks — those are optional, per-region
// reference photos matched against species that must already exist locally) since this is the
// base species/region taxonomy catalog every install needs before ANY of that makes sense.
// Same "one dedicated, rolling GitHub Release" shape as PACK_INDEX_URL/MAP_DOWNLOAD_URL.
// Content is a --data-only, --disable-triggers pg_dump of the catalog tables listed in
// packages/data-pipeline's build-catalog-seed.ts CATALOG_TABLES. Never user data. Gallery
// embeddings are a separate asset the API downloads with the CLIP model, not part of this file.
const CATALOG_SEED_URL: &str =
    "https://github.com/Sparklysparkspark/lifer-app/releases/download/catalog-latest/lifer-catalog-seed.sql.gz";

/// Builds this instance's own connection URL from its resolved settings (host/port are only
/// known for certain after start() resolves a dynamic port=0 to a real one).
pub fn connection_url(postgresql: &PostgreSQL) -> String {
    let s = postgresql.settings();
    format!("postgres://{}:{}@{}:{}/{}", s.username, s.password, s.host, s.port, DB_NAME)
}

// A previous run that ended ungracefully (force-quit, crash, or this app being killed via
// `kill -9`/Activity Monitor rather than Quit — every one of which skips the
// RunEvent::Exit handler that normally calls stop_api()'s graceful postgresql.stop()) leaves
// postmaster.pid behind with a pid that's no longer running. pg_ctl then refuses to start
// ("another server might be running" / "could not start server") even though nothing actually
// holds the data directory anymore. Only clears the file when that pid is confirmed dead — a
// genuinely live instance (a real conflict) is left alone, and start() will surface its own
// clear error in that rarer case rather than this silently killing something still in use.
#[cfg(unix)]
fn clear_stale_lock_if_dead(data_dir: &Path) {
    let pid_file = data_dir.join("postmaster.pid");
    let Ok(contents) = std::fs::read_to_string(&pid_file) else { return };
    let Some(pid) = contents.lines().next().and_then(|l| l.trim().parse::<i32>().ok()) else { return };
    let alive = std::process::Command::new("kill")
        .args(["-0", &pid.to_string()])
        .status()
        .map(|s| s.success())
        .unwrap_or(true); // can't tell — assume alive, don't touch the lock
    if !alive {
        let _ = std::fs::remove_file(&pid_file);
    }
}
#[cfg(not(unix))]
fn clear_stale_lock_if_dead(_data_dir: &Path) {}

// Unix pid-reuse guard: only treat the lock's pid as ours if it's actually a postgres process.
#[cfg(unix)]
fn lock_pid_is_postgres(data_dir: &Path) -> bool {
    let Ok(contents) = std::fs::read_to_string(data_dir.join("postmaster.pid")) else { return false };
    let Some(pid) = contents.lines().next().map(str::trim) else { return false };
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

// A force-quit skips stop_api(), leaving the previous launch's postmaster running on this data
// dir and blocking start(). pg_ctl status checks the lock's pid is alive for this exact data dir;
// if so, stop it (fast mode) so this launch can start its own instance normally.
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

/// Sets up (first run only) and starts an embedded Postgres instance rooted under this
/// install's own app data dir, creating the `lifer` database if it doesn't exist yet. Returns
/// the running instance (kept alive for the app's lifetime — dropping/stopping it shuts the
/// server down) and its connection URL.
pub async fn start_embedded_postgres(app_data_dir: &Path) -> Result<(PostgreSQL, String), String> {
    let data_dir = app_data_dir.join("app-data").join("postgres-data");
    clear_stale_lock_if_dead(&data_dir);

    let settings = Settings {
        data_dir,
        username: DB_USER.to_string(),
        password: DB_PASSWORD.to_string(),
        // Persist across launches — the whole point is a self-contained library that survives
        // quitting and reopening the app, not a scratch database. See postgresql_embedded's
        // stop(): a temporary instance's data directory is deleted on stop(), which a graceful
        // app-exit path would otherwise hit every single time.
        temporary: false,
        // Let the OS pick a free port instead of assuming 5432 is free — a real system
        // Postgres (or another instance of this same app) may already be listening there.
        // Resolved back into `postgresql.settings().port` once start() returns.
        port: 0,
        ..Settings::default()
    };

    let mut postgresql = PostgreSQL::new(settings);
    postgresql
        .setup()
        .await
        .map_err(|e| format!("Couldn't set up the embedded database: {e}"))?;
    // After setup(), since pg_ctl's binary path is only known once setup has resolved it.
    stop_orphaned_postgres(&postgresql).await;

    // A previous instance (this same app relaunched quickly, or a stale process from a prior
    // crash) can still be mid-shutdown at the exact moment this one tries to start — genuinely
    // alive (so clear_stale_lock_if_dead above correctly leaves its lock alone), but only for
    // another few hundred ms while it finishes its own checkpoint/cleanup. Previously that
    // window surfaced as a hard, unrecoverable "Couldn't start the embedded database" error
    // with no retry at all. Retrying with a short backoff — re-checking for a now-actually-dead
    // stale lock before each attempt — absorbs exactly that transient window without masking a
    // REAL, persistent conflict (a genuinely different live Postgres holding the data
    // directory), which will still fail every retry and surface its own error same as before.
    const START_RETRIES: u32 = 5;
    let mut last_err = String::new();
    let mut started = false;
    for attempt in 0..START_RETRIES {
        if attempt > 0 {
            tokio::time::sleep(Duration::from_millis(750)).await;
            clear_stale_lock_if_dead(&postgresql.settings().data_dir);
        }
        match postgresql.start().await {
            Ok(()) => {
                started = true;
                break;
            }
            Err(e) => last_err = e.to_string(),
        }
    }
    if !started {
        return Err(format!("Couldn't start the embedded database after {START_RETRIES} attempts: {last_err}"));
    }

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

    let database_url = connection_url(&postgresql);
    Ok((postgresql, database_url))
}

fn psql(postgresql: &PostgreSQL) -> PsqlBuilder {
    PsqlBuilder::from(postgresql.settings()).dbname(DB_NAME).no_psqlrc()
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

/// A fresh embedded database has the right SCHEMA (from run_migrations) but none of the base
/// species/region taxonomy — that's a separate one-time "seed" dataset (packages/data-pipeline's
/// build-seed.ts + load-seed.ts, normally run once by hand against a long-lived dev database),
/// never packaged for a fresh install before. Detects an empty catalog and restores it — from
/// the copy bundled into the installer at build time (see apps/desktop/scripts/
/// fetch-catalog-seed.js) so a fresh install works fully offline with no wait at all; only
/// falls back to downloading it live if that bundled copy is missing (`tauri dev` without
/// having run that script).
pub async fn restore_catalog_seed_if_needed(postgresql: &PostgreSQL, resources: &Path) -> Result<(), String> {
    if !species_table_is_empty(postgresql).await? {
        return Ok(());
    }

    let bundled_path = resources.join("catalog-seed").join("lifer-catalog-seed.sql.gz");
    let tmp_dir = std::env::temp_dir();
    let pid = std::process::id();
    let downloaded_gz = tmp_dir.join(format!("lifer-catalog-seed-{pid}.sql.gz"));
    let sql_path = tmp_dir.join(format!("lifer-catalog-seed-{pid}.sql"));

    let result = async {
        let gz_path = if bundled_path.exists() {
            bundled_path.clone()
        } else {
            download_seed(&downloaded_gz).await?;
            downloaded_gz.clone()
        };

        eprintln!("[embedded_db] decompressing species catalog from {}", gz_path.display());
        let (gz, sql) = (gz_path.clone(), sql_path.clone());
        let sql_bytes = tauri::async_runtime::spawn_blocking(move || decompress_to_file(&gz, &sql))
            .await
            .map_err(|e| format!("Couldn't decompress the species catalog: {e}"))??;
        eprintln!("[embedded_db] loading species catalog ({} MB of SQL)", sql_bytes / 1_000_000);

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
        eprintln!("[embedded_db] species catalog loaded in {}s", started.elapsed().as_secs());
        Ok(())
    }
    .await;

    let _ = std::fs::remove_file(&sql_path);
    let _ = std::fs::remove_file(&downloaded_gz);
    result
}

// Streams gzip -> .sql on disk so neither side is ever held in memory. Returns SQL byte count.
fn decompress_to_file(gz_path: &Path, sql_path: &Path) -> Result<u64, String> {
    let input = std::fs::File::open(gz_path).map_err(|e| format!("Couldn't read the species catalog: {e}"))?;
    let mut decoder = flate2::read::GzDecoder::new(std::io::BufReader::new(input));
    let output = std::fs::File::create(sql_path).map_err(|e| format!("Couldn't stage the species catalog: {e}"))?;
    let mut writer = std::io::BufWriter::new(output);
    let bytes = std::io::copy(&mut decoder, &mut writer).map_err(|e| format!("Couldn't decompress the species catalog: {e}"))?;
    writer.flush().map_err(|e| format!("Couldn't stage the species catalog: {e}"))?;
    Ok(bytes)
}

// Live fallback (`tauri dev` without the bundled copy). Streams to disk and aborts on a 60s stall
// rather than capping the whole transfer.
async fn download_seed(dest: &Path) -> Result<(), String> {
    const STALL: Duration = Duration::from_secs(60);
    let err = |e: String| format!("Couldn't download the species catalog: {e}");
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| err(e.to_string()))?;
    eprintln!("[embedded_db] downloading species catalog from {CATALOG_SEED_URL}");
    let mut response = tokio::time::timeout(STALL, client.get(CATALOG_SEED_URL).send())
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
                Some(t) => eprintln!("[embedded_db] downloaded {} of {} MB", downloaded / 1_000_000, t / 1_000_000),
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
    Ok(())
}
