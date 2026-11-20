// What kind of shot each photo is, on two independent axes: its action (flying, behaviour, at rest)
// and its framing (close, environmental). Each axis is decided between its own options only, by
// which option's descriptions take the larger share of the photo's softmaxed CLIP similarity.
// Shared by Stats' Photography DNA and the Gallery's ?action= / ?framing= filters, so a Stats
// percentage and the photos it opens always agree.
import { pool } from "@lifer/core/db.js";
import { cosineSimilarity } from "@lifer/core/species/embeddings.js";
import { embedTextVectors, isTextModelDownloaded } from "@lifer/core/species/textEmbedding.js";
import { EMBEDDING_MODEL_VERSION } from "@lifer/core/config.js";
import { SHOT_ACTIONS, SHOT_FRAMINGS, type ShotAction, type ShotFraming } from "@lifer/shared";

// At rest covers every ordinary calm pose, so a perched or swimming bird never falls into the
// nearer of the other two.
export const ACTION_PROMPTS: Record<ShotAction, string[]> = {
  flying: [
    "a bird flying in the sky",
    "a bird in flight with its wings spread",
    "a flying bird over water",
    "a butterfly flying in the air",
    "a bat flying",
  ],
  behavior: [
    "an animal eating food",
    "a bird catching a fish",
    "a predator hunting and chasing its prey",
    "two animals fighting each other",
    "young animals playing and wrestling together",
    "a bird bathing and splashing in water",
    "an animal leaping through the air to pounce on prey",
    "a bird feeding its chick",
  ],
  resting: [
    "a bird perched on a branch",
    "an animal standing still and looking at the camera",
    "a duck swimming calmly on a lake",
    "an animal walking through grass",
    "an animal lying down resting",
    "a woodpecker clinging to a tree trunk",
    "a bird standing on the ground",
    "an insect sitting on a leaf",
  ],
};

export const FRAMING_PROMPTS: Record<ShotFraming, string[]> = {
  close: [
    "a close-up portrait of a wild animal filling the frame",
    "a tight headshot of a bird",
    "a close-up of an insect on a flower",
    "a large animal filling most of the photo",
  ],
  environmental: [
    "a small animal far away in a wide landscape",
    "a small bird in a large scene of its habitat",
    "a tiny animal silhouetted on a distant ridge",
    "a small bird hidden among leaves and branches",
    "a wide view of nature with a small animal in it",
  ],
};

// CLIP's own logit scale, which turns cosine similarities into a sharp reading.
const LOGIT_SCALE = 100;

export interface ShotType {
  action: ShotAction;
  framing: ShotFraming;
}

/** The option whose prompts take the largest share of the photo's softmaxed similarities. */
function pick<K extends string>(sims: number[], keys: K[]): K {
  const max = Math.max(...sims);
  const share = new Map<K, number>();
  sims.forEach((sim, i) => share.set(keys[i], (share.get(keys[i]) ?? 0) + Math.exp(LOGIT_SCALE * (sim - max))));
  return [...share].sort((a, b) => b[1] - a[1])[0][0];
}

// Reading every vector is the slow part, so a user's answer is kept briefly: opening the Gallery
// from Stats reuses the run Stats just did.
const CACHE_MS = 5 * 60_000;
const cache = new Map<string, { at: number; types: Promise<Map<string, ShotType>> }>();

/** Each of the user's captures with a vector, mapped to its action and framing. */
export function classifyShotTypes(userId: string): Promise<Map<string, ShotType>> {
  const hit = cache.get(userId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.types;
  const types = (async () => {
    const res = await pool.query<{ capture_id: string; embedding: number[] }>(
      `SELECT ce.capture_id, ce.embedding FROM capture_embeddings ce
         JOIN captures c ON c.id = ce.capture_id
        WHERE c.user_id = $1 AND ce.model_version = $2`,
      [userId, EMBEDDING_MODEL_VERSION],
    );
    const result = new Map<string, ShotType>();
    // Without the text model there's no reading, as with no vectors: Stats shows no shot types.
    if (res.rows.length === 0 || !isTextModelDownloaded()) return result;
    const actions = SHOT_ACTIONS.flatMap((key) => ACTION_PROMPTS[key].map((prompt) => ({ key, prompt })));
    const framings = SHOT_FRAMINGS.flatMap((key) => FRAMING_PROMPTS[key].map((prompt) => ({ key, prompt })));
    const vectors = await embedTextVectors([...actions, ...framings].map((f) => f.prompt));
    const actionKeys = actions.map((a) => a.key);
    const framingKeys = framings.map((f) => f.key);
    for (const row of res.rows) {
      const sims = vectors.map((v) => cosineSimilarity(v, row.embedding));
      result.set(row.capture_id, {
        action: pick(sims.slice(0, actions.length), actionKeys),
        framing: pick(sims.slice(actions.length), framingKeys),
      });
    }
    return result;
  })();
  types.catch(() => cache.delete(userId));
  cache.set(userId, { at: Date.now(), types });
  return types;
}

/** The ids with one of `actions` (any, when empty) and one of `framings` (any, when empty): OR
 *  within an axis, AND across them. */
export function matchShotTypes(
  types: ReadonlyMap<string, ShotType>,
  actions: readonly ShotAction[],
  framings: readonly ShotFraming[],
): string[] {
  return [...types]
    .filter(
      ([, t]) =>
        (actions.length === 0 || actions.includes(t.action)) && (framings.length === 0 || framings.includes(t.framing)),
    )
    .map(([id]) => id);
}

/** The user's captures of a shot type (see matchShotTypes). */
export async function captureIdsOfShotTypes(
  userId: string,
  actions: readonly ShotAction[],
  framings: readonly ShotFraming[],
): Promise<string[]> {
  return matchShotTypes(await classifyShotTypes(userId), actions, framings);
}
