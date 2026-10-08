import { describe, expect, it } from "vitest";
import {
  checkDataReleaseFlags,
  checkDisk,
  checkEnv,
  checkMemory,
  checkMigrations,
  checkNodeVersion,
  checkPgDump,
  checkPostgis,
  checkShm,
  formatBytes,
  formatReport,
  GIB,
  parsePgDumpMajor,
  redactDatabaseUrl,
  type EnvRule,
} from "./doctorChecks.js";

describe("formatReport", () => {
  it("prints one line per check, a fix only for warnings and failures, and a summary", () => {
    const { text, exitCode } = formatReport([
      { name: "Node.js", status: "pass", detail: "v22.1.0", fix: "never shown" },
      {
        name: "PostGIS extension",
        status: "fail",
        detail: "available but not created",
        fix: "CREATE EXTENSION postgis;",
      },
      { name: "Cache: eBird lists", status: "warn", detail: "empty", fix: "run the refresh" },
      { name: "Shm", status: "skip", detail: "not in Docker" },
    ]);
    expect(text.split("\n")).toEqual([
      "PASS  Node.js: v22.1.0",
      "FAIL  PostGIS extension: available but not created",
      "      fix: CREATE EXTENSION postgis;",
      "WARN  Cache: eBird lists: empty",
      "      fix: run the refresh",
      "SKIP  Shm: not in Docker",
      "",
      "1 passed, 1 warning(s), 1 failed, 1 skipped",
    ]);
    expect(exitCode).toBe(1);
  });

  it("exits 0 when nothing failed, warnings included", () => {
    expect(formatReport([{ name: "a", status: "warn", detail: "" }]).exitCode).toBe(0);
    expect(formatReport([]).exitCode).toBe(0);
  });
});

describe("checkEnv", () => {
  const rules: EnvRule[] = [
    { name: "SECRET", need: "required", secret: true, purpose: "a password" },
    { name: "KEY", need: "recommended", secret: true, purpose: "an API key" },
    {
      name: "DAYS",
      need: "optional",
      secret: false,
      purpose: "days",
      validate: (v) => (Number(v) > 0 ? null : "must be a positive number"),
    },
    {
      name: "DEV",
      need: "optional",
      secret: false,
      purpose: "dev only",
      caution: (v, { publish }) => (v && publish ? "not for publishing" : null),
    },
  ];

  it("fails a missing required variable, warns on a missing recommended one, passes a missing optional one", () => {
    const [secret, key, days, dev] = checkEnv({}, { publish: false }, rules);
    expect(secret.status).toBe("fail");
    expect(key.status).toBe("warn");
    expect(days.status).toBe("pass");
    expect(dev.status).toBe("pass");
  });

  it("treats a blank value as unset", () => {
    expect(checkEnv({ SECRET: "  " }, { publish: false }, rules)[0].status).toBe("fail");
  });

  it("never prints a secret's value, and shows other values", () => {
    const results = checkEnv({ SECRET: "hunter2", KEY: "abc123", DAYS: "30" }, { publish: false }, rules);
    const printed = formatReport(results).text;
    expect(printed).not.toContain("hunter2");
    expect(printed).not.toContain("abc123");
    expect(results[0]).toMatchObject({ status: "pass", detail: "set" });
    expect(results[2]).toMatchObject({ status: "pass", detail: "set to 30" });
  });

  it("fails a value its rule rejects", () => {
    expect(checkEnv({ DAYS: "soon" }, { publish: false }, rules)[2]).toMatchObject({
      status: "fail",
      detail: "set to soon, but must be a positive number",
    });
  });

  it("warns on a risky value only where the rule says so", () => {
    expect(checkEnv({ DEV: "1" }, { publish: false }, rules)[3].status).toBe("pass");
    expect(checkEnv({ DEV: "1" }, { publish: true }, rules)[3].status).toBe("warn");
  });

  it("checks the real rules: DATABASE_URL must be a postgres URL, GBIF credentials are required", () => {
    const byName = (env: Record<string, string>) =>
      Object.fromEntries(checkEnv(env, { publish: false }).map((r) => [r.name, r]));
    expect(byName({ DATABASE_URL: "mysql://x" })["env DATABASE_URL"].status).toBe("fail");
    expect(byName({ DATABASE_URL: "postgres://lifer:pw@127.0.0.1:55510/lifer" })["env DATABASE_URL"]).toMatchObject({
      status: "pass",
      detail: "set",
    });
    expect(byName({})["env GBIF_USER"].status).toBe("fail");
    expect(byName({})["env GBIF_PWD"].status).toBe("fail");
    expect(byName({})["env EBIRD_API_KEY"].status).toBe("warn");
    expect(byName({ PHOTO_STORE_FROM_SCRATCH: "yes" })["env PHOTO_STORE_FROM_SCRATCH"].status).toBe("fail");
  });
});

describe("redactDatabaseUrl", () => {
  it("hides the password and keeps the rest", () => {
    expect(redactDatabaseUrl("postgres://lifer:s3cret@127.0.0.1:55510/lifer")).toBe(
      "postgres://lifer:***@127.0.0.1:55510/lifer",
    );
    expect(redactDatabaseUrl("postgres://localhost/lifer")).toBe("postgres://localhost/lifer");
    expect(redactDatabaseUrl("not a url")).toBe("(not a valid URL)");
  });
});

describe("machine and tool checks", () => {
  it("needs Node 22 or newer", () => {
    expect(checkNodeVersion("v22.12.0").status).toBe("pass");
    expect(checkNodeVersion("v20.18.0").status).toBe("fail");
    expect(checkNodeVersion("garbage").status).toBe("fail");
  });

  it("reads pg_dump's major version", () => {
    expect(parsePgDumpMajor("pg_dump (PostgreSQL) 18.6")).toBe(18);
    expect(parsePgDumpMajor("pg_dump (PostgreSQL) 16.4 (Homebrew)")).toBe(16);
    expect(parsePgDumpMajor("command not found")).toBeNull();
  });

  it("wants pg_dump 18, never older than the server, and only fails without it when publishing", () => {
    expect(checkPgDump(18, 18, true).status).toBe("pass");
    expect(checkPgDump(16, 18, true).status).toBe("fail");
    expect(checkPgDump(16, 18, false).status).toBe("warn");
    expect(checkPgDump(17, 16, true).status).toBe("warn");
    expect(checkPgDump(null, 18, true).status).toBe("fail");
    expect(checkPgDump(null, 18, false).status).toBe("warn");
  });

  it("warns on Docker's default 64 MB of shared memory, skips when it can't tell", () => {
    expect(checkShm(64 * 1024 ** 2, "pg").status).toBe("warn");
    expect(checkShm(256 * 1024 ** 2, "pg").status).toBe("pass");
    expect(checkShm(null, null).status).toBe("skip");
  });

  it("recommends 24 GB of RAM", () => {
    expect(checkMemory(24 * GIB).status).toBe("pass");
    expect(checkMemory(16 * GIB).status).toBe("warn");
  });

  it("formats sizes", () => {
    expect(formatBytes(64 * 1024 ** 2)).toBe("64 MB");
    expect(formatBytes(1.5 * GIB)).toBe("1.5 GB");
    expect(formatBytes(512 * 1024)).toBe("512 KB");
  });
});

describe("database checks", () => {
  it("fails an unmigrated or behind database", () => {
    expect(checkMigrations(["001_a.sql", "002_b.sql"], null).status).toBe("fail");
    expect(checkMigrations(["001_a.sql", "002_b.sql"], ["001_a.sql"])).toMatchObject({
      status: "fail",
      detail: "1 pending (first: 002_b.sql)",
    });
    expect(checkMigrations(["001_a.sql"], ["001_a.sql"]).status).toBe("pass");
  });

  it("tells PostGIS not created apart from not available", () => {
    expect(checkPostgis(true, true).status).toBe("pass");
    expect(checkPostgis(false, true).fix).toContain("CREATE EXTENSION postgis");
    expect(checkPostgis(false, false).fix).toContain("docker-compose.dev.yml");
  });
});

describe("checkDisk", () => {
  it("counts only what each cache still has to grow by, plus 10%", () => {
    const caches = [
      { name: "a", budget: 100 * GIB, present: 90 * GIB },
      { name: "b", budget: 10 * GIB, present: 20 * GIB },
    ];
    // 10 GB still needed (b is already over budget), 11 GB with headroom.
    expect(checkDisk("/data", 11.5 * GIB, caches).status).toBe("pass");
    expect(checkDisk("/data", 10.5 * GIB, caches).status).toBe("fail");
  });
});

describe("checkDataReleaseFlags", () => {
  const release = (tagName: string, isPrerelease: boolean, isLatest = false) => ({ tagName, isPrerelease, isLatest });

  it("passes when every data release is a prerelease, whatever the app releases are", () => {
    const result = checkDataReleaseFlags([
      release("v0.10.1", false, true),
      release("catalog-latest", true),
      release("map-latest", true),
    ]);
    expect(result.status).toBe("pass");
  });

  it("fails on a data release that's a full release or marked Latest, with the command to fix each", () => {
    const result = checkDataReleaseFlags([
      release("v0.10.1", false),
      release("photos-latest", false),
      release("packs-latest", true, true),
    ]);
    expect(result.status).toBe("fail");
    expect(result.detail).toBe("not a prerelease, or marked Latest: photos-latest, packs-latest");
    expect(result.fix).toBe(
      "gh release edit photos-latest --prerelease --latest=false; gh release edit packs-latest --prerelease --latest=false",
    );
  });

  it("skips when gh can't list releases", () => {
    expect(checkDataReleaseFlags(null).status).toBe("skip");
  });
});
