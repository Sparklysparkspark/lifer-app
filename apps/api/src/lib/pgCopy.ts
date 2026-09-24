// Streaming helpers for Postgres COPY ... FROM STDIN (pg-copy-streams), used to bulk-load large
// files without ever holding their rows in JS memory.
import { finished } from "node:stream/promises";
import type { PoolClient } from "pg";
import { from as copyFrom } from "pg-copy-streams";

const FLUSH_BYTES = 256 * 1024;

// Waits for one drain (or the stream erroring), removing both listeners itself regardless of
// which one fires. A large table (region_species is 1.9M+ rows) calls this once per 256KB
// chunk; racing two `once()` promises here used to leave the LOSING side's listener attached
// forever (Node's `once()` never cleans up the event that didn't fire), leaking one "error"
// listener per flush call and tripping MaxListenersExceededWarning on a big enough table.
function waitForDrainOrError(stream: NodeJS.WritableStream): Promise<void> {
  return new Promise((resolve) => {
    const onDrain = () => cleanup(resolve);
    const onError = () => cleanup(resolve);
    function cleanup(done: () => void) {
      stream.off("drain", onDrain);
      stream.off("error", onError);
      done();
    }
    stream.once("drain", onDrain);
    stream.once("error", onError);
  });
}

/** Runs `COPY ... FROM STDIN` and writes every chunk from `source` into it, respecting
 * backpressure. Small chunks are coalesced so one tiny write per row doesn't dominate. */
export async function copyInto(client: PoolClient, copySql: string, source: AsyncIterable<Buffer | string>): Promise<void> {
  const stream = client.query(copyFrom(copySql));
  let failure: Error | null = null;
  stream.on("error", (err: Error) => (failure = err));
  let pending: Buffer[] = [];
  let pendingBytes = 0;

  const flush = async () => {
    if (pendingBytes === 0) return;
    const buf = pending.length === 1 ? pending[0] : Buffer.concat(pending, pendingBytes);
    pending = [];
    pendingBytes = 0;
    if (!stream.write(buf)) await waitForDrainOrError(stream);
    if (failure) throw failure;
  };

  try {
    for await (const chunk of source) {
      if (failure) throw failure;
      const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      pending.push(buf);
      pendingBytes += buf.length;
      if (pendingBytes >= FLUSH_BYTES) await flush();
    }
    await flush();
    stream.end();
    await finished(stream);
  } catch (err) {
    // Destroying the stream makes pg abort the COPY so the connection is usable for ROLLBACK.
    stream.destroy(err as Error);
    throw failure ?? err;
  }
  if (failure) throw failure;
}

/** Splits a byte stream into lines (without the trailing "\n"). */
export async function* readLines(source: AsyncIterable<Buffer>): AsyncGenerator<Buffer> {
  let rest: Buffer | null = null;
  for await (const chunk of source) {
    let buf: Buffer = rest ? Buffer.concat([rest, chunk]) : chunk;
    let start = 0;
    let nl: number;
    while ((nl = buf.indexOf(0x0a, start)) !== -1) {
      yield buf.subarray(start, nl);
      start = nl + 1;
    }
    rest = start < buf.length ? Buffer.from(buf.subarray(start)) : null;
    buf = Buffer.alloc(0);
  }
  if (rest && rest.length > 0) yield rest;
}

/** Escapes a value for COPY's text format. */
export function copyTextField(value: string | null): string {
  if (value == null) return "\\N";
  return value.replace(/\\/g, "\\\\").replace(/\t/g, "\\t").replace(/\n/g, "\\n").replace(/\r/g, "\\r");
}
