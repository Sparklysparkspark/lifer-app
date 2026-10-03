// Test helpers (not a test file): images generated at runtime, never committed, and a minimal tus
// client over app.inject.
import type { FastifyInstance } from "fastify";

/** Rewrites IFD0's PhotometricInterpretation of a little- or big-endian TIFF in place, e.g. to
 *  32803 (Color Filter Array) so an ordinary TIFF reads as sensor data. */
export function setTiffPhotometric(tiff: Buffer, value: number): Buffer {
  const out = Buffer.from(tiff);
  const le = out.toString("latin1", 0, 2) === "II";
  const u16 = (o: number) => (le ? out.readUInt16LE(o) : out.readUInt16BE(o));
  const u32 = (o: number) => (le ? out.readUInt32LE(o) : out.readUInt32BE(o));
  const ifd = u32(4);
  const count = u16(ifd);
  for (let i = 0; i < count; i++) {
    const e = ifd + 2 + i * 12;
    if (u16(e) !== 262) continue;
    if (le) out.writeUInt16LE(value, e + 8);
    else out.writeUInt16BE(value, e + 8);
    return out;
  }
  throw new Error("No PhotometricInterpretation tag");
}

export interface TusOptions {
  headers: Record<string, string>;
  cookies?: Record<string, string>;
  filename: string;
  filetype: string;
  chunkSize?: number;
  /** Stop after this many bytes, leaving the upload unfinished. */
  stopAt?: number;
}

const b64 = (v: string) => Buffer.from(v).toString("base64");

/** Creates a tus upload and PATCHes `bytes` in chunks. Returns the upload id and URL. */
export async function tusUpload(app: FastifyInstance, bytes: Buffer, opts: TusOptions): Promise<{ id: string; url: string; offset: number }> {
  const base = { ...opts.headers, "tus-resumable": "1.0.0" };
  const created = await app.inject({
    method: "POST",
    url: "/api/uploads/tus",
    headers: { ...base, "upload-length": String(bytes.length), "upload-metadata": [`filename ${b64(opts.filename)}`, ...(opts.filetype ? [`filetype ${b64(opts.filetype)}`] : [])].join(",") },
    cookies: opts.cookies,
  });
  if (created.statusCode !== 201) throw new Error(`create failed: ${created.statusCode} ${created.body}`);
  const url = String(created.headers.location);
  const id = url.split("/").pop()!;
  const offset = await tusPatch(app, url, bytes, 0, { ...opts, stopAt: opts.stopAt ?? bytes.length });
  return { id, url, offset };
}

/** PATCHes bytes from `from` up to opts.stopAt (default the end). Returns the new offset. */
export async function tusPatch(app: FastifyInstance, url: string, bytes: Buffer, from: number, opts: TusOptions): Promise<number> {
  const chunk = opts.chunkSize ?? 64 * 1024;
  const end = Math.min(opts.stopAt ?? bytes.length, bytes.length);
  let offset = from;
  while (offset < end) {
    const next = Math.min(offset + chunk, end);
    const res = await app.inject({
      method: "PATCH",
      url,
      headers: { ...opts.headers, "tus-resumable": "1.0.0", "upload-offset": String(offset), "content-type": "application/offset+octet-stream" },
      cookies: opts.cookies,
      payload: bytes.subarray(offset, next),
    });
    if (res.statusCode !== 204) throw new Error(`patch failed: ${res.statusCode} ${res.body}`);
    offset = Number(res.headers["upload-offset"]);
  }
  return offset;
}
