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
use postgresql_commands::psql::PsqlBuilder;
use postgresql_commands::traits::{AsyncCommandExecutor, CommandBuilder};
use postgresql_embedded::{PostgreSQL, Settings};
use std::io::Read;
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
// Content is a --data-only, --disable-triggers pg_dump of just the catalog tables (species,
// species_rarity, species_reference_photos, species_traits, regions, region_species,
// sea_zones, sea_zone_species) — never user data (captures/photos/users/etc.), and never the
// PostGIS-dependent tiger/spatial_ref_sys tables the dev Postgres happens to also have, since
// the embedded instance has no PostGIS extension installed (see this file's top comment).
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
    let gz_bytes = if bundled_path.exists() {
        std::fs::read(&bundled_path).map_err(|e| format!("Couldn't read the bundled species catalog: {e}"))?
    } else {
        let response = reqwest::get(CATALOG_SEED_URL)
            .await
            .map_err(|e| format!("Couldn't download the species catalog: {e}"))?;
        if !response.status().is_success() {
            return Err(format!("Couldn't download the species catalog: HTTP {}", response.status()));
        }
        response
            .bytes()
            .await
            .map_err(|e| format!("Couldn't download the species catalog: {e}"))?
            .to_vec()
    };

    let mut decoder = flate2::read::GzDecoder::new(&gz_bytes[..]);
    let mut sql = String::new();
    decoder
        .read_to_string(&mut sql)
        .map_err(|e| format!("Couldn't decompress the species catalog: {e}"))?;

    let tmp_path = std::env::temp_dir().join(format!("lifer-catalog-seed-{}.sql", std::process::id()));
    std::fs::write(&tmp_path, &sql).map_err(|e| format!("Couldn't stage the species catalog: {e}"))?;

    let result = psql(postgresql)
        .file(&tmp_path)
        .single_transaction()
        .build_tokio()
        .execute(Some(Duration::from_secs(300)))
        .await
        .map_err(|e| format!("Couldn't load the species catalog: {e}"));
    let _ = std::fs::remove_file(&tmp_path);
    result.map(|_| ())
}
