// OpenAI CLIP's byte-level BPE, read from the hub's own tokenizer.json so a query lands on the same
// token ids the hub's encoder sees: NFC, spaces collapsed, lowercase, the CLIP split pattern, bytes
// mapped to printable characters, merges by rank, "</w>" on a word's last character, start and end tokens.
export const CONTEXT_LENGTH = 77;
const START = 49406;
const END = 49407;

export interface ClipTokenizerFile {
  model: { vocab: Record<string, number>; merges: (string | [string, string])[] };
}

// The pre-tokenizer's pattern in tokenizer.json: contractions, letter runs, single digits, symbol runs.
const SPLIT = /'s|'t|'re|'ve|'m|'ll|'d|\p{L}+|\p{N}|[^\s\p{L}\p{N}]+/gu;

/** GPT-2's byte to printable character table. */
function byteChars(): string[] {
  const keep: number[] = [];
  for (let b = 33; b <= 126; b++) keep.push(b);
  for (let b = 161; b <= 172; b++) keep.push(b);
  for (let b = 174; b <= 255; b++) keep.push(b);
  const out: string[] = new Array(256);
  let extra = 0;
  for (let b = 0; b < 256; b++) out[b] = String.fromCharCode(keep.includes(b) ? b : 256 + extra++);
  return out;
}

/** UTF-8 bytes without relying on TextEncoder being present. */
function utf8(s: string): number[] {
  const out: number[] = [];
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return out;
}

export function createClipTokenizer(file: ClipTokenizerFile): { encode(text: string): number[] } {
  const { vocab } = file.model;
  const ranks = new Map<string, number>();
  file.model.merges.forEach((m, i) => ranks.set(typeof m === "string" ? m : `${m[0]} ${m[1]}`, i));
  const chars = byteChars();
  const cache = new Map<string, number[]>();

  function bpe(word: string): number[] {
    const hit = cache.get(word);
    if (hit) return hit;
    let parts = [...word];
    parts[parts.length - 1] += "</w>";
    while (parts.length > 1) {
      let best = -1;
      let bestRank = Infinity;
      for (let i = 0; i < parts.length - 1; i++) {
        const r = ranks.get(`${parts[i]} ${parts[i + 1]}`);
        if (r !== undefined && r < bestRank) {
          bestRank = r;
          best = i;
        }
      }
      if (best < 0) break;
      parts = [...parts.slice(0, best), parts[best] + parts[best + 1], ...parts.slice(best + 2)];
    }
    const ids = parts.map((p) => vocab[p] ?? END);
    if (cache.size > 5000) cache.clear();
    cache.set(word, ids);
    return ids;
  }

  return {
    encode(text) {
      const clean = text.normalize("NFC").replace(/\s+/g, " ").toLowerCase();
      const ids: number[] = [];
      for (const m of clean.matchAll(SPLIT))
        ids.push(
          ...bpe(
            utf8(m[0])
              .map((b) => chars[b])
              .join(""),
          ),
        );
      // The hub's tokenizer cuts after adding the special tokens, so a long text loses its end token.
      return [START, ...ids, END].slice(0, CONTEXT_LENGTH);
    },
  };
}
