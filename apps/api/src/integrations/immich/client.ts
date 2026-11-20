// The few Immich API calls Lifer makes. Reads only, plus the species tags the user turned on:
// Lifer never deletes, moves or edits anything else in Immich.
import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { assertAllowedTarget, guardedDispatcher, viaDispatcher } from "../../lib/outboundGuard.js";

// Tag upsert and tag-asset routes, and the /api/server/version path, are all present from here.
export const MIN_IMMICH_VERSION = [1, 118, 0] as const;

export interface ImmichAsset {
  id: string;
  type: string;
  checksum: string;
  originalFileName: string;
  updatedAt: string;
  isTrashed?: boolean;
  exifInfo?: { fileSizeInByte?: number | null } | null;
}

export interface ImmichAlbum {
  id: string;
  albumName: string;
  assetCount: number;
}

/** A failure to show the user, already in plain words. */
export class ImmichError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = "ImmichError";
  }
}

export function versionText(v: { major: number; minor: number; patch: number }): string {
  return `${v.major}.${v.minor}.${v.patch}`;
}

export function isSupportedVersion(v: { major: number; minor: number; patch: number }): boolean {
  const [a, b, c] = MIN_IMMICH_VERSION;
  return v.major !== a ? v.major > a : v.minor !== b ? v.minor > b : v.patch >= c;
}

/** "https://photos.example.com/" or with "/api" typed on the end: the server's root, no slash. */
export function normalizeServerUrl(input: string): string | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  url.hash = "";
  url.search = "";
  return url
    .toString()
    .replace(/\/+$/, "")
    .replace(/\/api$/, "");
}

// Server addresses are typed by the user, so loopback and cloud metadata addresses are refused.
const dispatcher = guardedDispatcher();

export class ImmichClient {
  constructor(
    readonly baseUrl: string,
    private readonly apiKey: string,
  ) {}

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const url = new URL(`${this.baseUrl}/api${path}`);
    let res: Response;
    try {
      await assertAllowedTarget(url);
      res = await fetch(url, {
        ...init,
        ...viaDispatcher(dispatcher),
        headers: { "x-api-key": this.apiKey, accept: "application/json", ...init.headers },
      });
    } catch (err) {
      if ((err as Error).name === "AbortError") throw err;
      throw new ImmichError("Couldn't reach the Immich server. Check the address and that it's running.");
    }
    if (res.status === 401) throw new ImmichError("Immich didn't accept the API key.", 401);
    if (res.status === 403)
      throw new ImmichError("The API key isn't allowed to do this. Give it album, asset and tag permissions.", 403);
    if (!res.ok) throw new ImmichError("Immich couldn't answer. Try again later.", res.status);
    return res;
  }

  private async json<T>(path: string, init?: RequestInit): Promise<T> {
    return (await (await this.request(path, init)).json()) as T;
  }

  version(): Promise<{ major: number; minor: number; patch: number }> {
    return this.json("/server/version");
  }

  /** Proves the key works (the version route answers without one). */
  me(): Promise<{ id: string; email: string }> {
    return this.json("/users/me");
  }

  albums(): Promise<ImmichAlbum[]> {
    return this.json("/albums");
  }

  albumAssets(albumId: string, signal?: AbortSignal): Promise<ImmichAlbum & { assets: ImmichAsset[] }> {
    return this.json(`/albums/${encodeURIComponent(albumId)}`, { signal });
  }

  async downloadOriginal(assetId: string, dest: string, signal?: AbortSignal): Promise<void> {
    const res = await this.request(`/assets/${encodeURIComponent(assetId)}/original`, {
      signal,
      headers: { accept: "application/octet-stream" },
    });
    if (!res.body) throw new ImmichError("Immich sent an empty file.");
    await pipeline(Readable.fromWeb(res.body as WebReadableStream), createWriteStream(dest), { signal });
  }

  tags(): Promise<{ id: string; value: string }[]> {
    return this.json("/tags");
  }

  /** Creates the tags that don't exist yet; answers every one with its id. */
  upsertTags(values: string[]): Promise<{ id: string; value: string }[]> {
    return this.json("/tags", { method: "PUT", body: JSON.stringify({ tags: values }), headers: JSON_BODY });
  }

  async tagAssets(tagId: string, assetIds: string[]): Promise<void> {
    await this.request(`/tags/${encodeURIComponent(tagId)}/assets`, {
      method: "PUT",
      body: JSON.stringify({ ids: assetIds }),
      headers: JSON_BODY,
    });
  }

  async untagAssets(tagId: string, assetIds: string[]): Promise<void> {
    await this.request(`/tags/${encodeURIComponent(tagId)}/assets`, {
      method: "DELETE",
      body: JSON.stringify({ ids: assetIds }),
      headers: JSON_BODY,
    });
  }
}

const JSON_BODY = { "content-type": "application/json" };
