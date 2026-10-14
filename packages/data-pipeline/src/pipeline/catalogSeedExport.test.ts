import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { seedSchemaToPublic } from "./catalogSeedExport.js";

async function rewrite(chunks: string[]): Promise<string> {
  let out = "";
  for await (const c of Readable.from(chunks.map((s) => Buffer.from(s))).pipe(seedSchemaToPublic())) out += c;
  return out;
}

describe("seedSchemaToPublic", () => {
  const dump = [
    "-- Data for Name: species; Type: TABLE DATA; Schema: seed_export; Owner: lifer",
    "ALTER TABLE seed_export.species DISABLE TRIGGER ALL;",
    "COPY seed_export.species (id, common_name) FROM stdin;",
    "1\tsee seed_export.species for Ä",
    "\\.",
    "ALTER TABLE seed_export.species ENABLE TRIGGER ALL;",
    "",
  ].join("\n");
  const expected = [
    "-- Data for Name: species; Type: TABLE DATA; Schema: public; Owner: lifer",
    "ALTER TABLE public.species DISABLE TRIGGER ALL;",
    "COPY public.species (id, common_name) FROM stdin;",
    "1\tsee seed_export.species for Ä",
    "\\.",
    "ALTER TABLE public.species ENABLE TRIGGER ALL;",
    "",
  ].join("\n");

  it("renames the schema in statements and comments, never in COPY data", async () => {
    expect(await rewrite([dump])).toBe(expected);
  });

  it("handles lines split across chunks", async () => {
    const bytes = Buffer.from(dump);
    const pieces: string[] = [];
    // Split mid-line and mid-character (Ä is two bytes) too: chunk boundaries are arbitrary.
    for (let i = 0; i < bytes.length; i += 7) pieces.push(bytes.subarray(i, i + 7).toString("latin1"));
    let out = "";
    const source = Readable.from(pieces.map((p) => Buffer.from(p, "latin1")));
    for await (const c of source.pipe(seedSchemaToPublic())) out += c;
    expect(out).toBe(expected);
  });

  it("keeps a last line with no newline", async () => {
    expect(await rewrite(["ALTER TABLE seed_export.x ENABLE TRIGGER ALL;"])).toBe(
      "ALTER TABLE public.x ENABLE TRIGGER ALL;",
    );
  });
});
