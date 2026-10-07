#!/usr/bin/env node
// Checks the web app's translation files against its code (see docs/docs/contributing/translating.md):
//   - en.json is nested objects of strings, with camelCase or snake_case key segments,
//   - every message is valid ICU MessageFormat, with no apostrophe that would start an ICU quote,
//   - every key the code uses exists in en.json, and every key in en.json is used,
//   - no key is built at runtime (t(`a.${b}`)): keys must be literal so this check and Weblate see them,
//   - en.context.json only describes keys that exist,
//   - every other locales/*.json is valid ICU and has no keys English doesn't (a warning: Weblate
//     cleans those up).
// A key counts as used when it appears as a whole string literal anywhere in apps/web/src (outside
// tests): a t("...") call, an i18nKey prop, or a map of keys picked from at runtime.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import ts from "typescript";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const webSrc = join(root, "apps", "web", "src");
const localesDir = join(webSrc, "locales");
const contextPath = join(webSrc, "i18n", "en.context.json");
// The ICU parser is the web app's dependency.
const require = createRequire(join(root, "apps", "web", "package.json"));
const { parse } = require("@formatjs/icu-messageformat-parser");

const errors = [];
const warnings = [];

function flatten(obj, prefix, out, file) {
  for (const [key, value] of Object.entries(obj)) {
    const full = prefix ? `${prefix}.${key}` : key;
    if (!/^[a-z][a-zA-Z0-9_]*$/.test(key)) errors.push(`${file}: "${full}": key segments are camelCase or snake_case`);
    if (typeof value === "string") out.set(full, value);
    else if (value && typeof value === "object" && !Array.isArray(value)) flatten(value, full, out, file);
    else errors.push(`${file}: "${full}" must be a string or an object of strings`);
  }
  return out;
}

// An apostrophe directly before { } # | or < starts an ICU quoted literal, so "the '{name}' tag"
// would print {name} literally. Write '' (two apostrophes) for a literal one there.
const QUOTE_HAZARD = /(^|[^'])'(?=[{}#|<])/;

function checkMessages(file, messages, { strictEmpty }) {
  for (const [key, message] of messages) {
    if (strictEmpty && !message.trim()) errors.push(`${file}: "${key}" is empty`);
    try {
      parse(message, { ignoreTag: false, requiresOtherClause: true });
    } catch (err) {
      errors.push(`${file}: "${key}" is not valid ICU MessageFormat (${err.message}): ${message}`);
      continue;
    }
    if (QUOTE_HAZARD.test(message)) {
      errors.push(
        `${file}: "${key}" has an apostrophe before { } # | or <, which ICU reads as a quote. Use '' for a literal apostrophe there: ${message}`,
      );
    }
  }
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    errors.push(`${relative(root, path)}: ${err.message}`);
    return {};
  }
}

// --- en.json ---
const enPath = join(localesDir, "en.json");
const en = flatten(readJson(enPath), "", new Map(), "en.json");
checkMessages("en.json", en, { strictEmpty: true });

// --- Other locales ---
for (const file of readdirSync(localesDir)
  .filter((f) => f.endsWith(".json") && f !== "en.json")
  .sort()) {
  const messages = flatten(readJson(join(localesDir, file)), "", new Map(), file);
  checkMessages(file, messages, { strictEmpty: false });
  const stale = [...messages.keys()].filter((k) => !en.has(k));
  if (stale.length)
    warnings.push(`${file}: ${stale.length} key(s) English no longer has, e.g. ${stale.slice(0, 3).join(", ")}`);
}

// --- Translator context ---
const context = flatten(readJson(contextPath), "", new Map(), "en.context.json");
for (const key of context.keys()) {
  if (!en.has(key)) errors.push(`en.context.json: "${key}" isn't a key in en.json`);
}

// --- Source ---
function sourceFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === "locales" ? [] : sourceFiles(full);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name) && !name.endsWith(".d.ts") ? [full] : [];
  });
}

const used = new Set();
function isTranslateCallee(expr) {
  // t(...), i18n.t(...), anything.t(...)
  return (
    (ts.isIdentifier(expr) && expr.text === "t") || (ts.isPropertyAccessExpression(expr) && expr.name.text === "t")
  );
}

for (const file of sourceFiles(webSrc)) {
  const text = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const where = (node) => `${relative(root, file)}:${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
  const requireKey = (node, key) => {
    if (!en.has(key)) errors.push(`${where(node)}: "${key}" isn't in en.json`);
  };
  const visit = (node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (en.has(node.text)) used.add(node.text);
    }
    if (ts.isCallExpression(node) && isTranslateCallee(node.expression) && node.arguments.length > 0) {
      const arg = node.arguments[0];
      if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) requireKey(arg, arg.text);
      else if (ts.isTemplateExpression(arg)) {
        errors.push(
          `${where(arg)}: a key built at runtime (${arg.getText(sf)}). Pick from a map of literal keys instead.`,
        );
      }
    }
    if (ts.isJsxAttribute(node) && node.name.getText(sf) === "i18nKey" && node.initializer) {
      const init = node.initializer;
      const literal = ts.isStringLiteral(init)
        ? init
        : ts.isJsxExpression(init) && init.expression && ts.isStringLiteral(init.expression)
          ? init.expression
          : null;
      if (literal) requireKey(literal, literal.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

const unused = [...en.keys()].filter((k) => !used.has(k));
for (const key of unused) errors.push(`en.json: "${key}" isn't used anywhere in apps/web/src`);

for (const w of warnings) console.warn(`warning: ${w}`);
if (errors.length > 0) {
  console.error(errors.join("\n"));
  console.error(`\n${errors.length} i18n problem(s). See docs/docs/contributing/translating.md.`);
  process.exit(1);
}
let plurals = 0;
for (const message of en.values()) if (/\{\s*\w+\s*,\s*(plural|selectordinal)\s*,/.test(message)) plurals++;
console.log(
  `en.json OK: ${en.size} keys (${plurals} with ICU plurals), all used, ${context.size} with translator context.`,
);
