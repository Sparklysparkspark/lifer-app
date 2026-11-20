// The device side of the media cache: files through expo-file-system, a desktop hub's pinned
// certificate through our own native client, and the metered-connection check.
import { requireNativeModule } from "expo-modules-core";
import { Directory, File, Paths } from "expo-file-system";
import { MediaHttpError, type MediaFs, type MediaKind } from "./cache";

interface Native {
  download(o: { url: string; headers: Record<string, string>; certSha256: string; path: string; timeoutMs: number }): Promise<{
    status: number;
    bytes: number;
  }>;
  excludeFromBackup(path: string): boolean;
  isMetered(): Promise<boolean>;
}
const native = () => requireNativeModule<Native>("PinnedFetch");

const toPath = (uri: string): string => decodeURI(uri.replace(/^file:\/\//, "")).replace(/\/$/, "");
const strip = (uri: string): string => uri.replace(/\/$/, "");

export const mediaDirs = (): Record<MediaKind, string> => ({
  thumb: strip(new Directory(Paths.cache, "lifer", "thumb").uri),
  view: strip(new Directory(Paths.cache, "lifer", "view").uri),
  full: strip(new Directory(Paths.cache, "lifer", "full").uri),
  phone: strip(new Directory(Paths.document, "showcase").uri),
});

export const expoMediaFs: MediaFs = {
  async ensureDir(uri) {
    const dir = new Directory(uri);
    dir.create({ intermediates: true, idempotent: true });
    // The showcase is the person's own photos, rebuilt from the hub, so it stays out of cloud backups.
    if (uri.includes("/showcase")) native().excludeFromBackup(toPath(uri));
  },
  async remove(uri) {
    const file = new File(uri);
    if (file.exists) file.delete();
  },
  async download(target, dest) {
    if (target.certSha256) {
      const res = await native().download({
        url: target.url,
        headers: target.headers,
        certSha256: target.certSha256,
        path: toPath(dest),
        timeoutMs: 60_000,
      });
      if (res.status !== 200) throw new MediaHttpError(res.status);
      return res.bytes;
    }
    const file = new File(dest);
    try {
      await File.downloadFileAsync(target.url, file, { headers: target.headers, idempotent: true });
    } catch (e) {
      const status = /status (\d{3})/.exec(String((e as Error)?.message))?.[1];
      throw status ? new MediaHttpError(Number(status)) : e;
    }
    return file.size ?? 0;
  },
};

/** True on cellular or Low Data Mode; false when the check itself fails (the person is not blocked by it). */
export const isMetered = (): Promise<boolean> => native().isMetered().catch(() => false);
