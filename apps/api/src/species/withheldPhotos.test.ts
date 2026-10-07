// The background fetch of photos packs can't include: what it fetches and when it stops. iNaturalist,
// the database and the install setting are all mocked; the selection query has its own
// integration test (withheldPhotos.integration.test.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const lazy = vi.hoisted(() => {
  class PersistentRateLimitError extends Error {}
  return {
    PersistentRateLimitError,
    fetchINaturalistTaxon: vi.fn(),
    fetchFirstTaxonPhoto: vi.fn(),
    downloadAndCacheImage: vi.fn(),
    persistMainPhotoIfMissing: vi.fn(),
    // The full enrichment and the gallery: the worker must never use them.
    enrichSpecies: vi.fn(),
    fetchAnyGallery: vi.fn(),
    persistEnrichment: vi.fn(),
    persistGallery: vi.fn(),
    toGalleryPhoto: (p: { medium_url: string; license_code: string | null; attribution: string }) => ({
      photoUrl: p.medium_url,
      credit: p.attribution,
      license: p.license_code ?? "all-rights-reserved",
    }),
  };
});
vi.mock("@lifer/core/species/lazyEnrich.js", () => lazy);
vi.mock("@lifer/core/db.js", () => ({ pool: {} }));
const settings = vi.hoisted(() => ({ value: null as boolean | null }));
vi.mock("../lib/installSettings.js", () => ({
  getInstallSetting: vi.fn(async () => settings.value),
  setInstallSetting: vi.fn(async (_db: unknown, _key: string, value: boolean) => {
    settings.value = value;
  }),
}));

const {
  DAILY_LIMIT,
  MAX_CONSECUTIVE_FAILURES,
  PAUSE_BETWEEN_SPECIES_MS,
  fetchWithheldPhoto,
  isWithheldPhotoFetchEnabled,
  runWithheldPhotoPass,
  setWithheldPhotoFetchEnabled,
  startWithheldPhotoFetch,
  stopWithheldPhotoFetch,
  withheldPhotoFetchIdle,
} = await import("./withheldPhotos.js");
type PassDeps = import("./withheldPhotos.js").PassDeps;
type WithheldSpecies = import("./withheldPhotos.js").WithheldSpecies;

const sp = (n: number): WithheldSpecies => ({ id: `species-${n}`, scientific_name: `Testus number${n}` });

// A queue of species that empties as they're stamped, like the real query.
function fakeDeps(species: WithheldSpecies[], overrides: Partial<PassDeps> = {}) {
  const left = [...species];
  const log: string[] = [];
  const deps: PassDeps = {
    isEnabled: vi.fn(async () => true),
    nextBatch: vi.fn(async (limit: number) => left.slice(0, limit)),
    attemptsInLastDay: vi.fn(async () => 0),
    fetchPhoto: vi.fn(async (s: WithheldSpecies) => {
      log.push(`fetch ${s.id}`);
      return "stored" as const;
    }),
    markChecked: vi.fn(async (id: string) => {
      log.push(`checked ${id}`);
      const i = left.findIndex((s) => s.id === id);
      if (i >= 0) left.splice(i, 1);
    }),
    sleep: vi.fn(async (ms: number) => {
      log.push(`sleep ${ms}`);
    }),
    ...overrides,
  };
  return { deps, log };
}

const never = () => new AbortController().signal;

beforeEach(() => {
  vi.clearAllMocks();
  settings.value = null;
});

describe("runWithheldPhotoPass", () => {
  it("fetches one species at a time, stamps each attempt and pauses between them", async () => {
    const { deps, log } = fakeDeps([sp(1), sp(2)]);

    const result = await runWithheldPhotoPass(deps, never());

    expect(result).toEqual({ stored: 2, none: 0, failed: 0, end: "done" });
    expect(log).toEqual([
      "fetch species-1",
      "checked species-1",
      `sleep ${PAUSE_BETWEEN_SPECIES_MS}`,
      "fetch species-2",
      "checked species-2",
      `sleep ${PAUSE_BETWEEN_SPECIES_MS}`,
    ]);
  });

  it("stops when iNaturalist keeps rate-limiting, without stamping that species", async () => {
    const { deps, log } = fakeDeps([sp(1), sp(2), sp(3)], {
      fetchPhoto: vi.fn(async (s: WithheldSpecies) => {
        if (s.id === "species-2") throw new lazy.PersistentRateLimitError("429");
        return "stored" as const;
      }),
    });

    const result = await runWithheldPhotoPass(deps, never());

    expect(result.end).toBe("rate-limited");
    expect(log.filter((l) => l.startsWith("checked"))).toEqual(["checked species-1"]);
    expect(deps.fetchPhoto).toHaveBeenCalledTimes(2);
  });

  it("stamps a species whose fetch failed, so it isn't tried again right away, and goes on", async () => {
    const { deps, log } = fakeDeps([sp(1), sp(2)], {
      fetchPhoto: vi.fn(async (s: WithheldSpecies) => {
        if (s.id === "species-1") throw new Error("socket hang up");
        return "none" as const;
      }),
    });

    const result = await runWithheldPhotoPass(deps, never());

    expect(result).toEqual({ stored: 0, none: 1, failed: 1, end: "done" });
    expect(log.filter((l) => l.startsWith("checked"))).toEqual(["checked species-1", "checked species-2"]);
  });

  it("gives up for now after several failures in a row", async () => {
    const species = Array.from({ length: MAX_CONSECUTIVE_FAILURES + 3 }, (_, i) => sp(i));
    const { deps } = fakeDeps(species, { fetchPhoto: vi.fn(async () => "failed" as const) });

    const result = await runWithheldPhotoPass(deps, never());

    expect(result.end).toBe("failing");
    expect(deps.fetchPhoto).toHaveBeenCalledTimes(MAX_CONSECUTIVE_FAILURES);
  });

  it("does nothing while the setting is off", async () => {
    const { deps } = fakeDeps([sp(1)], { isEnabled: vi.fn(async () => false) });

    const result = await runWithheldPhotoPass(deps, never());

    expect(result.end).toBe("disabled");
    expect(deps.fetchPhoto).not.toHaveBeenCalled();
    expect(deps.markChecked).not.toHaveBeenCalled();
  });

  it("stops at the next species once the setting is turned off", async () => {
    let enabled = true;
    const { deps } = fakeDeps([sp(1), sp(2), sp(3)], {
      isEnabled: vi.fn(async () => enabled),
      fetchPhoto: vi.fn(async () => {
        enabled = false;
        return "stored" as const;
      }),
    });

    const result = await runWithheldPhotoPass(deps, never());

    expect(result).toEqual({ stored: 1, none: 0, failed: 0, end: "disabled" });
  });

  it("keeps to the daily limit, counting attempts made earlier in the day", async () => {
    const { deps } = fakeDeps([sp(1), sp(2), sp(3)], { attemptsInLastDay: vi.fn(async () => DAILY_LIMIT - 2) });

    const result = await runWithheldPhotoPass(deps, never());

    expect(result.end).toBe("daily-limit");
    expect(deps.fetchPhoto).toHaveBeenCalledTimes(2);
  });

  it("stops when aborted", async () => {
    const controller = new AbortController();
    const { deps } = fakeDeps([sp(1), sp(2)], {
      sleep: vi.fn(async () => controller.abort()),
    });

    const result = await runWithheldPhotoPass(deps, controller.signal);

    expect(result).toEqual({ stored: 1, none: 0, failed: 0, end: "stopped" });
  });
});

describe("fetchWithheldPhoto", () => {
  const photo = {
    medium_url: "https://inaturalist-open-data.s3.amazonaws.com/photos/7/medium.jpg",
    license_code: null,
    attribution: "(c) Someone",
  };

  it("fetches only the main photo and stores it with its credit and license", async () => {
    lazy.fetchINaturalistTaxon.mockResolvedValue({ id: 7, defaultPhoto: photo });
    lazy.downloadAndCacheImage.mockResolvedValue({ displayPath: "/d/species-1.webp", thumbPath: "/t/species-1.webp" });
    lazy.persistMainPhotoIfMissing.mockResolvedValue(true);

    expect(await fetchWithheldPhoto(sp(1))).toBe("stored");

    expect(lazy.fetchINaturalistTaxon).toHaveBeenCalledWith("Testus number1");
    expect(lazy.downloadAndCacheImage).toHaveBeenCalledTimes(1);
    expect(lazy.downloadAndCacheImage).toHaveBeenCalledWith(photo.medium_url, "species-1");
    expect(lazy.persistMainPhotoIfMissing).toHaveBeenCalledWith("species-1", {
      photoUrl: photo.medium_url,
      credit: "(c) Someone",
      license: "all-rights-reserved",
      displayPath: "/d/species-1.webp",
      thumbPath: "/t/species-1.webp",
    });
    expect(lazy.fetchFirstTaxonPhoto).not.toHaveBeenCalled();
    for (const gallery of [lazy.enrichSpecies, lazy.fetchAnyGallery, lazy.persistEnrichment, lazy.persistGallery]) {
      expect(gallery).not.toHaveBeenCalled();
    }
  });

  it("falls back to the taxon's first photo when no default photo is flagged", async () => {
    lazy.fetchINaturalistTaxon.mockResolvedValue({ id: 7, defaultPhoto: null });
    lazy.fetchFirstTaxonPhoto.mockResolvedValue(photo);
    lazy.downloadAndCacheImage.mockResolvedValue({ displayPath: "/d.webp", thumbPath: "/t.webp" });
    lazy.persistMainPhotoIfMissing.mockResolvedValue(true);

    expect(await fetchWithheldPhoto(sp(1))).toBe("stored");
    expect(lazy.fetchFirstTaxonPhoto).toHaveBeenCalledWith(7);
  });

  it("stores nothing when the download fails, rather than a link that won't work offline", async () => {
    lazy.fetchINaturalistTaxon.mockResolvedValue({ id: 7, defaultPhoto: photo });
    lazy.downloadAndCacheImage.mockResolvedValue(null);

    expect(await fetchWithheldPhoto(sp(1))).toBe("failed");
    expect(lazy.persistMainPhotoIfMissing).not.toHaveBeenCalled();
  });

  it("reports none when iNaturalist has no such taxon or no photo", async () => {
    lazy.fetchINaturalistTaxon.mockResolvedValueOnce(null);
    expect(await fetchWithheldPhoto(sp(1))).toBe("none");

    lazy.fetchINaturalistTaxon.mockResolvedValueOnce({ id: 7, defaultPhoto: null });
    lazy.fetchFirstTaxonPhoto.mockResolvedValueOnce(null);
    expect(await fetchWithheldPhoto(sp(1))).toBe("none");
    expect(lazy.downloadAndCacheImage).not.toHaveBeenCalled();
  });
});

describe("the setting", () => {
  it("is on until turned off", async () => {
    expect(await isWithheldPhotoFetchEnabled()).toBe(true);
    settings.value = false;
    expect(await isWithheldPhotoFetchEnabled()).toBe(false);
    settings.value = true;
    expect(await isWithheldPhotoFetchEnabled()).toBe(true);
  });
});

describe("startWithheldPhotoFetch", () => {
  afterEach(async () => {
    stopWithheldPhotoFetch();
    await withheldPhotoFetchIdle();
  });

  // A pass that waits in its pause until stopped, so a test can act mid-pass.
  function blockingDeps(species: WithheldSpecies[]) {
    const { deps } = fakeDeps(species, {
      sleep: vi.fn(
        (_ms: number, signal: AbortSignal) =>
          new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true })),
      ),
    });
    return { deps };
  }

  it("never runs two passes at once, and runs a start that came in meanwhile afterwards", async () => {
    let release!: () => void;
    const fetching = new Promise<void>((resolve) => (release = resolve));
    let active = 0;
    let maxActive = 0;
    const { deps } = fakeDeps([sp(1)], {
      fetchPhoto: vi.fn(async () => {
        maxActive = Math.max(maxActive, ++active);
        await fetching;
        active--;
        return "stored" as const;
      }),
    });
    startWithheldPhotoFetch("first", deps);
    await vi.waitFor(() => expect(deps.fetchPhoto).toHaveBeenCalled());

    startWithheldPhotoFetch("second", deps);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(deps.fetchPhoto).toHaveBeenCalledTimes(1);

    release();
    // The first pass ends after an empty batch, then the queued one runs and finds nothing left.
    await vi.waitFor(() => expect(deps.nextBatch).toHaveBeenCalledTimes(3));
    await withheldPhotoFetchIdle();
    expect(maxActive).toBe(1);
    expect(deps.fetchPhoto).toHaveBeenCalledTimes(1);
  });

  it("stops a running pass promptly when the setting is turned off", async () => {
    const { deps } = blockingDeps([sp(1), sp(2)]);
    startWithheldPhotoFetch("test", deps);
    await vi.waitFor(() => expect(deps.sleep).toHaveBeenCalled());

    await setWithheldPhotoFetchEnabled(false);
    await withheldPhotoFetchIdle();

    expect(settings.value).toBe(false);
    expect(deps.fetchPhoto).toHaveBeenCalledTimes(1);
  });

  it("waits out a rate limit instead of starting again right after a pack download", async () => {
    const { deps } = fakeDeps([sp(1)], {
      fetchPhoto: vi.fn(async () => {
        throw new lazy.PersistentRateLimitError("429");
      }),
    });
    startWithheldPhotoFetch("test", deps);
    await withheldPhotoFetchIdle();

    startWithheldPhotoFetch("pack download", deps);
    await withheldPhotoFetchIdle();
    expect(deps.fetchPhoto).toHaveBeenCalledTimes(1);

    // Turning the setting off and on again clears the wait.
    stopWithheldPhotoFetch();
    startWithheldPhotoFetch("turned on", deps);
    await withheldPhotoFetchIdle();
    expect(deps.fetchPhoto).toHaveBeenCalledTimes(2);
  });
});
