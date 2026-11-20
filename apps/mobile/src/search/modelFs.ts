// The device side of the model download: files in the app's documents folder (kept out of backups,
// since the hub can serve them again), ranges through the pinned client for a desktop and the system
// trust store for a server, and a streamed SHA-256 so a 125 MB file never sits in memory.
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { requireNativeModule } from "expo-modules-core";
import { Directory, File, Paths } from "expo-file-system";
import { yieldNow } from "../sync/yield";
import type { DownloadTarget } from "../media/cache";
import type { ModelFs } from "./modelDownload";

interface Native {
  download(o: {
    url: string;
    headers: Record<string, string>;
    certSha256: string;
    path: string;
    timeoutMs: number;
  }): Promise<{ status: number; bytes: number }>;
  excludeFromBackup(path: string): boolean;
}
const native = () => requireNativeModule<Native>("PinnedFetch");

const toPath = (uri: string): string => decodeURI(uri.replace(/^file:\/\//, "")).replace(/\/$/, "");
// A JS hash of 128 KB is a few ms; it gets a turn of the screen after every block.
const HASH_BLOCK = 128 * 1024;

const folder = () => new Directory(Paths.document, "models", "search");
const file = (name: string) => new File(folder(), name);

/** Where a downloaded model file lives, as a plain path (what the runtime opens). */
export const modelFilePath = (name: string): string => toPath(file(name).uri);

export const expoModelFs: ModelFs = {
  async prepare() {
    folder().create({ intermediates: true, idempotent: true });
    native().excludeFromBackup(toPath(folder().uri));
  },
  async size(name) {
    const f = file(name);
    return f.exists ? (f.size ?? 0) : null;
  },
  async fetchRange(target: DownloadTarget, from, to, name) {
    const chunk = file(`${name}.chunk`);
    if (chunk.exists) chunk.delete();
    const headers = { ...target.headers, range: `bytes=${from}-${to}` };
    let status = 206;
    if (target.certSha256) {
      const res = await native().download({
        url: target.url,
        headers,
        certSha256: target.certSha256,
        path: toPath(chunk.uri),
        timeoutMs: 60_000,
      });
      status = res.status;
    } else {
      try {
        await File.downloadFileAsync(target.url, chunk, { headers, idempotent: true });
      } catch (e) {
        const code = /status (\d{3})/.exec(String((e as Error)?.message))?.[1];
        if (!code) throw e;
        status = Number(code);
      }
    }
    if (status !== 206 && status !== 200) return status;
    const part = file(name);
    const got = chunk.size ?? 0;
    // A server that ignored the range sent the whole file: only a start can take it.
    status = got === to - from + 1 ? 206 : 200;
    if (from === 0) {
      if (part.exists) part.delete();
      chunk.move(part);
      return status;
    }
    if (status === 200) {
      chunk.delete();
      return status;
    }
    const out = part.open();
    try {
      out.offset = out.size;
      await out.writeBytes(await chunk.bytes());
    } finally {
      out.close();
      chunk.delete();
    }
    return status;
  },
  async sha256(name) {
    const hash = sha256.create();
    const handle = file(name).open();
    try {
      for (;;) {
        const block = await handle.readBytes(HASH_BLOCK);
        if (block.length === 0) break;
        hash.update(block);
        await yieldNow();
      }
    } finally {
      handle.close();
    }
    return bytesToHex(hash.digest());
  },
  async rename(from, to) {
    file(from).move(file(to));
  },
  async remove(name) {
    const f = file(name);
    if (f.exists) f.delete();
  },
  async clear() {
    const dir = folder();
    if (dir.exists) dir.delete();
  },
};
