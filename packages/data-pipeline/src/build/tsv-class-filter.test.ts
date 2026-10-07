// TsvClassFilter: keeps whole rows of the wanted classes, whatever the chunk boundaries.
import { describe, expect, it } from "vitest";
import { TsvClassFilter } from "./tsv-class-filter.js";

const HEADER = "species\tdecimallatitude\tdecimallongitude\tclass\tyear\tbasisofrecord\tweek\trecord_count";
const ROWS = [
  "Gadus morhua\t55.1\t3.2\tTeleostei\t2020\tHUMAN_OBSERVATION\t12\t3",
  "Turdus merula\t51.0\t0.1\tAves\t2021\tHUMAN_OBSERVATION\t5\t40",
  "Tursiops truncatus\t43.0\t5.0\tMammalia\t2019\tHUMAN_OBSERVATION\t30\t1",
  "Raja clavata\t50.2\t-4.1\tElasmobranchii\t\tPRESERVED_SPECIMEN\t\t2",
  "Bellis perennis\t51.5\t-0.1\tMagnoliopsida\t2022\tHUMAN_OBSERVATION\t20\t7",
];
const TEXT = [HEADER, ...ROWS].join("\n") + "\n";

function run(chunkSize: number, text = TEXT): { header: string[] | null; rows: string[][] } {
  const filter = new TsvClassFilter(["Teleostei", "Elasmobranchii", "Mammalia"]);
  const bytes = Buffer.from(text, "utf8");
  const rows: string[][] = [];
  for (let i = 0; i < bytes.length; i += chunkSize) rows.push(...filter.push(bytes.subarray(i, i + chunkSize)));
  rows.push(...filter.end());
  return { header: filter.header, rows };
}

describe("TsvClassFilter", () => {
  it("reads the header and keeps only the wanted classes' rows, split into columns", () => {
    const { header, rows } = run(1 << 16);
    expect(header).toEqual(HEADER.split("\t"));
    expect(rows.map((r) => r[0])).toEqual(["Gadus morhua", "Tursiops truncatus", "Raja clavata"]);
    expect(rows[2]).toEqual(["Raja clavata", "50.2", "-4.1", "Elasmobranchii", "", "PRESERVED_SPECIMEN", "", "2"]);
  });

  it("gives the same rows however the stream is cut, even mid-character", () => {
    const text = TEXT + "Pomatoschistus minutus\t57.0\t11.0\tTeleostei\t2018\tHUMAN_OBSERVATION\t1\t1\n";
    const whole = run(1 << 16, text).rows;
    for (const size of [1, 3, 7, 50]) expect(run(size, text).rows).toEqual(whole);
    // A non-ASCII name split across chunks still decodes.
    const accented = TEXT + "Blennius ocellarisé\t1\t1\tTeleostei\t2000\tOBSERVATION\t1\t1";
    expect(run(2, accented).rows.at(-1)![0]).toBe("Blennius ocellarisé");
  });

  it("keeps a last line without a newline, tolerates CRLF, and skips blank lines", () => {
    const text = [HEADER, ROWS[0], "", ROWS[2]].join("\r\n");
    expect(run(1 << 16, text).rows.map((r) => r[0])).toEqual(["Gadus morhua", "Tursiops truncatus"]);
  });
});
