import path from "node:path";
import { describe, expect, it } from "vitest";
import { choosePgDump, dockerContainerForPort, type PgDumpInputs } from "./pgDump.js";

const EXE = process.platform === "win32" ? ".exe" : "";
const inputs = (over: Partial<PgDumpInputs> = {}): PgDumpInputs => ({
  env: {},
  databaseUrl: "postgres://lifer:secret@localhost:5433/lifer",
  exists: () => false,
  dockerContainers: () => ["lifer-db-1\t0.0.0.0:5433->5432/tcp, [::]:5433->5432/tcp"],
  bundledDirs: ["/desktop/postgres"],
  ...over,
});

describe("choosePgDump", () => {
  it("prefers PG_DUMP_BIN", () => {
    const chosen = choosePgDump(inputs({ env: { PG_DUMP_BIN: "/opt/pg18/bin/pg_dump" }, exists: () => true }));
    expect(chosen).toMatchObject({ command: "/opt/pg18/bin/pg_dump", prefixArgs: [], source: "PG_DUMP_BIN" });
  });

  it("then a desktop build's bundled pg_dump", () => {
    const bin = path.join("/desktop/postgres", "bin", `pg_dump${EXE}`);
    const chosen = choosePgDump(inputs({ exists: (f) => f === bin }));
    expect(chosen).toMatchObject({ command: bin, source: "desktop build" });
  });

  it("then the Docker container publishing DATABASE_URL's port, connecting to its own 5432", () => {
    const chosen = choosePgDump(inputs());
    expect(chosen.command).toBe("docker");
    expect(chosen.prefixArgs).toEqual(["exec", "-i", "lifer-db-1", "pg_dump"]);
    expect(chosen.databaseUrl).toBe("postgres://lifer:secret@localhost:5432/lifer");
  });

  it("falls back to PATH for a remote database, an unpublished port or no Docker", () => {
    expect(choosePgDump(inputs({ databaseUrl: "postgres://u:p@db.example.org:5433/lifer" })).source).toBe("PATH");
    expect(choosePgDump(inputs({ databaseUrl: "postgres://u:p@localhost:6000/lifer" })).source).toBe("PATH");
    expect(choosePgDump(inputs({ dockerContainers: () => null })).command).toBe(`pg_dump${EXE}`);
  });
});

describe("dockerContainerForPort", () => {
  it("matches only a mapping to the container's 5432", () => {
    const rows = ["web\t0.0.0.0:5433->8080/tcp", "db\t127.0.0.1:5433->5432/tcp"];
    expect(dockerContainerForPort(rows, "5433")).toBe("db");
    expect(dockerContainerForPort(rows, "5432")).toBeNull();
  });
});
