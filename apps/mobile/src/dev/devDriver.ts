// Development only, never in a release bundle (App.tsx requires it behind __DEV__): lets a script move the
// simulator app and fill it with demo data by writing a command to /tmp/lifer-dev.json. Used for screenshots.
import { LogBox } from "react-native";
import { File } from "expo-file-system";
import type { App } from "../app/AppContext";
import { referenceId } from "../media/cache";
import { setMeta } from "../store/meta";
import { PAIRED_DEMO } from "./pairedDemo";
import { navigationRef } from "../navigation/ref";
import { seedDemo, seedExtreme } from "./demoData";

const COMMAND_FILES = ["file:///tmp/lifer-dev.json", "file:///tmp/lifer-bench-cmd.json"];
const IMAGES = 24;

interface Command {
  id: number;
  cmd: string;
  [k: string]: unknown;
}

async function attachImages(app: App, prefix: string, count: number): Promise<void> {
  const dir = "file:///tmp/lifer-demo";
  await app.db.tx(async () => {
    for (let i = 0; i < count; i++) {
      const path = `${dir}/img-${i % IMAGES}.jpg`;
      for (const kind of ["thumb", "phone"] as const)
        await app.db.run(
          "INSERT OR REPLACE INTO media (photo_id, kind, path, bytes, last_used) VALUES (?, ?, ?, 1000, ?)",
          [`${prefix}${i}`, kind, path, Date.now()],
        );
    }
  });
  await app.media.load();
  app.bump();
}

async function run(app: App, c: Command, get: () => App): Promise<void> {
  const nav = navigationRef;
  const go = nav.navigate as unknown as (...a: unknown[]) => void;
  switch (c.cmd) {
    case "nav":
      go(c.name, c.params);
      break;
    case "tab":
      // Trips lives inside Albums now: select that segment, then show the tab.
      if (c.name === "Trips") await app.updateSettings({ albumsSegment: "trips" });
      go("Tabs", { screen: c.name === "Trips" ? "Albums" : c.name });
      break;
    case "back":
      if (nav.canGoBack()) nav.goBack();
      break;
    case "seed":
      if (c.kind === "extreme") {
        await seedExtreme(app.db);
        await attachImages(app, "xp", 60000);
      } else {
        await seedDemo(app.db);
        await attachImages(app, "ph", 120);
      }
      await app.chooseStandalone();
      app.bump();
      break;
    case "attach":
      await attachImages(app, c.prefix as string, Number(c.count));
      break;
    case "appearance":
      await app.updateSettings({ appearance: c.value as never });
      break;
    case "references": {
      // Reference photos for every species with none of its own, as the hub would send them.
      const rows = await app.db.all<{ scientific_name: string }>(
        "SELECT scientific_name FROM species WHERE scientific_name NOT IN (SELECT scientific_name FROM captures)",
      );
      await app.db.tx(async () => {
        for (const [i, r] of rows.entries())
          for (const kind of ["thumb", "view"] as const)
            await app.db.run(
              "INSERT OR REPLACE INTO media (photo_id, kind, path, bytes, last_used) VALUES (?, ?, ?, 1000, ?)",
              [referenceId(r.scientific_name), kind, `file:///tmp/lifer-demo/img-${i % IMAGES}.jpg`, Date.now()],
            );
      });
      await app.media.load();
      app.bump();
      break;
    }
    case "view":
      (globalThis as unknown as { __liferView?: { update(p: unknown): void } }).__liferView?.update(c.patch);
      break;
    case "regiontree":
      await setMeta(app.db, "regionTree", c.nodes);
      app.bump();
      break;
    case "paired":
      await app.connected(PAIRED_DEMO);
      break;
    case "embed":
      await (await import("./embedProbe")).embedProbe(c.dir as string, c.text as string);
      break;
    case "smartfake":
      await (await import("./smartFake")).smartFake(app);
      break;
    case "settings":
      await app.updateSettings(c.patch as never);
      break;
    case "syncbench":
      await (await import("./syncBench")).syncBench(app, get, c.label as string);
      break;
    default:
      console.warn("dev driver: unknown command", c.cmd);
  }
}

export function startDevDriver(get: () => App): () => void {
  LogBox.ignoreAllLogs(true);
  let last = 0;
  let busy = false;
  const timer = setInterval(() => {
    if (busy) return;
    void (async () => {
      busy = true;
      try {
        const f = COMMAND_FILES.map((p) => new File(p)).find((x) => x.exists);
        if (!f) return;
        const c = JSON.parse(await f.text()) as Command;
        if (c.id > last) {
          last = c.id;
          await run(get(), c, get);
        }
      } catch (e) {
        console.warn("dev driver:", e);
      } finally {
        busy = false;
      }
    })();
  }, 400);
  return () => clearInterval(timer);
}
