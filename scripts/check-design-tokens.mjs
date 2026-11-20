#!/usr/bin/env node
// Fails when the web app uses a raw corner radius or text size instead of a design token
// (apps/web/src/theme.css): rounded-panel, rounded-control or rounded-badge, and the named text
// styles (text-body, text-footnote...). rounded-full and rounded-none are shapes, so they stay.
// A justified one-off carries a comment on its line or the line just above: `design-token: <why>`.
// Also flags, against scripts/design-tokens-baseline.json: raw colours (#hex, rgb(), Tailwind palette
// classes), arbitrary [Npx] sizes, outline-none without a focus-visible ring on the line, and title= on
// Button or IconButton (use the shared Tooltip). The baseline may only shrink; fix entries as you touch
// a file. Regenerate it with --write-baseline only when deliberately accepting current state.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(root, "apps", "web", "src");
const ESCAPE = /design-token:\s*\S/;
const COMMENT_LINE = /^\s*(\/\/|\*|\/\*|\{\/\*)/;
const SIDE = "(?:-(?:t|b|l|r|s|e|tl|tr|bl|br|ss|se|es|ee))?";
const RADIUS = new RegExp(`(?<![\\w-])rounded${SIDE}(?:-(\\[[^\\]]*\\]|[\\w]+))?(?![\\w-])`, "g");
const RADIUS_OK = /^(none|full|panel|control|badge)$|^\[.*var\(--radius-/;
const baselinePath = join(root, "scripts", "design-tokens-baseline.json");
const HEX = /(?<![\w&/#-])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])/g;
const RGB = /(?<![\w-])rgba?\(/g;
const PALETTE =
  /(?<![\w-])(?:bg|text|border|ring|fill|stroke|from|to|via|divide|outline|shadow|accent|decoration|caret|placeholder)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}(?![\w-])|(?<![\w-])(?:bg|text|border|ring|fill|stroke|from|to|via|divide|outline|shadow)-(?:white|black)(?![\w-])/g;
const PIXEL = /(?<![\w-])(?!text-|rounded)[a-z]+(?:-[a-z]+)*-\[-?\d+(?:\.\d+)?px\]/g;
const OUTLINE_NONE = /(?<![\w-])(?:[\w-]+:)*outline-none(?![\w-])/;
const TITLE_ATTR = /<(?:Button|IconButton)\b(?:[^>]|=>)*?\n?\s(title)=/g;
const TEXT = /(?<![\w-])text-(xs|sm|base|lg|[2-9]?xl|\[\d[^\]]*\])(?![\w-])/g;

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? walk(join(dir, e.name))
      : /\.tsx?$/.test(e.name) && !/\.test\./.test(e.name) && e.name !== "schema.gen.ts"
        ? [join(dir, e.name)]
        : [],
  );
}

/** Raw radius and text-size classes in one file's text that lack an escape comment. */
export function rawTokens(text) {
  const lines = text.split("\n");
  const found = [];
  lines.forEach((line, i) => {
    if (COMMENT_LINE.test(line) || ESCAPE.test(line) || ESCAPE.test(lines[i - 1] ?? "")) return;
    for (const m of line.matchAll(RADIUS)) {
      if (!RADIUS_OK.test(m[1] ?? "")) found.push({ line: i + 1, cls: m[0] });
    }
    for (const m of line.matchAll(TEXT)) found.push({ line: i + 1, cls: m[0] });
  });
  return found;
}

/** Colour, pixel, focus-ring and title violations, each tagged with a kind and the trimmed line. */
export function baselinedTokens(text) {
  const lines = text.split("\n");
  const skip = (i) => COMMENT_LINE.test(lines[i]) || ESCAPE.test(lines[i]) || ESCAPE.test(lines[i - 1] ?? "");
  const found = [];
  const add = (i, kind) => found.push({ line: i + 1, kind, text: lines[i].trim() });
  lines.forEach((line, i) => {
    if (skip(i)) return;
    for (const re of [HEX, RGB, PALETTE]) for (const _ of line.matchAll(re)) add(i, "colour");
    for (const _ of line.matchAll(PIXEL)) add(i, "pixel");
    if (OUTLINE_NONE.test(line) && !line.includes("focus-visible:")) add(i, "focus-ring");
  });
  for (const m of text.matchAll(TITLE_ATTR)) {
    const i = text.slice(0, m.index + m[0].length).split("\n").length - 1;
    if (!skip(i)) add(i, "title");
  }
  return found;
}

const key = (e) => `${e.file}\t${e.kind}\t${e.text}`;

// Self-check, so a broken pattern can't pass every file silently.
assert.deepEqual(
  rawTokens(
    [
      '<div className="rounded-panel first:rounded-t-panel rounded-full rounded-l-none text-body sm:text-title-2">',
      '<p className="rounded-[calc(var(--radius-panel)-1px)] text-[#fff] text-ink">',
      "// a rounded corner, text-sm in a comment",
      "{/* design-token: the overlay inherits its parent's corner */}",
      '<i className="after:rounded-[inherit]" />',
      '<b className="rounded md:rounded-md rounded-t-lg rounded-[3px] text-xs sm:text-sm! text-2xl text-[11px]" />',
    ].join("\n"),
  ).map(({ line, cls }) => `${line}:${cls}`),
  [
    "6:rounded",
    "6:rounded-md",
    "6:rounded-t-lg",
    "6:rounded-[3px]",
    "6:text-xs",
    "6:text-sm",
    "6:text-2xl",
    "6:text-[11px]",
  ],
);

const kinds = (src) => baselinedTokens(src).map((e) => `${e.kind}:${e.text}`);
assert.deepEqual(kinds('<i className="text-green-600 bg-[#fff] border-white/10 text-ink" />'), [
  "colour:" + '<i className="text-green-600 bg-[#fff] border-white/10 text-ink" />',
  "colour:" + '<i className="text-green-600 bg-[#fff] border-white/10 text-ink" />',
  "colour:" + '<i className="text-green-600 bg-[#fff] border-white/10 text-ink" />',
]);
assert.deepEqual(
  kinds(
    '<a href="#top" className="w-[12px] text-[11px] rounded-[3px] p-[var(--x)]" style={{ c: "rgb(0 0 0)" }} />',
  ).map((k) => k.split(":")[0]),
  ["colour", "pixel"],
);
assert.deepEqual(
  kinds('<i className="outline-none" />\n<b className="outline-none focus-visible:ring-2" />').length,
  1,
);
assert.deepEqual(
  kinds('<IconButton\n  label="x"\n  title="y"\n  onClick={() => go()}\n/>').map((k) => k.split(":")[0]),
  ["title"],
);
assert.deepEqual(kinds('<div title="y" />\n// design-token: scrim\n<i className="bg-black/40" />'), []);

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const offenders = walk(srcDir).flatMap((file) =>
    rawTokens(readFileSync(file, "utf8")).map(({ line, cls }) => `${relative(root, file)}:${line}: ${cls}`),
  );
  const counts = new Map();
  for (const file of walk(srcDir)) {
    for (const e of baselinedTokens(readFileSync(file, "utf8"))) {
      const k = key({ ...e, file: relative(root, file) });
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
  }
  if (process.argv.includes("--write-baseline")) {
    const out = [...counts].sort().map(([k, count]) => {
      const [file, kind, text] = k.split("\t");
      return { file, kind, text, count };
    });
    writeFileSync(baselinePath, JSON.stringify(out, null, 2) + "\n");
    console.log(`Wrote ${out.length} baseline entries.`);
    process.exit(0);
  }
  const allowed = new Map(JSON.parse(readFileSync(baselinePath, "utf8")).map((e) => [key(e), e.count]));
  for (const [k, n] of counts) {
    const extra = n - (allowed.get(k) ?? 0);
    if (extra > 0) {
      const [file, kind, text] = k.split("\t");
      offenders.push(`${file}: new ${kind} violation: ${text}`);
    }
  }
  const shrank = [...allowed].filter(([k, n]) => (counts.get(k) ?? 0) < n).length;
  if (shrank)
    console.log(
      `Baseline shrank (${shrank} entries), please run: node scripts/check-design-tokens.mjs --write-baseline`,
    );
  if (offenders.length) {
    console.error(offenders.join("\n"));
    console.error(
      `\n${offenders.length} design token violation(s). Use a token from apps/web/src/theme.css, or add a "design-token: <why>" comment for a justified one-off.`,
    );
    process.exit(1);
  }
  console.log("No new design token violations in the web app.");
}
