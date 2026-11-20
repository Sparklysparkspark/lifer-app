// Development only: a pretend hub that answers sync, vector and square requests from generated data,
// so a 60,000 photo sync can be run in the simulator with no desktop. Used by the sync stall benchmark.
import type { PairedHub, Transport } from "../connection/pair";
import type { MediaFs } from "../media/cache";

export const FAKE_BASE = "http://fake.lifer";
export const FAKE_PAIRED: PairedHub = {
  token: "fake",
  hub: { kind: "server", instanceId: "fake-hub", baseUrl: FAKE_BASE, fallbackUrls: [], deviceId: "fake", scopes: ["companion"] },
};
export const TOTAL = 60000;
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const EMPTY = '{"items":[],"purged":[],"last":null,"next":null}';

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
let vectors: string[] | null = null;
function vectorText(i: number): string {
  if (!vectors) {
    vectors = Array.from({ length: 8 }, (_, k) => {
      const bytes = new Uint8Array(1536);
      for (let j = 0; j < bytes.length; j++) bytes[j] = (j * 31 + k * 7) & (j % 2 ? 0x3b : 255);
      let s = "";
      for (let j = 0; j < bytes.length; j += 3) {
        const n = (bytes[j] << 16) | (bytes[j + 1] << 8) | bytes[j + 2];
        s += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
      }
      return s;
    });
  }
  return vectors[i % 8];
}

function answer(path: string): string {
  const [route, query = ""] = path.split("?");
  const q = new URLSearchParams(query);
  const offset = Number(q.get("since") ?? 0);
  const limit = Math.min(Number(q.get("limit") ?? 500), 500);
  const end = Math.min(TOTAL, offset + limit);
  const cursor = (n: number) => `{"since":"${n}","after":""}`;
  switch (route) {
    case "/sync/preferences":
      return '{"nameDisplay":null,"namingStyles":[],"sensitive":{"enabled":false,"added":[],"removed":[],"iucnStatuses":[]},"geoprivacy":{"spotDefault":"exact"},"regions":[]}';
    case "/sync/changes": {
      const items: string[] = [];
      for (let i = offset; i < end; i++)
        items.push(
          `{"id":"b${i}","deletedAt":null,"hiddenAt":null,"scientificName":"Genus${i % 3000} species${i % 3000}","takenAt":"20${18 + (i % 8)}-0${1 + (i % 9)}-1${i % 9}T07:00:00Z","tags":["bird"],"qualityRating":${i % 5},"locationLabel":"Place ${i % 50}","regionId":null,"photo":{"id":"bp${i}","width":800,"height":600,"kind":"image"}}`,
        );
      return `{"items":[${items.join(",")}],"purged":[],"last":${cursor(end)},"next":${end >= TOTAL ? "null" : cursor(end)}}`;
    }
    case "/sync/albums":
    case "/sync/trips":
    case "/sync/saved-spots":
    case "/sync/album-captures":
      return EMPTY;
    case "/companion/v1/albums/smart": {
      const albums = Array.from({ length: 12 }, (_, a) => {
        const ids = Array.from({ length: 800 }, (_, i) => `"b${a * 800 + i}"`);
        return `{"id":"smart${a}","captureIds":[${ids.join(",")}]}`;
      });
      return `{"albums":[${albums.join(",")}]}`;
    }
    case "/sync/user-species":
      return '{"items":[]}';
    case "/gallery":
      return '{"items":[],"nextCursor":null}';
    case "/companion/v1/model/vectors": {
      const items: string[] = [];
      for (let i = offset; i < end; i++)
        items.push(`{"id":"b${i}","updatedAt":"2026-01-01T00:00:00Z","vector":"${vectorText(i)}"}`);
      return `{"imageModelVersion":"v1","dimension":768,"items":[${items.join(",")}],"removed":[],"last":${cursor(end)},"next":${end >= TOTAL ? "null" : cursor(end)}}`;
    }
    default:
      return '{"available":false,"files":[]}';
  }
}

/** Answers requests for the pretend hub; everything else goes to the real transport. */
export const withFakeHub =
  (real: Transport): Transport =>
  async (req) => {
    if (!req.url.startsWith(FAKE_BASE)) return real(req);
    await delay(15);
    return { status: 200, body: answer(req.url.slice(`${FAKE_BASE}/api`.length)) };
  };

/** Pretend photo downloads from the pretend hub. */
export const withFakeMedia = (real: MediaFs): MediaFs => ({
  ...real,
  async download(target, dest) {
    if (!target.url.startsWith(FAKE_BASE)) return real.download(target, dest);
    await delay(5);
    return 20_000;
  },
});
