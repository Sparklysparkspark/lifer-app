#!/usr/bin/env node
// Prints the DATABASE_URL to connect with. One still on the compose file's default password gets
// a generated one instead, kept in the app-data volume, so a server never needs a password set by
// hand. A database that still has the default (an existing install, or a restore into a fresh
// volume) is moved onto the generated password here.
import { randomBytes } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";

const DEFAULT_PASSWORD = "lifer";
const AUTH_FAILED = "28P01";

function writeSecret(file, value) {
  mkdirSync(join(file, ".."), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, value, { mode: 0o600, flush: true });
  renameSync(tmp, file);
  const dir = openSync(join(file, ".."), "r");
  try {
    fsyncSync(dir);
  } finally {
    closeSync(dir);
  }
}

function readOrCreateSecret(file) {
  try {
    const stored = readFileSync(file, "utf8").trim();
    if (stored) return stored;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const generated = randomBytes(24).toString("hex");
  // Saved before the database changes, so a crash in between never loses the password.
  writeSecret(file, generated);
  return generated;
}

function withPassword(url, password) {
  const next = new URL(url);
  next.password = encodeURIComponent(password);
  return next.href;
}

// Returns a connected client, or null when the password is wrong.
async function connect(url) {
  const client = new pg.Client({ connectionString: url });
  try {
    await client.connect();
    return client;
  } catch (error) {
    await client.end().catch(() => {});
    if (error.code === AUTH_FAILED) return null;
    throw error;
  }
}

async function resolve() {
  const url = process.env.DATABASE_URL;
  if (!url || decodeURIComponent(new URL(url).password) !== DEFAULT_PASSWORD) return url ?? "";

  const secret = readOrCreateSecret(join(process.env.APP_DATA_DIR || "/app-data", "secrets", "db-password"));
  const target = withPassword(url, secret);
  const current = await connect(target);
  if (current) {
    await current.end();
    return target;
  }
  const onDefault = await connect(url);
  if (!onDefault) {
    throw new Error(
      "The database password matches neither the saved one nor the default. See the Docker install docs, Database password.",
    );
  }
  try {
    await onDefault.query(`ALTER ROLE CURRENT_USER PASSWORD ${onDefault.escapeLiteral(secret)}`);
  } finally {
    await onDefault.end();
  }
  console.error("[db-password] Moved the database onto a generated password.");
  return target;
}

resolve().then(
  (url) => process.stdout.write(url),
  (error) => {
    console.error(`[db-password] ${error.message}`);
    process.exit(1);
  },
);
