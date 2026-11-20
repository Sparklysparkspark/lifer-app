// Crash reports: written locally when Lifer crashes, sent only when the user clicks Send.
// A report holds the crash details and nothing else: every path, file name, name in quotes, key,
// email, address and coordinate is stripped before it's saved, and again before it's shown or sent.
import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { APP_DATA_DIR, APP_VERSION } from "@lifer/core/config.js";
import { writeFileAtomicSync } from "../lib/atomicWrite.js";

export const CRASH_REPORT_URL = "https://reports.liferwildlife.com/v1/crash";
export const CRASH_DIR = path.join(APP_DATA_DIR, "crash-reports");
const KEEP = 10;
const MAX_MESSAGE = 4_000;
const MAX_STACK = 64_000;
export const MAX_NOTE = 4_000;
const SEND_TIMEOUT_MS = 10_000;

/** Packagers who ship Lifer without crash reporting set LIFER_CRASH_REPORTS=off. */
export const crashReportsEnabled = (): boolean => process.env.LIFER_CRASH_REPORTS?.trim().toLowerCase() !== "off";

/** desktop-panic and server-exception quit the app; the others are errors it survived. */
export const CRASH_KINDS = ["desktop-panic", "server-exception", "server-rejection", "web-error"] as const;
export type CrashKind = (typeof CRASH_KINDS)[number];

export interface CrashReport {
  app: "lifer";
  version: string;
  os: string;
  arch: string;
  kind: CrashKind;
  message: string;
  stack: string;
  timestamp: string;
}

const SOURCE_FILE = /\.(?:[cm]?[jt]sx?|rs)$/i;
// Up to three words before the extension, since photo names often have spaces ("Owl at dusk.jpg").
const MEDIA_FILE =
  /(?:[\w().,+-]+ ){0,3}[\w().,+-]+\.(?:jpe?g|png|gif|webp|avif|heic|heif|tiff?|bmp|dng|cr2|cr3|crw|nef|nrw|arw|srf|sr2|raf|orf|rw2|pef|srw|x3f|3fr|iiq|psd|xmp|mov|mp4|m4v|avi|mkv|wav|mp3|m4a)\b/gi;
// A space stays inside a path when the next word has a separator too ("/My Birds/owl.jpg").
const PATH_TAIL = String.raw`(?:[^\s'"\x60<>()|,;]|\s(?=[^\s/\\]*[/\\]))+`;
const POSIX_PATH = new RegExp(String.raw`(?<![\w.<>])(?:~|\.{1,2})?/${PATH_TAIL}`, "g");
const WINDOWS_PATH = new RegExp(String.raw`(?<!\w)(?:[A-Za-z]:[\\/]|\\\\)${PATH_TAIL}`, "g");
const URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s'"`<>()]+/gi;

// Lifer's own source frames keep their file name and line; any other path or URL is dropped.
function pathOrSourceFrame(match: string, placeholder: string): string {
  const position = /(?::\d+){1,2}$/.exec(match)?.[0] ?? "";
  const base =
    match
      .slice(0, match.length - position.length)
      .split(/[\\/]/)
      .pop() ?? "";
  return SOURCE_FILE.test(base) ? base + position : placeholder;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Code in quotes survives: Node's "(reading 'x')" property names and Rust's `Result::unwrap()`.
const QUOTED_CODE = /^[A-Za-z_$][\w$]*(?:::[\w$]+)+(?:\(\))?$|^[A-Za-z_$][\w$.]*\(\)$/;
// Two or more capitalised words in a row are a name (a species, place or album), as is a Latin
// binomial. Error prose rarely does either.
const TITLE_RUN = /\b[A-Z][\w'-]*(?: [A-Z][\w'-]*)+\b/g;
const BINOMIAL = /\b[A-Z][a-z]+ [a-z]+(?:us|um|a|ae|is|es|i|ii|ensis|oides|ix|ax|ex|or|on)\b/g;

/** Strips everything but the crash details. Quoted text can be a species, album, folder or file
 *  name, so it goes too, unless it's code. */
export function redact(text: string, home = os.homedir(), user = safeUserName()): string {
  let out = text
    .replace(/file:\/\//gi, "")
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "<email>")
    .replace(URL_PATTERN, (m) => pathOrSourceFrame(m, "<url>"));
  if (home.length > 1) out = out.replaceAll(home, "~");
  out = out
    .replace(/\b(bearer|basic)\s+[\w.~+/=-]+/gi, "$1 <redacted>")
    .replace(
      /\b([\w-]*(?:token|secret|passw(?:or)?d|api[_-]?key|cookie|session|sid|auth|credential|signature)[\w-]*)(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;&)]+)/gi,
      "$1$2<redacted>",
    )
    .replace(/=\([^)\n]*\)/g, "=(<redacted>)")
    .replace(/(?<![\w\\])(["'`])((?:(?!\1)[^\n\\]|\\.)*)\1/g, (m, q: string, inner: string, at: number, all: string) =>
      QUOTED_CODE.test(inner) || /\((?:reading|setting) $/.test(all.slice(Math.max(0, at - 10), at))
        ? m
        : `${q}<redacted>${q}`,
    )
    .replace(POSIX_PATH, (m) => pathOrSourceFrame(m, "<path>"))
    .replace(WINDOWS_PATH, (m) => pathOrSourceFrame(m, "<path>"))
    .replace(/(?<![\w.<>:/\\-])(?:[\w.-]+[\\/])+[\w.-]*/g, (m) => pathOrSourceFrame(m, "<path>"))
    .replace(MEDIA_FILE, "<file>")
    // After paths, so a hash inside a path doesn't split it.
    .replace(/\blifer_[A-Za-z0-9_-]{16,}/g, "<redacted>")
    .replace(/\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{24,}\b/g, "<redacted>");
  if (user.length >= 3) out = out.replace(new RegExp(String.raw`\b${escapeRegExp(user)}\b`, "gi"), "<user>");
  return out
    .replace(BINOMIAL, "<name>")
    .replace(TITLE_RUN, "<name>")
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, "<ip>")
    .replace(/-?\b\d{1,3}\.\d{3,}\b/g, "<number>");
}

function safeUserName(): string {
  try {
    return os.userInfo().username;
  } catch {
    return "";
  }
}

const cap = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}\n[truncated]` : text);

/** The report as it's saved, shown and sent: redacted and capped, whoever wrote the file. */
export function normalizeReport(raw: Partial<Record<keyof CrashReport, unknown>>): CrashReport | null {
  if (!CRASH_KINDS.includes(raw.kind as CrashKind)) return null;
  const time = new Date(typeof raw.timestamp === "number" ? raw.timestamp : String(raw.timestamp ?? ""));
  return {
    app: "lifer",
    version: String(raw.version ?? APP_VERSION).slice(0, 40),
    os: String(raw.os ?? process.platform).slice(0, 20),
    arch: String(raw.arch ?? process.arch).slice(0, 20),
    kind: raw.kind as CrashKind,
    message: cap(redact(String(raw.message ?? "")), MAX_MESSAGE),
    stack: cap(redact(String(raw.stack ?? "")), MAX_STACK),
    timestamp: Number.isNaN(time.getTime()) ? new Date(0).toISOString() : time.toISOString(),
  };
}

export function buildReport(kind: CrashKind, error: unknown, now = new Date()): CrashReport {
  const err = error instanceof Error ? error : null;
  return normalizeReport({
    kind,
    message: err ? `${err.name}: ${err.message}` : String(error),
    stack: err?.stack ?? "",
    timestamp: now.getTime(),
  })!;
}

/** Saves one report and keeps only the newest few. Never throws: it runs while crashing. */
export function saveCrashReport(report: CrashReport, dir = CRASH_DIR): void {
  if (!crashReportsEnabled()) return;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileAtomicSync(path.join(dir, `${Date.parse(report.timestamp)}.json`), JSON.stringify(report));
    for (const old of reportFiles(dir).slice(KEEP)) rmSync(path.join(dir, old), { force: true });
  } catch {
    // Nowhere left to report a failure to.
  }
}

// Newest first. Names are epoch milliseconds, from this file and the desktop shell alike.
function reportFiles(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((f) => /^\d+\.json$/.test(f))
      .sort((a, b) => Number.parseInt(b) - Number.parseInt(a));
  } catch {
    return [];
  }
}

export interface StoredReport {
  id: string;
  report: CrashReport;
}

export function listCrashReports(dir = CRASH_DIR): StoredReport[] {
  if (!crashReportsEnabled()) return [];
  return reportFiles(dir).flatMap((file) => {
    try {
      const report = normalizeReport(JSON.parse(readFileSync(path.join(dir, file), "utf8")));
      if (report) return [{ id: file.slice(0, -5), report }];
    } catch {
      // Unreadable: dropped below like any report nobody can send.
    }
    rmSync(path.join(dir, file), { force: true });
    return [];
  });
}

/** Ids are the file stems listCrashReports gave out, so nothing else can be named. */
export function deleteCrashReport(id: string, dir = CRASH_DIR): void {
  if (/^\d+$/.test(id)) rmSync(path.join(dir, `${id}.json`), { force: true });
}

export function payloadFor(report: CrashReport, note?: string): CrashReport & { note?: string } {
  const trimmed = note?.trim().slice(0, MAX_NOTE);
  return trimmed ? { ...report, note: trimmed } : report;
}

/** Throws unless the server answers 204. */
export async function sendCrashReport(
  report: CrashReport,
  note?: string,
  url = CRASH_REPORT_URL,
  timeoutMs = SEND_TIMEOUT_MS,
): Promise<void> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payloadFor(report, note)),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status !== 204) throw new Error(`Crash report server answered ${res.status}`);
}
