// The en-XA pseudo-locale: every English message with its letters accented, padded about 40%
// longer and bracketed, so untranslated strings (no brackets), clipped text and layouts that
// can't take longer translations stand out. Generated from en.json at runtime, never a file.
// Only literal text changes: placeholders, plural and select branches and tags stay valid ICU.
import { parse, TYPE, type MessageFormatElement } from "@formatjs/icu-messageformat-parser";
import { printAST } from "@formatjs/icu-messageformat-parser/printer.js";

const ACCENTS: Record<string, string> = {
  a: "á",
  b: "ƀ",
  c: "ç",
  d: "ð",
  e: "é",
  f: "ƒ",
  g: "ĝ",
  h: "ĥ",
  i: "î",
  j: "ĵ",
  k: "ķ",
  l: "ļ",
  m: "ɱ",
  n: "ñ",
  o: "ö",
  p: "þ",
  q: "ǫ",
  r: "ŕ",
  s: "š",
  t: "ţ",
  u: "û",
  v: "ṽ",
  w: "ŵ",
  x: "ẋ",
  y: "ý",
  z: "ž",
  A: "Å",
  B: "Ɓ",
  C: "Ç",
  D: "Ð",
  E: "É",
  F: "Ƒ",
  G: "Ĝ",
  H: "Ĥ",
  I: "Î",
  J: "Ĵ",
  K: "Ķ",
  L: "Ļ",
  M: "Ṁ",
  N: "Ñ",
  O: "Ö",
  P: "Þ",
  Q: "Ǫ",
  R: "Ŕ",
  S: "Š",
  T: "Ţ",
  U: "Û",
  V: "Ṽ",
  W: "Ŵ",
  X: "Ẋ",
  Y: "Ý",
  Z: "Ž",
};

// A self-closing <Trans> slot like <name/> parses as literal text, so it's skipped explicitly.
function accent(text: string): string {
  return text.replace(/<[a-zA-Z][a-zA-Z0-9]*\s*\/>|[a-zA-Z]/g, (match) => ACCENTS[match] ?? match);
}

function transform(elements: MessageFormatElement[]): MessageFormatElement[] {
  return elements.map((el) => {
    if (el.type === TYPE.literal) return { ...el, value: accent(el.value) };
    if (el.type === TYPE.tag) return { ...el, children: transform(el.children) };
    if (el.type === TYPE.plural || el.type === TYPE.select) {
      const options = Object.fromEntries(
        Object.entries(el.options).map(([k, opt]) => [k, { ...opt, value: transform(opt.value) }]),
      );
      return { ...el, options };
    }
    return el;
  });
}

function letterCount(elements: MessageFormatElement[]): number {
  let n = 0;
  for (const el of elements) {
    if (el.type === TYPE.literal) n += el.value.replace(/\s/g, "").length;
    else if (el.type === TYPE.tag) n += letterCount(el.children);
    else if (el.type === TYPE.plural || el.type === TYPE.select) {
      n += Math.max(0, ...Object.values(el.options).map((opt) => letterCount(opt.value)));
    }
  }
  return n;
}

/** One message pseudo-localized. A message that isn't valid ICU is returned unchanged. */
export function pseudoLocalize(message: string): string {
  let ast: MessageFormatElement[];
  try {
    ast = parse(message, { ignoreTag: false });
  } catch {
    return message;
  }
  // About 40% longer, like German or Finnish, with at least a couple of characters for short labels.
  const padding = "~".repeat(Math.max(2, Math.round(letterCount(ast) * 0.4)));
  // The printer quotes a self-closing slot ('<name/>'), but at runtime tags aren't ICU syntax
  // (i18next-icu ignores them for <Trans>), so the quotes would show. Unquote them.
  const printed = printAST(transform(ast)).replace(/'(<[a-zA-Z][a-zA-Z0-9]*\s*\/>)'/g, "$1");
  return `[${printed} ${padding}]`;
}

type Messages = { [key: string]: string | Messages };

/** A whole resource tree pseudo-localized. */
export function pseudoLocalizeAll(messages: Messages): Messages {
  return Object.fromEntries(
    Object.entries(messages).map(([key, value]) => [
      key,
      typeof value === "string" ? pseudoLocalize(value) : pseudoLocalizeAll(value),
    ]),
  );
}
