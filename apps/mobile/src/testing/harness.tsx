// Renders a screen inside the real provider over an in-memory database, with no network.
import type { ReactElement } from "react";
import { jest } from "@jest/globals";
import { act, render } from "@testing-library/react-native";
import { Dimensions } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import "../i18n";
import { AppProvider, type Boot } from "../app/AppContext";
import { CollectionViewProvider } from "../collection/view";
import { ToastProvider } from "../ui";
import type { PairedHub } from "../connection/pair";
import { MediaService } from "../media/service";
import { SmartSearch } from "../search/smartSearch";
import type { Db } from "../store/db";
import { saveMode, DEFAULT_SETTINGS, type Mode } from "../store/settings";
import { migratedDb } from "../store/testDb";
import type { HubApi } from "../sync/hubApi";

export const PAIRED: PairedHub = {
  token: "key",
  hub: {
    kind: "desktop",
    instanceId: "inst-1",
    baseUrl: "https://10.0.0.5:7443",
    fallbackUrls: [],
    certSha256: "a".repeat(64),
    deviceId: "d1",
    scopes: ["companion"],
  },
};

export interface Harness {
  db: Db;
  boot: Boot;
  /** Requests the screens made to the hub, as "GET /path". */
  calls: string[];
}

/** A hub that answers from a table of paths to replies; anything else is unreachable. */
export function fakeTransport(replies: Record<string, unknown> = {}, calls: string[] = []): Boot["transport"] {
  return async (req) => {
    const path = new URL(req.url).pathname.replace(/^\/api/, "") + new URL(req.url).search;
    calls.push(`${req.method} ${path}`);
    const key = Object.keys(replies).find((k) => path.startsWith(k));
    if (!key) throw new Error("unreachable");
    return { status: 200, body: JSON.stringify(replies[key]) };
  };
}

export async function harness(
  opts: {
    mode?: Mode | null;
    paired?: boolean;
    seed?: (db: Db) => Promise<void>;
    replies?: Record<string, unknown>;
    /** A stand-in for the phone's text encoder. */
    embed?: (texts: string[]) => Promise<Float32Array[]>;
  } = {},
): Promise<Harness> {
  const db = await migratedDb();
  if (opts.mode) await saveMode(db, opts.mode);
  await opts.seed?.(db);
  const live = { settings: DEFAULT_SETTINGS, api: null as HubApi | null };
  const media = new MediaService(
    {
      db,
      fs: {
        download: async () => Promise.reject(new Error("offline")),
        remove: async () => undefined,
        ensureDir: async () => undefined,
      },
      dirs: { thumb: "/t", view: "/v", phone: "/p", full: "/f" },
      target: (path) => live.api!.target(path),
      now: Date.now,
      settings: () => live.settings,
      metered: async () => false,
    },
    () => live.api !== null,
  );
  const smart = new SmartSearch({
    db,
    fs: {
      prepare: async () => undefined,
      size: async () => null,
      fetchRange: async () => 500,
      sha256: async () => "",
      rename: async () => undefined,
      remove: async () => undefined,
      clear: async () => undefined,
    },
    api: () => live.api,
    settings: () => live.settings,
    metered: async () => false,
    loadEmbedder: async () => {
      if (!opts.embed) throw new Error("no runtime in tests");
      return { embedTexts: opts.embed, release: async () => undefined };
    },
  });
  const calls: string[] = [];
  const boot: Boot = {
    db,
    media,
    smart,
    live,
    hub: opts.paired ? PAIRED : null,
    transport: fakeTransport(opts.replies, calls),
    saveHub: async () => undefined,
    forgetHub: async () => undefined,
    sleep: async () => undefined,
    autoSync: false,
  };
  return { db, boot, calls };
}

export async function renderApp(ui: ReactElement, h: Harness) {
  const result = await render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { x: 0, y: 0, width: 390, height: 844 },
        insets: { top: 47, left: 0, right: 0, bottom: 34 },
      }}
    >
      <AppProvider boot={h.boot}>
        <CollectionViewProvider>
          <ToastProvider>{ui}</ToastProvider>
        </CollectionViewProvider>
      </AppProvider>
    </SafeAreaProvider>,
  );
  return result;
}

type Fn = ReturnType<typeof jest.fn>;
type Options = {
  unstable_headerRightItems?: () => HeaderItem[];
  headerSearchBarOptions?: { onChangeText: (e: { nativeEvent: { text: string } }) => void };
};
interface HeaderItem {
  type: string;
  label: string;
  onPress?: () => void;
  menu?: { items: MenuItem[] };
}
interface MenuItem {
  type: string;
  label: string;
  onPress?: () => void;
  items?: MenuItem[];
}
/** The stub every screen navigates with (jest.setup.tsx). */
export const nav = () =>
  (jest.requireMock("../navigation/types") as { __nav: { navigate: Fn; goBack: Fn; canGoBack: Fn; setOptions: Fn } })
    .__nav;

/** The options the screen last gave its navigation bar. */
const lastOptions = (): Options => (nav().setOptions.mock.calls.at(-1)?.[0] ?? {}) as Options;

/** Types into the screen's native search field. */
export const typeInSearch = (text: string) =>
  act(() => lastOptions().headerSearchBarOptions?.onChangeText({ nativeEvent: { text } }));

const flat = (items: MenuItem[]): MenuItem[] => items.flatMap((i) => [i, ...(i.items ? flat(i.items) : [])]);

/** The bar's buttons by label, and every action inside its menus; pressing one is the same as tapping it. */
export function barItem(label: string): { press: () => void } {
  const items = lastOptions().unstable_headerRightItems?.() ?? [];
  const hit =
    items.find((i) => i.label === label) ??
    flat(items.flatMap((i) => i.menu?.items ?? [])).find((i) => i.label === label);
  if (!hit) throw new Error(`no bar item or menu action named ${label}`);
  return { press: () => act(() => hit.onPress?.()) };
}

/** Sets the window the screens lay out for (FD-1): a width in points and a text size (1 is the default). */
export async function setWindow(width: number, fontScale = 1, height = 844) {
  const size = { width, height, scale: 3, fontScale };
  await act(async () => Dimensions.set({ window: size, screen: size }));
}
