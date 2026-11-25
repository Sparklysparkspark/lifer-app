// AppleScript for adding keywords to photos already in Apple Photos (macOS). PhotoKit can't write
// keywords; Photos' scripting dictionary can (media item's `keywords`). Every value goes in as an
// osascript argument, never into the script text, so a name can't change what the script does.
import { execFile } from "node:child_process";

/** Finds media items by original file name. Prints "name<TAB>id<TAB>days,seconds" per hit (local
 *  time since 1970, split since AppleScript integers stop at 2^29), then "tz<TAB>offset". */
export const LOOKUP_SCRIPT = `on run argv
	set e to current date
	set day of e to 1
	set year of e to 1970
	set month of e to January
	set time of e to 0
	set out to {}
	tell application "Photos"
		repeat with n in argv
			set fname to n as text
			repeat with m in (every media item whose filename is fname)
				set stamp to ""
				set d to date of m
				if d is not missing value then
					set s to d - e
					set stamp to ((s div 86400) as text) & "," & ((s mod 86400) as integer as text)
				end if
				set end of out to fname & tab & (id of m) & tab & stamp
			end repeat
		end repeat
	end tell
	set end of out to "tz" & tab & ((time to GMT) as text)
	set AppleScript's text item delimiters to linefeed
	return out as text
end run`;

/** Adds keywords to one media item (argv: id, then keywords), keeping every keyword it has.
 *  Prints how many were new. */
export const ADD_KEYWORDS_SCRIPT = `on run argv
	set itemId to item 1 of argv
	set wanted to rest of argv
	tell application "Photos"
		set m to media item id itemId
		set kw to keywords of m
		if kw is missing value then set kw to {}
		set added to 0
		repeat with k in wanted
			set k to k as text
			if kw does not contain {k} then
				set end of kw to k
				set added to added + 1
			end if
		end repeat
		if added > 0 then set keywords of m to kw
	end tell
	return added as text
end run`;

export interface PhotosCandidate {
  name: string;
  id: string;
  /** UTC milliseconds, or null when Photos has no date for it. */
  takenAt: number | null;
}

/** Reads LOOKUP_SCRIPT's output. */
export function parseLookup(output: string): PhotosCandidate[] {
  const lines = output.split(/\r?\n/).filter(Boolean);
  const tz = Number(lines.find((l) => l.startsWith("tz\t"))?.split("\t")[1] ?? 0) || 0;
  return lines
    .filter((l) => !l.startsWith("tz\t"))
    .map((l) => l.split("\t"))
    .filter((parts) => parts.length >= 2 && parts[1])
    .map(([name, id, stamp]) => {
      const [days, secs] = (stamp ?? "").split(",").map(Number);
      const local = stamp && Number.isFinite(days) && Number.isFinite(secs) ? days * 86400 + secs : null;
      return { name, id, takenAt: local == null ? null : (local - tz) * 1000 };
    });
}

// Photos shows the camera's clock read in the Mac's time zone, and the zone offset used is today's,
// so a match allows for any zone and a daylight saving hour.
const MATCH_WINDOW_MS = 15 * 60 * 60 * 1000;

/** The Photos item that is this photo: a file name hit taken at the same time (closest wins). With
 *  no time in Lifer, only a single hit counts, since camera file names repeat. */
export function pickMatch(candidates: PhotosCandidate[], takenAt: Date | null): string | null {
  const unique = [...new Map(candidates.map((c) => [c.id, c])).values()];
  if (unique.length === 0) return null;
  if (!takenAt) return unique.length === 1 ? unique[0].id : null;
  const dated = unique
    .filter((c) => c.takenAt != null && Math.abs(c.takenAt - takenAt.getTime()) <= MATCH_WINDOW_MS)
    .sort((a, b) => Math.abs(a.takenAt! - takenAt.getTime()) - Math.abs(b.takenAt! - takenAt.getTime()));
  if (dated.length > 0) return dated[0].id;
  return unique.length === 1 && unique[0].takenAt == null ? unique[0].id : null;
}

export type PhotosProblem = "automation_denied" | "photos_unavailable";

export class ApplePhotosError extends Error {
  constructor(
    readonly problem: PhotosProblem | null,
    message: string,
  ) {
    super(message);
  }
}

/** The AppleScript error number in osascript's message ("... (-1743)"), or null. */
export function scriptErrorNumber(message: string): number | null {
  const m = /\((-?\d+)\)\s*$/.exec(message.trim());
  return m ? Number(m[1]) : null;
}

const toError = (stderr: string): ApplePhotosError => {
  const n = scriptErrorNumber(stderr);
  // -1743: the user said no (or never answered) to Lifer controlling Photos.
  if (n === -1743) return new ApplePhotosError("automation_denied", "Lifer isn't allowed to control Photos");
  // -600: Photos isn't running and couldn't be started; -10660: it's busy or not open yet.
  if (n === -600 || n === -10660) return new ApplePhotosError("photos_unavailable", "Photos couldn't be opened");
  return new ApplePhotosError(null, stderr.trim() || "Photos didn't answer");
};

/** Runs a script with osascript and returns what it printed. */
export function runOsascript(script: string, args: string[], signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "/usr/bin/osascript",
      ["-e", script, ...args],
      { timeout: 5 * 60_000, maxBuffer: 16 * 1024 * 1024, signal },
      (err, stdout, stderr) => {
        if (err) reject(toError(String(stderr || err.message)));
        else resolve(String(stdout).trim());
      },
    );
  });
}
