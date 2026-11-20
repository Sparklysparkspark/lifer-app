// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chordFromEvent, chordMatches, parsePluginMessage } from "@lifer/shared";
import { MAIN_PAGE_ROUTES } from "./mainPages";
import { attachPluginHost, hostShortcuts, type PluginHostActions } from "./pluginHost";

const ORIGIN = "http://127.0.0.1:5123";

type Cap = "pickers" | "notifications" | "host.preference";
function setup(capabilities: Cap[] = []) {
  const frame = document.createElement("iframe");
  document.body.appendChild(frame);
  const posted: unknown[] = [];
  vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation((msg: unknown, target?: unknown) => {
    expect(target).toBe(ORIGIN);
    posted.push(msg);
  });
  const actions: PluginHostActions = {
    go: vi.fn(),
    palette: vi.fn(),
    sidebar: vi.fn(),
    navigate: vi.fn(async () => null),
    title: vi.fn(),
    pickFolder: vi.fn(async () => "/Volumes/Card"),
    pickFiles: vi.fn(async () => ["/a.jpg", "/b.jpg"]),
    reveal: vi.fn(async () => {}),
    openUrl: vi.fn(),
    notify: vi.fn(),
    hostPreference: vi.fn(async () => ({ openInHost: false })),
    requestHostPreference: vi.fn(async () => ({ granted: true, openInHost: true })),
  };
  const host = attachPluginHost({
    origin: ORIGIN,
    token: "tok",
    capabilities,
    frame: () => frame,
    shortcuts: hostShortcuts(true),
    actions,
    init: async () => ({
      protocol: 1,
      theme: { mode: "light", tokens: { "--color-canvas": "#f6eedc" } },
      locale: "en",
      platform: "macos",
      reservedShortcuts: hostShortcuts(true).map((s) => s.chord),
      hostVersion: "1.0.0",
      visible: true,
    }),
  });
  const send = (data: unknown, opts: { origin?: string; source?: MessageEventSource | null } = {}) =>
    window.dispatchEvent(
      new MessageEvent("message", {
        data,
        origin: opts.origin ?? ORIGIN,
        source: opts.source === undefined ? frame.contentWindow : opts.source,
      }),
    );
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return { frame, posted, actions, host, send, flush };
}

let current: ReturnType<typeof setup> | null = null;
beforeEach(() => {
  current = null;
});
afterEach(() => {
  current?.host.dispose();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.useRealTimers();
});
const make = (caps?: Cap[]) => (current = setup(caps));

const cmd1 = { key: "1", code: "Digit1", meta: true, ctrl: false, alt: false, shift: false };

describe("attachPluginHost", () => {
  it("drops messages from another origin or another frame", async () => {
    const { send, flush, actions, posted } = make();
    const other = document.createElement("iframe");
    document.body.appendChild(other);
    send({ lifer: 1, type: "shortcut", payload: cmd1 }, { origin: "http://127.0.0.1:9999" });
    send({ lifer: 1, type: "shortcut", payload: cmd1 }, { source: other.contentWindow });
    send({ lifer: 1, type: "shortcut", payload: cmd1 }, { source: window });
    send({ lifer: 1, type: "shortcut", payload: cmd1 }, { source: null });
    await flush();
    expect(actions.go).not.toHaveBeenCalled();
    expect(posted).toEqual([]);
  });

  it("ignores unknown types and other versions without a reply", async () => {
    const { send, flush, posted } = make();
    send({ lifer: 1, type: "selfDestruct", id: "1", payload: {} });
    send({ lifer: 2, type: "title", id: "2", payload: { text: "x" } });
    send("ready");
    send(null);
    await flush();
    expect(posted).toEqual([]);
  });

  it("answers ready with init, and only then posts updates", async () => {
    const { send, flush, posted, host } = make();
    host.post({ lifer: 1, type: "visibility", payload: { visible: false } });
    expect(posted).toEqual([]);
    send({ lifer: 1, type: "ready", payload: { protocol: 1 } });
    await flush();
    expect(posted[0]).toEqual({ lifer: 1, type: "credential", payload: { token: "tok" } });
    expect(posted[1]).toMatchObject({
      lifer: 1,
      type: "init",
      payload: { protocol: 1, locale: "en", platform: "macos" },
    });
    host.post({ lifer: 1, type: "theme", payload: { mode: "dark", tokens: {} } });
    expect(posted[2]).toMatchObject({ type: "theme", payload: { mode: "dark" } });
  });

  it("sends the credential only to a valid ready, and again after a reload", async () => {
    const { send, flush, posted } = make();
    const ready = { lifer: 1, type: "ready", payload: { protocol: 1 } };
    send(ready, { origin: "http://127.0.0.1:9999" });
    send(ready, { source: window });
    send({ lifer: 1, type: "ready", payload: {} });
    await flush();
    expect(posted.some((m) => (m as { type: string }).type === "credential")).toBe(false);
    send(ready);
    send(ready);
    await flush();
    expect(posted.filter((m) => (m as { type: string }).type === "credential")).toHaveLength(2);
  });

  it("acts on reserved chords only", async () => {
    const { send, flush, actions } = make();
    send({ lifer: 1, type: "shortcut", payload: cmd1 });
    send({ lifer: 1, type: "shortcut", payload: { ...cmd1, key: "&" } }); // AZERTY: same position
    send({ lifer: 1, type: "shortcut", payload: { key: "k", meta: true, ctrl: false, alt: false, shift: false } });
    send({ lifer: 1, type: "shortcut", payload: { key: "s", meta: true, ctrl: true, alt: false, shift: false } });
    send({ lifer: 1, type: "shortcut", payload: { key: "p", meta: true, ctrl: false, alt: false, shift: false } });
    await flush();
    expect(actions.go).toHaveBeenCalledTimes(2);
    // The first sidebar page (lib/mainPages.ts).
    expect(actions.go).toHaveBeenCalledWith(MAIN_PAGE_ROUTES[0]);
    expect(actions.palette).toHaveBeenCalledTimes(1);
    expect(actions.sidebar).toHaveBeenCalledTimes(1);
  });

  it("replies to requests, and refuses what the manifest didn't ask for", async () => {
    const { send, flush, posted } = make();
    send({ lifer: 1, type: "pickFolder", id: "a", payload: {} });
    send({ lifer: 1, type: "notify", id: "b", payload: { title: "Done" } });
    await flush();
    expect(posted).toEqual([
      { lifer: 1, type: "reply", id: "a", payload: { ok: false, error: "not-allowed" } },
      { lifer: 1, type: "reply", id: "b", payload: { ok: false, error: "not-allowed" } },
    ]);
  });

  it("runs pickers, notices, navigation, title, reveal and links", async () => {
    const { send, flush, posted, actions } = make(["pickers", "notifications"]);
    send({ lifer: 1, type: "pickFolder", id: "f", payload: { title: "Choose a card" } });
    await flush();
    send({ lifer: 1, type: "pickFiles", id: "g", payload: {} });
    send({ lifer: 1, type: "notify", payload: { title: "Done", body: "12 photos", action: "Show" } });
    send({ lifer: 1, type: "navigate", id: "n", payload: { to: "species", scientificName: "Pandion haliaetus" } });
    send({ lifer: 1, type: "title", payload: { text: "  Card import  " } });
    send({ lifer: 1, type: "reveal", payload: { path: "C:\\Photos\\a.jpg" } });
    send({ lifer: 1, type: "openUrl", payload: { url: "https://example.com/help" } });
    await flush();
    expect(posted).toContainEqual({ lifer: 1, type: "reply", id: "f", payload: { ok: true, result: "/Volumes/Card" } });
    expect(posted).toContainEqual({
      lifer: 1,
      type: "reply",
      id: "g",
      payload: { ok: true, result: ["/a.jpg", "/b.jpg"] },
    });
    expect(posted).toContainEqual({ lifer: 1, type: "reply", id: "n", payload: { ok: true, result: null } });
    expect(actions.pickFolder).toHaveBeenCalledWith("Choose a card");
    expect(actions.notify).toHaveBeenCalledWith({ title: "Done", body: "12 photos", action: "Show" });
    expect(actions.navigate).toHaveBeenCalledWith({ to: "species", scientificName: "Pandion haliaetus" });
    expect(actions.title).toHaveBeenCalledWith("Card import");
    expect(actions.reveal).toHaveBeenCalledWith("C:\\Photos\\a.jpg");
    expect(actions.openUrl).toHaveBeenCalledWith("https://example.com/help");
  });

  it("refuses non-https links, relative paths and bad payloads", async () => {
    const { send, flush, posted, actions } = make(["pickers"]);
    send({ lifer: 1, type: "openUrl", id: "1", payload: { url: "http://example.com" } });
    send({ lifer: 1, type: "openUrl", id: "2", payload: { url: "javascript:alert(1)" } });
    send({ lifer: 1, type: "reveal", id: "3", payload: { path: "../etc/passwd" } });
    send({ lifer: 1, type: "reveal", id: "3b", payload: { path: "\\\\evil.example\\share" } });
    send({ lifer: 1, type: "reveal", id: "3c", payload: { path: "/Users/me/../../etc" } });
    send({ lifer: 1, type: "openUrl", id: "3d", payload: { url: "file:///etc/passwd" } });
    send({ lifer: 1, type: "title", id: "4", payload: { text: 5 } });
    // A picker without an id would have nowhere to send its answer.
    send({ lifer: 1, type: "pickFolder", payload: {} });
    await flush();
    expect(actions.openUrl).not.toHaveBeenCalled();
    expect(actions.reveal).not.toHaveBeenCalled();
    expect(actions.pickFolder).not.toHaveBeenCalled();
    expect(posted.map((m) => (m as { payload: { error: string } }).payload.error)).toEqual(Array(7).fill("invalid"));
  });

  it("opens one picker at a time", async () => {
    const { send, flush, posted, actions } = make(["pickers"]);
    let pick: (v: string | null) => void = () => {};
    vi.mocked(actions.pickFolder).mockReturnValueOnce(new Promise((r) => (pick = r)));
    send({ lifer: 1, type: "pickFolder", id: "p1", payload: {} });
    send({ lifer: 1, type: "pickFiles", id: "p2", payload: {} });
    await flush();
    expect(posted).toEqual([{ lifer: 1, type: "reply", id: "p2", payload: { ok: false, error: "failed" } }]);
    pick(null);
    await flush();
    expect(posted[1]).toEqual({ lifer: 1, type: "reply", id: "p1", payload: { ok: true, result: null } });
  });

  it("passes on a navigate error and times out a slow answer", async () => {
    vi.useFakeTimers();
    const { send, posted, actions } = make();
    vi.mocked(actions.navigate)
      .mockResolvedValueOnce("not-found")
      .mockReturnValueOnce(new Promise(() => {}));
    send({ lifer: 1, type: "navigate", id: "x", payload: { to: "species", scientificName: "Nonesuch" } });
    send({ lifer: 1, type: "navigate", id: "y", payload: { to: "gallery", query: "owl" } });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(posted).toEqual([
      { lifer: 1, type: "reply", id: "x", payload: { ok: false, error: "not-found" } },
      { lifer: 1, type: "reply", id: "y", payload: { ok: false, error: "timeout" } },
    ]);
  });

  it("answers host.preference, waits on the person, and pushes changes only to a page that asked", async () => {
    vi.useFakeTimers();
    const { send, posted, actions, host } = make(["host.preference"]);
    send({ lifer: 1, type: "ready", payload: { protocol: 1 } });
    await vi.advanceTimersByTimeAsync(0);
    posted.length = 0;
    // Not yet asked: no push.
    host.pushHostPreference({ openInHost: true });
    expect(posted).toEqual([]);
    // Another origin or frame is ignored.
    send({ lifer: 1, type: "host.preference.get", id: "o", payload: {} }, { origin: "http://127.0.0.1:9999" });
    send({ lifer: 1, type: "host.preference.get", id: "w", payload: {} }, { source: window });
    // A boolean, and only with an id.
    send({ lifer: 1, type: "host.preference.request", id: "f", payload: { openInHost: "yes" } });
    send({ lifer: 1, type: "host.preference.get", payload: {} });
    await vi.advanceTimersByTimeAsync(0);
    expect(actions.hostPreference).not.toHaveBeenCalled();
    expect(posted).toEqual([{ lifer: 1, type: "reply", id: "f", payload: { ok: false, error: "invalid" } }]);
    posted.length = 0;

    let decide: (d: { granted: boolean; openInHost: boolean }) => void = () => {};
    vi.mocked(actions.requestHostPreference).mockReturnValueOnce(new Promise((r) => (decide = r)));
    send({ lifer: 1, type: "host.preference.get", id: "g", payload: {} });
    send({ lifer: 1, type: "host.preference.request", id: "r", payload: { openInHost: true } });
    // The person takes their time: no 30 s timeout.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(posted).toEqual([
      { lifer: 1, type: "reply", id: "g", payload: { ok: true, result: { openInHost: false } } },
    ]);
    decide({ granted: false, openInHost: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(actions.requestHostPreference).toHaveBeenCalledWith(true);
    expect(posted[1]).toEqual({
      lifer: 1,
      type: "reply",
      id: "r",
      payload: { ok: true, result: { granted: false, openInHost: false } },
    });
    host.pushHostPreference({ openInHost: true });
    expect(posted[2]).toEqual({ lifer: 1, type: "host.preference.changed", payload: { openInHost: true } });
  });

  it("refuses host.preference without the capability, or when Lifer does", async () => {
    const bare = make();
    bare.send({ lifer: 1, type: "host.preference.get", id: "n", payload: {} });
    await bare.flush();
    expect(bare.posted).toEqual([{ lifer: 1, type: "reply", id: "n", payload: { ok: false, error: "not-allowed" } }]);
    expect(bare.actions.hostPreference).not.toHaveBeenCalled();
    bare.host.dispose();
    document.body.innerHTML = "";
    const { send, flush, posted, actions, host } = make(["host.preference"]);
    vi.mocked(actions.hostPreference).mockRejectedValueOnce(new Error("no"));
    send({ lifer: 1, type: "ready", payload: { protocol: 1 } });
    await flush();
    posted.length = 0;
    send({ lifer: 1, type: "host.preference.get", id: "g", payload: {} });
    await flush();
    expect(posted).toEqual([{ lifer: 1, type: "reply", id: "g", payload: { ok: false, error: "failed" } }]);
    host.pushHostPreference({ openInHost: false });
    expect(posted).toHaveLength(1);
  });

  it("stops listening once disposed", async () => {
    const { send, flush, actions, host } = make();
    host.dispose();
    send({ lifer: 1, type: "shortcut", payload: cmd1 });
    await flush();
    expect(actions.go).not.toHaveBeenCalled();
  });
});

describe("protocol helpers", () => {
  it("matches digits by position and letters by key", () => {
    const [digit1] = hostShortcuts(false).map((s) => s.chord);
    expect(digit1).toMatchObject({ code: "Digit1", ctrl: true, meta: false });
    const press = (init: KeyboardEventInit) => chordFromEvent(new KeyboardEvent("keydown", init));
    expect(chordMatches(digit1, press({ key: "&", code: "Digit1", ctrlKey: true }))).toBe(true);
    expect(chordMatches(digit1, press({ key: "1", code: "Digit1", ctrlKey: true, shiftKey: true }))).toBe(false);
    const palette = hostShortcuts(false).find((s) => s.action === "palette")!.chord;
    expect(chordMatches(palette, press({ key: "K", code: "KeyK", ctrlKey: true }))).toBe(true);
  });

  it("caps sizes and requires the envelope", () => {
    expect(parsePluginMessage({ lifer: 1, type: "title", payload: { text: "x".repeat(201) } })).toEqual({
      ok: false,
      id: undefined,
    });
    expect(parsePluginMessage({ lifer: 1, type: "title", id: 7, payload: { text: "x" } })).toEqual({
      ok: false,
      id: undefined,
    });
    expect(parsePluginMessage({ type: "title", payload: { text: "x" } })).toBeNull();
    expect(parsePluginMessage({ lifer: 1, type: "title", payload: { text: "x" } })).toMatchObject({ ok: true });
  });
});
