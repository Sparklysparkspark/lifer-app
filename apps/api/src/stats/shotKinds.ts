// What kind of shot each photo is (portrait, flight, behaviour, environmental), by which kind's
// descriptions its CLIP vector is closest to. Shared by Stats' Photography DNA and the Gallery's
// ?shotKind= filter, so a Stats percentage and the photos it opens always agree.
import { pool } from "@lifer/core/db.js";
import { cosineSimilarity } from "@lifer/core/species/embeddings.js";
import { embedTextVectors } from "@lifer/core/species/textEmbedding.js";
import { EMBEDDING_MODEL_VERSION } from "@lifer/core/config.js";

// Several descriptions per kind, each kind scoring the share of the photo's softmaxed similarity
// its descriptions take. Portrait and environmental describe ordinary perched, standing and
// swimming shots too, so those don't fall into the nearest of the other kinds.
export const SHOT_KINDS = [
  {
    key: "portrait",
    prompts: [
      "a close-up portrait of a wild animal",
      "a bird perched on a branch",
      "an animal standing and looking at the camera",
      "an animal walking through grass",
      "a woodpecker clinging to a tree trunk",
      "a close-up of an insect on a flower",
      "a bird standing on the ground",
    ],
  },
  {
    key: "flight",
    prompts: ["a bird flying in the sky", "a bird in flight with its wings spread", "a flying bird over water"],
  },
  {
    key: "behavior",
    prompts: [
      "an animal eating food",
      "a bird catching a fish",
      "young animals playing and wrestling together",
      "a bird bathing and splashing in water",
      "an animal leaping through the air to pounce on prey",
    ],
  },
  {
    key: "environmental",
    prompts: [
      "a small animal far away in a wide landscape",
      "a duck swimming on a lake",
      "a small bird hidden among leaves and branches",
      "a tiny animal silhouetted on a distant ridge",
    ],
  },
] as const;
// CLIP's own logit scale, which turns cosine similarities into a sharp reading.
const LOGIT_SCALE = 100;
export type ShotKind = (typeof SHOT_KINDS)[number]["key"];
export const isShotKind = (value: string): value is ShotKind => SHOT_KINDS.some((k) => k.key === value);

// Reading every vector is the slow part, so a user's answer is kept briefly: opening the Gallery
// from Stats reuses the run Stats just did.
const CACHE_MS = 5 * 60_000;
const cache = new Map<string, { at: number; kinds: Promise<Map<string, ShotKind>> }>();

/** Each of the user's captures with a vector, mapped to its kind of shot. */
export function classifyShotKinds(userId: string): Promise<Map<string, ShotKind>> {
  const hit = cache.get(userId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.kinds;
  const kinds = (async () => {
    const res = await pool.query<{ capture_id: string; embedding: number[] }>(
      `SELECT ce.capture_id, ce.embedding FROM capture_embeddings ce
         JOIN captures c ON c.id = ce.capture_id
        WHERE c.user_id = $1 AND ce.model_version = $2`,
      [userId, EMBEDDING_MODEL_VERSION],
    );
    const result = new Map<string, ShotKind>();
    if (res.rows.length === 0) return result;
    const flat = SHOT_KINDS.flatMap((kind) => kind.prompts.map((prompt) => ({ kind: kind.key, prompt })));
    const vectors = await embedTextVectors(flat.map((f) => f.prompt));
    for (const row of res.rows) {
      const sims = vectors.map((v) => cosineSimilarity(v, row.embedding));
      const max = Math.max(...sims);
      const share = new Map<ShotKind, number>();
      sims.forEach((sim, i) =>
        share.set(flat[i].kind, (share.get(flat[i].kind) ?? 0) + Math.exp(LOGIT_SCALE * (sim - max))),
      );
      result.set(row.capture_id, [...share].sort((a, b) => b[1] - a[1])[0][0]);
    }
    return result;
  })();
  kinds.catch(() => cache.delete(userId));
  cache.set(userId, { at: Date.now(), kinds });
  return kinds;
}

/** The ids of the user's captures of one kind of shot. */
export async function captureIdsOfShotKind(userId: string, kind: ShotKind): Promise<string[]> {
  return [...(await classifyShotKinds(userId))].filter(([, k]) => k === kind).map(([id]) => id);
}
