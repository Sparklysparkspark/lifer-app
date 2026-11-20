import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { createClipTokenizer, type ClipTokenizerFile } from "./clipTokenizer";

// testdata/clip-tokenizer.json.gz is the hub's tokenizer.json; the fixture is what the hub's own
// tokenizer (@huggingface/transformers AutoTokenizer, padding and truncation on) returned for each text.
const file = JSON.parse(
  gunzipSync(readFileSync(new URL("./testdata/clip-tokenizer.json.gz", import.meta.url))).toString(),
) as ClipTokenizerFile;
const fixture = JSON.parse(readFileSync(new URL("./testdata/clip-token-fixture.json", import.meta.url), "utf8")) as {
  text: string;
  ids: number[];
}[];

describe("CLIP tokenizer", () => {
  const tokenizer = createClipTokenizer(file);
  it.each(fixture.map((f) => [f.text.slice(0, 40), f] as const))("matches the hub's ids for %j", (_name, f) => {
    expect(tokenizer.encode(f.text)).toEqual(f.ids);
  });
  it("starts and ends with the special tokens and stops at 77 tokens", () => {
    const ids = tokenizer.encode("swan");
    expect([ids[0], ids.at(-1)]).toEqual([49406, 49407]);
    expect(tokenizer.encode("bird ".repeat(200))).toHaveLength(77);
  });
});
