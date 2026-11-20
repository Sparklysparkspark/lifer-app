import { transportFor, loadHub, saveHub, forgetHub, secureKv } from "../connection";
import { expoMediaFs, isMetered, mediaDirs } from "../media/expoMedia";
import { MediaService } from "../media/service";
import { File } from "expo-file-system";
import { setIdleGate } from "../sync/yield";
import { expoModelFs, modelFilePath } from "../search/modelFs";
import { SmartSearch } from "../search/smartSearch";
import { openDb } from "../store/expoDb";
import { DEFAULT_SETTINGS } from "../store/settings";
import type { Boot, Live } from "./AppContext";

// Background sync waits for an idle moment between frames (a transition or scroll is not one), at most 1.5 s.
setIdleGate(() => new Promise((resolve) => requestIdleCallback(() => resolve(), { timeout: 1500 })));

/** Opens the database and reads the saved pairing: local reads only, no network at launch. */
export async function bootApp(): Promise<Boot> {
  const dev =
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- dev tooling stays out of release bundles
    typeof __DEV__ !== "undefined" && __DEV__ ? (require("../dev/fakeHub") as typeof import("../dev/fakeHub")) : null;
  const db = await openDb();
  // An unreadable secure store means unpaired, never a crash.
  const hub = await loadHub(secureKv).catch(() => null);
  const live: Live = { settings: DEFAULT_SETTINGS, api: null };
  const media = new MediaService(
    {
      db,
      fs: dev ? dev.withFakeMedia(expoMediaFs) : expoMediaFs,
      dirs: mediaDirs(),
      target: (path) => live.api!.target(path),
      now: Date.now,
      settings: () => live.settings,
      metered: isMetered,
    },
    () => live.api !== null,
  );
  await media.load();
  const smart = new SmartSearch({
    db,
    fs: expoModelFs,
    api: () => live.api,
    settings: () => live.settings,
    metered: isMetered,
    // The runtime loads on the first query, not at launch.
    loadEmbedder: async () =>
      (await import("../search/textEmbedder")).loadTextEmbedder(
        modelFilePath("encoder"),
        await new File(`file://${modelFilePath("tokenizer")}`).text(),
      ),
  });
  return {
    db,
    media,
    smart,
    live,
    hub,
    transport: dev ? dev.withFakeHub(transportFor) : transportFor,
    saveHub: (p) => saveHub(secureKv, p),
    forgetHub: () => forgetHub(secureKv),
  };
}
