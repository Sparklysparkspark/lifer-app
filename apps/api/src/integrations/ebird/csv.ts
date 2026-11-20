// Reads eBird's "My eBird Data" export (MyEBirdData.csv): one row per species seen, grouped here
// into one record per checklist. Headers are checked first so a wrong file gets a plain message.
export interface ParsedChecklist {
  subId: string;
  /** Local wall clock as UTC text, "YYYY-MM-DDTHH:MM:00Z"; midnight when the row has no time. */
  startedAt: string;
  hasTime: boolean;
  durationMin: number | null;
  lat: number | null;
  lon: number | null;
  location: string;
  species: string[];
}

export interface ParsedEbird {
  checklists: ParsedChecklist[];
  /** Rows left out, each with why, so the page can say plainly what is wrong. */
  skipped: string[];
}

const REQUIRED = ["Submission ID", "Scientific Name", "Date"] as const;
// The most skipped rows reported by name; the count is always complete.
const MAX_REPORTED = 10;

/** RFC 4180 rows: quoted fields may hold commas, quotes ("") and line breaks. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((f) => f !== "")) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((f) => f !== "")) rows.push(row);
  return rows;
}

function parseDate(raw: string): string | null {
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim());
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(raw.trim());
  const [y, m, d] = iso ? [iso[1], iso[2], iso[3]] : us ? [us[3], us[1], us[2]] : [];
  if (!y || !m || !d) return null;
  const mm = m.padStart(2, "0");
  const dd = d.padStart(2, "0");
  const valid = new Date(`${y}-${mm}-${dd}T00:00:00Z`);
  return Number.isNaN(valid.getTime()) || valid.toISOString().slice(0, 10) !== `${y}-${mm}-${dd}`
    ? null
    : `${y}-${mm}-${dd}`;
}

/** "07:30 AM", "7:30 pm" or "19:30" as "HH:MM", or null when there is no time. */
function parseTime(raw: string): string | null {
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?\s*([AaPp][Mm])?$/.exec(raw.trim());
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2]);
  if (m[3]) {
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (m[3].toLowerCase() === "pm" ? 12 : 0);
  }
  return h > 23 || min > 59 ? null : `${String(h).padStart(2, "0")}:${m[2]}`;
}

const number = (raw: string | undefined) => {
  const n = raw?.trim() ? Number(raw) : NaN;
  return Number.isFinite(n) ? n : null;
};

export function parseMyEbirdData(text: string): ParsedEbird {
  const rows = parseCsv(text);
  const header = rows[0]?.map((h) => h.trim()) ?? [];
  const missing = REQUIRED.filter((name) => !header.includes(name));
  if (missing.length > 0)
    throw new Error(
      `This doesn't look like eBird's "My eBird Data" file: it has no ${missing.map((m) => `"${m}"`).join(", ")} column. Download it from ebird.org under My eBird, Download My Data.`,
    );
  const col = (name: string) => header.indexOf(name);
  const at = { sub: col("Submission ID"), sci: col("Scientific Name"), date: col("Date"), time: col("Time") };
  const loc = { name: col("Location"), lat: col("Latitude"), lon: col("Longitude"), dur: col("Duration (Min)") };

  const byId = new Map<string, ParsedChecklist & { names: Set<string> }>();
  const skipped: string[] = [];
  for (const [i, row] of rows.slice(1).entries()) {
    const subId = row[at.sub]?.trim();
    const date = parseDate(row[at.date] ?? "");
    if (!subId || !date) {
      skipped.push(`Row ${i + 2} has no ${subId ? "usable date" : "submission ID"}`);
      continue;
    }
    let entry = byId.get(subId);
    if (!entry) {
      const time = at.time >= 0 ? parseTime(row[at.time] ?? "") : null;
      const lat = number(row[loc.lat]);
      const lon = number(row[loc.lon]);
      const place = lat !== null && lon !== null && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
      entry = {
        subId,
        startedAt: `${date}T${time ?? "00:00"}:00Z`,
        hasTime: time !== null,
        durationMin: number(row[loc.dur]) === null ? null : Math.round(number(row[loc.dur])!),
        lat: place ? lat : null,
        lon: place ? lon : null,
        location: (row[loc.name] ?? "").trim().slice(0, 500),
        species: [],
        names: new Set(),
      };
      byId.set(subId, entry);
    }
    // Slashes and "sp." entries name no single species, so they can't match one.
    const name = row[at.sci]?.trim();
    if (name && !name.includes("/") && !/\bsp\.|\bx\b/.test(name)) entry.names.add(name);
  }
  return {
    checklists: [...byId.values()].map(({ names, ...c }) => ({ ...c, species: [...names].sort() })),
    skipped:
      skipped.length > MAX_REPORTED
        ? [...skipped.slice(0, MAX_REPORTED), `And ${skipped.length - MAX_REPORTED} more`]
        : skipped,
  };
}
