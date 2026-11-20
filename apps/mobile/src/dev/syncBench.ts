// Development only: runs a 60,000 photo sync against the pretend hub while hopping between tabs,
// and writes the longest JS stalls to /tmp/lifer-bench.json. Started by the dev driver ("syncbench").
import { File } from "expo-file-system";
import type { App } from "../app/AppContext";
import { navigationRef } from "../navigation/ref";
import { expoModelFs, modelFilePath } from "../search/modelFs";
import { syncVectors, VectorIndex } from "../search/vectorStore";
import { FAKE_PAIRED } from "./fakeHub";
import { FrameMonitor } from "./frameMonitor";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const TABS = ["Collection", "Gallery", "Albums", "Identify"];

export async function syncBench(app: App, get: () => App, label = "run"): Promise<void> {
  await app.db.exec("DELETE FROM captures; DELETE FROM capture_vectors; DELETE FROM capture_frames; DELETE FROM capture_backgrounds; DELETE FROM album_captures; DELETE FROM media;");
  await app.db.exec("DELETE FROM meta WHERE key LIKE 'cursor.%' OR key LIKE 'smart.%'");
  await app.media.load();
  app.bump();
  await sleep(1500);

  const monitor = new FrameMonitor();
  monitor.start();
  let tab = 0;
  const hop = setInterval(() => {
    const go = navigationRef.navigate as unknown as (...a: unknown[]) => void;
    go("Tabs", { screen: TABS[tab++ % TABS.length] });
  }, 700);

  const t0 = Date.now();
  monitor.phase = "sync";
  await app.connected(FAKE_PAIRED);
  await sleep(500);
  while (get().sync.syncing) await sleep(200);
  const syncMs = Date.now() - t0;

  monitor.phase = "vectors+squares+hash";
  const t1 = Date.now();
  const api = get().api!;
  await expoModelFs.prepare();
  const probe = new File(`file://${modelFilePath("bench.bin")}`);
  probe.create({ overwrite: true });
  probe.write(new Uint8Array(16 * 1024 * 1024).fill(7));
  await Promise.all([
    syncVectors({ db: app.db, api, allowed: async () => true }),
    Promise.all(Array.from({ length: 1000 }, (_, i) => get().media.square("species", `o${i}`, `bp${i}`, null))),
    expoModelFs.sha256("bench.bin"),
  ]);
  probe.delete();
  const index = await VectorIndex.load(app.db);
  const heavyMs = Date.now() - t1;

  clearInterval(hop);
  const out = { label, syncMs, heavyMs, indexSize: index.size, ...monitor.stop() };
  const f = new File("file:///tmp/lifer-bench.json");
  f.create({ overwrite: true });
  f.write(JSON.stringify(out, null, 1));
  console.log("syncbench done", JSON.stringify({ label, longest: out.longest, over50: out.over50 }));
}
