// Picks the rows of some taxonomic classes out of a GBIF country download as it streams, working
// on the raw bytes: a download is tens of GB of mostly birds and plants, and decoding every line
// into a string (or piping through grep, ~30 MB/s for macOS's) would cost far more than unzip.
const NEWLINE = 10;
const TAB = 9;

export class TsvClassFilter {
  header: string[] | null = null;
  private classColumn = -1;
  private carry: Buffer | null = null;
  private readonly wanted: Set<string>;

  constructor(classes: Iterable<string>) {
    this.wanted = new Set(classes);
  }

  /** The wanted rows completed by this chunk, split into columns. */
  push(chunk: Buffer): string[][] {
    const buf = this.carry ? Buffer.concat([this.carry, chunk]) : chunk;
    const rows: string[][] = [];
    let start = 0;
    for (;;) {
      const end = buf.indexOf(NEWLINE, start);
      if (end === -1) break;
      this.line(buf, start, end, rows);
      start = end + 1;
    }
    this.carry = start < buf.length ? Buffer.from(buf.subarray(start)) : null;
    return rows;
  }

  /** The last line, if the input didn't end with a newline. */
  end(): string[][] {
    const rows: string[][] = [];
    if (this.carry) this.line(this.carry, 0, this.carry.length, rows);
    this.carry = null;
    return rows;
  }

  private line(buf: Buffer, start: number, end: number, rows: string[][]): void {
    // Tolerate CRLF line ends.
    const stop = end > start && buf[end - 1] === 13 ? end - 1 : end;
    if (stop === start) return;
    if (!this.header) {
      this.header = buf.toString("utf8", start, stop).split("\t");
      this.classColumn = this.header.indexOf("class");
      if (this.classColumn === -1) throw new Error("The download has no class column");
      return;
    }
    let from = start;
    for (let i = 0; i < this.classColumn; i++) {
      const tab = buf.indexOf(TAB, from);
      if (tab === -1 || tab >= stop) return;
      from = tab + 1;
    }
    let to = buf.indexOf(TAB, from);
    if (to === -1 || to > stop) to = stop;
    // Class names are ASCII, so latin1 decodes them exactly and cheaply.
    if (!this.wanted.has(buf.toString("latin1", from, to))) return;
    rows.push(buf.toString("utf8", start, stop).split("\t"));
  }
}
