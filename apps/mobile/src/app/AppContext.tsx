// The app's shared state: the local database, who it is paired with, settings, the sync runner and
// the media service. Everything renders from the database; this only keeps it filled.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { AppState } from "react-native";
import type { PairedHub } from "../connection/pair";
import { runSync } from "../sync/engine";
import { setSyncProgress } from "../sync/progress";
import { createHubApi, type HubApi } from "../sync/hubApi";
import { MediaService } from "../media/service";
import type { SmartSearch, SmartStatus } from "../search/smartSearch";
import { pendingCount } from "../sync/engine";
import type { Db } from "../store/db";
import { adoptHub } from "../store/hub";
import { getMeta } from "../store/meta";
import { NO_SENSITIVE, isSensitive, type SensitivePrefs } from "../store/privacy";
import {
  loadMode,
  loadSettings,
  saveMode,
  saveSettings,
  DEFAULT_SETTINGS,
  type Mode,
  type Settings,
} from "../store/settings";
import type { Preferences } from "../sync/engine";
import { AppearanceContext } from "../theme/useTheme";

export interface SyncState {
  syncing: boolean;
  lastSyncAt: string | null;
  waiting: number;
  /** The hub answered the last time we asked (true until we know otherwise). */
  reachable: boolean;
  /** The hub no longer accepts this phone's key. */
  keyRefused: boolean;
}

export interface App {
  db: Db;
  mode: Mode | null;
  paired: PairedHub | null;
  api: HubApi | null;
  media: MediaService;
  smart: SmartSearch;
  settings: Settings;
  updateSettings(patch: Partial<Settings>): Promise<void>;
  sync: SyncState & { run(): Promise<void> };
  /** Bumps whenever the local data may have changed; screens requery on it. */
  version: number;
  bump(): void;
  isSensitive(scientificName: string, byDefault: boolean): boolean;
  chooseStandalone(): Promise<void>;
  /** Called with a successful pairing: keeps the key, becomes a companion and syncs. */
  connected(paired: PairedHub): Promise<void>;
  disconnect(): Promise<void>;
}

const Ctx = createContext<App | null>(null);

export function useApp(): App {
  const app = useContext(Ctx);
  if (!app) throw new Error("AppProvider is missing");
  return app;
}

/** Smart search offline: what it is doing now, for Settings and the search screens. */
export function useSmartStatus(): SmartStatus {
  const { smart } = useApp();
  return useSyncExternalStore(smart.subscribe, smart.getStatus);
}

/** Runs a read against the local database and again whenever the data changes. */
export function useLocal<T>(
  load: (db: Db) => Promise<T>,
  deps: unknown[] = [],
): { data: T | undefined; loading: boolean } {
  const { db, version } = useApp();
  const [data, setData] = useState<T>();
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);
  useEffect(() => {
    const mine = ++seq.current;
    void load(db).then(
      (d) => {
        if (mine === seq.current) {
          setData(d);
          setLoading(false);
        }
      },
      () => mine === seq.current && setLoading(false),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, version, ...deps]);
  return { data, loading };
}

/** What the media service reads at the moment it needs it, kept current by the provider. */
export interface Live {
  settings: Settings;
  api: HubApi | null;
}

export interface Boot {
  db: Db;
  media: MediaService;
  smart: SmartSearch;
  live: Live;
  /** The saved pairing, if any. */
  hub: PairedHub | null;
  transport: Parameters<typeof createHubApi>[1];
  saveHub(p: PairedHub): Promise<void>;
  forgetHub(): Promise<void>;
  /** Waits before a retry. */
  sleep?: (ms: number) => Promise<void>;
  /** False in tests: no sync on start. */
  autoSync?: boolean;
}

const FOREGROUND_GAP_MS = 30_000;

export function AppProvider({ boot, children }: { boot: Boot; children: ReactNode }) {
  const { db, media, smart } = boot;
  const [mode, setMode] = useState<Mode | null | undefined>(undefined);
  const [paired, setPaired] = useState<PairedHub | null>(boot.hub);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [version, setVersion] = useState(0);
  const [prefs, setPrefs] = useState<SensitivePrefs>(NO_SENSITIVE);
  const [sync, setSync] = useState<SyncState>({
    syncing: false,
    lastSyncAt: null,
    waiting: 0,
    reachable: true,
    keyRefused: false,
  });
  const bump = useCallback(() => setVersion((v) => v + 1), []);
  const api = useMemo(() => (paired ? createHubApi(paired, boot.transport) : null), [paired, boot.transport]);
  const apiRef = useRef(api);
  apiRef.current = api;
  boot.live.api = api;
  boot.live.settings = settings;
  const running = useRef(false);
  const lastRun = useRef(0);

  const refreshMeta = useCallback(async () => {
    const [lastSyncAt, waiting, p] = await Promise.all([
      getMeta<string>(db, "lastSyncAt"),
      pendingCount(db),
      getMeta<Preferences>(db, "prefs"),
    ]);
    setSync((s) => ({ ...s, lastSyncAt, waiting }));
    if (p) setPrefs(p.sensitive);
  }, [db]);

  useEffect(() => {
    void (async () => {
      const [m, s] = await Promise.all([loadMode(db), loadSettings(db)]);
      setSettings(s);
      boot.live.settings = s;
      await smart.load();
      setMode(boot.hub ? "paired" : m);
      await refreshMeta();
    })();
    // boot.live is a mutable holder, written here, not read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, boot.hub, refreshMeta, smart]);

  const run = useCallback(async () => {
    const hub = apiRef.current;
    if (!hub || running.current) return;
    running.current = true;
    lastRun.current = Date.now();
    setSync((s) => ({ ...s, syncing: true }));
    setSyncProgress(null);
    try {
      const res = await runSync({
        db,
        api: hub,
        now: () => new Date(),
        sleep: boot.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
        onProgress: setSyncProgress,
      });
      setSync((s) => ({ ...s, reachable: res.reached, keyRefused: res.unauthorized }));
      await refreshMeta();
      bump();
      if (res.reached && !res.unauthorized) {
        void media.fillShowcase().then(bump);
        void smart.refresh().then(bump);
      }
    } finally {
      running.current = false;
      setSync((s) => ({ ...s, syncing: false }));
      setSyncProgress(null);
    }
  }, [db, boot.sleep, refreshMeta, bump, media, smart]);

  // On launch and whenever the app comes back to the foreground.
  useEffect(() => {
    if (!api || boot.autoSync === false) return;
    void run();
    const sub = AppState.addEventListener("change", (s) => {
      if (s === "active" && Date.now() - lastRun.current > FOREGROUND_GAP_MS) void run();
    });
    return () => sub.remove();
  }, [api, run, boot.autoSync]);

  const value = useMemo<App | null>(() => {
    if (mode === undefined) return null;
    return {
      db,
      mode,
      paired,
      api,
      media,
      smart,
      settings,
      async updateSettings(patch) {
        const next = { ...settings, ...patch };
        setSettings(next);
        await saveSettings(db, next);
        if (patch.thumbCapBytes) void media.trim();
      },
      sync: { ...sync, run },
      version,
      bump,
      isSensitive: (name, byDefault) => isSensitive(name, byDefault, prefs),
      async chooseStandalone() {
        await saveMode(db, "standalone");
        setMode("standalone");
      },
      async connected(p) {
        const last = await getMeta<string>(db, "hubInstance");
        if (last && last !== p.hub.instanceId) {
          await media.clear("thumbs");
          await media.clear("showcase");
        }
        await adoptHub(db, p.hub.instanceId);
        await boot.saveHub(p);
        await saveMode(db, "paired");
        setPaired(p);
        setMode("paired");
        await refreshMeta();
        bump();
      },
      async disconnect() {
        await boot.forgetHub();
        await saveMode(db, "standalone");
        setPaired(null);
        setMode("standalone");
        setSync((s) => ({ ...s, reachable: true, keyRefused: false }));
        bump();
      },
    };
  }, [mode, db, paired, api, media, smart, settings, sync, run, version, bump, prefs, boot, refreshMeta]);

  if (!value) return null;
  return (
    <AppearanceContext.Provider value={settings.appearance}>
      <Ctx.Provider value={value}>{children}</Ctx.Provider>
    </AppearanceContext.Provider>
  );
}
