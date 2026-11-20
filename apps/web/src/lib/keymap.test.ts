// @vitest-environment jsdom
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  KEYMAP,
  RESERVED_CHORDS,
  chordLabel,
  matches,
  matchesChord,
  shortcutLabel,
  type KeyAction,
  type KeyScope,
} from "./keymap";
import { MAIN_PAGE_ROUTES } from "./mainPages";

const ev = (init: KeyboardEventInit) => new KeyboardEvent("keydown", init);

describe("keymap", () => {
  it("matches digits by position so AZERTY works", () => {
    expect(matches(ev({ key: "&", code: "Digit1" }), "rate1", false)).toBe(true);
    expect(matches(ev({ key: "0", code: "Digit0", ctrlKey: true }), "rateClear", false)).toBe(false);
    expect(matches(ev({ key: "0", code: "Digit0", ctrlKey: true }), "zoomFit", false)).toBe(true);
  });
  it("matches letters by character", () => {
    expect(matches(ev({ key: "f", code: "KeyU" }), "fullScreen", false)).toBe(true);
    expect(matches(ev({ key: "F", shiftKey: true }), "fullScreen", false)).toBe(false);
  });
  it("uses Cmd on mac and Ctrl elsewhere", () => {
    expect(matches(ev({ key: "i", metaKey: true, shiftKey: true }), "import", true)).toBe(true);
    expect(matches(ev({ key: "i", ctrlKey: true, shiftKey: true }), "import", true)).toBe(false);
    expect(matches(ev({ key: "i", ctrlKey: true }), "info", false)).toBe(true);
    expect(matches(ev({ key: "i", ctrlKey: true, shiftKey: true }), "info", false)).toBe(false);
  });
  it("ignores shift for symbols and handles plus", () => {
    expect(matches(ev({ key: "?", shiftKey: true }), "shortcuts", false)).toBe(true);
    expect(matchesChord(ev({ key: "+", shiftKey: true }), "+", false)).toBe(true);
    expect(matchesChord(ev({ key: "+", ctrlKey: true }), "Mod++", false)).toBe(true);
    expect(matches(ev({ key: "=", ctrlKey: true }), "zoomIn", false)).toBe(true);
  });
  it("separates video skips from item arrows", () => {
    expect(matches(ev({ key: "ArrowRight", shiftKey: true }), "next", false)).toBe(false);
    expect(matches(ev({ key: "ArrowRight", shiftKey: true }), "skipForward", false)).toBe(true);
  });
  it("labels per platform", () => {
    expect(chordLabel("Mod+Shift+I", true)).toBe("⇧⌘I");
    expect(chordLabel("Mod+Shift+I", false)).toBe("Ctrl+Shift+I");
    expect(shortcutLabel("rate3", false)).toBe("3");
  });
  it("rates and moves on with Shift and a digit, by position", () => {
    expect(matches(ev({ key: "!", code: "Digit1", shiftKey: true }), "rate1Next", false)).toBe(true);
    expect(matches(ev({ key: "!", code: "Digit1", shiftKey: true }), "rate1", false)).toBe(false);
    expect(matches(ev({ key: ")", code: "Digit0", shiftKey: true }), "rateClearNext", false)).toBe(true);
  });
  it("labels the sidebar chord with Ctrl on mac", () => {
    expect(shortcutLabel("toggleSidebar", true)).toBe("⌃⌘S");
    expect(shortcutLabel("toggleSidebar", false)).toBe("Ctrl+Alt+S");
    expect(matches(ev({ key: "s", ctrlKey: true, metaKey: true }), "toggleSidebar", true)).toBe(true);
  });
});

// Scopes that can be live at the same moment: global is everywhere, and a video plays inside the
// photo viewer. Dialog and widget keys only reach a focused dialog or control.
const overlaps = (a: KeyScope, b: KeyScope) =>
  a === b ||
  (a === "global" && b !== "dialog" && b !== "widget") ||
  (b === "global" && a !== "dialog" && a !== "widget") ||
  (a === "photo" && b === "video") ||
  (a === "video" && b === "photo");

const chordsOf = (a: KeyAction, mac: boolean) => (mac && KEYMAP[a].mac) || KEYMAP[a].chords;
const norm = (c: string) => (/^[a-z]$/i.test(c.split("+").pop()!) ? c.toUpperCase() : c);

describe("keymap registry", () => {
  const actions = Object.keys(KEYMAP) as KeyAction[];

  it.each([true, false])("gives no two live actions the same key (mac %s)", (mac) => {
    const clashes: string[] = [];
    for (const [i, a] of actions.entries()) {
      for (const b of actions.slice(i + 1)) {
        if (!overlaps(KEYMAP[a].scope, KEYMAP[b].scope)) continue;
        const shared = chordsOf(a, mac).filter((c) => chordsOf(b, mac).map(norm).includes(norm(c)));
        if (shared.length) clashes.push(`${a} and ${b}: ${shared.join(", ")}`);
      }
    }
    expect(clashes).toEqual([]);
  });

  it("binds nothing to a reserved key", () => {
    const reserved = new Set(RESERVED_CHORDS.map(norm));
    const used = actions.flatMap((a) => [...KEYMAP[a].chords, ...(KEYMAP[a].mac ?? [])].map((c) => [a, c] as const));
    expect(used.filter(([, c]) => reserved.has(norm(c)))).toEqual([]);
  });

  it("numbers every sidebar page and nothing else", () => {
    const pages = actions.filter((a) => /^page\d$/.test(a));
    expect(pages.length).toBe(MAIN_PAGE_ROUTES.length);
  });

  it("matches the desktop menu's accelerators", () => {
    const rs = readFileSync(join(__dirname, "../../../desktop/src-tauri/src/menu.rs"), "utf8");
    // Tauri spells Mod as CmdOrCtrl and a digit as the digit.
    const tauri = (c: string) => c.replace("Mod+", "CmdOrCtrl+").replace(/Digit(\d)/, "$1");
    const nav = [...rs.matchAll(/\(\s*"(nav-[a-z]+)",\s*"[^"]*",\s*"([^"]+)",\s*"([^"]+)",?\s*\)/g)].map((m) => ({
      id: m[1],
      accel: m[2],
      path: m[3],
    }));
    const byId = Object.fromEntries(nav.map((n) => [n.id, n.accel]));
    expect(byId["nav-settings"]).toBe(tauri(KEYMAP.settings.chords[0]!));
    expect(byId["nav-import"]).toBe(tauri(KEYMAP.import.chords[0]!));
    // The Go menu is the sidebar, in order, each with its page chord.
    const go = nav.filter((n) => /^CmdOrCtrl\+\d$/.test(n.accel));
    expect(go.map((n) => n.path)).toEqual([...MAIN_PAGE_ROUTES]);
    go.forEach((n, i) => expect(n.accel).toBe(tauri(KEYMAP[`page${i + 1}` as KeyAction].chords[0]!)));
    const accel = (id: string) => rs.match(new RegExp(`"${id}",[^;]*?Some\\("([^"]+)"\\)`))?.[1];
    expect(accel("search")).toBe(tauri(KEYMAP.find.chords[0]!));
    expect(KEYMAP.trash.chords.map(tauri)).toContain(accel("delete-selected"));
    // The sidebar chord differs per platform.
    expect(rs).toContain(`"${KEYMAP.toggleSidebar.mac![0]!.replace("Mod", "Cmd")}"`);
    expect(rs).toContain(`"${KEYMAP.toggleSidebar.chords[0]!.replace("Mod", "Ctrl")}"`);
  });

  it("is the only place that reads a key", () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.tsx?$/.test(name) && !/\.test\./.test(name) && !path.endsWith("lib/keymap.ts")) {
          readFileSync(path, "utf8")
            .split("\n")
            .forEach((line, i) => {
              if (/\b(e|ev|event)\.(key|code)(\.toLowerCase\(\))?\s*[!=]==\s*["']/.test(line))
                offenders.push(`${path}:${i + 1}`);
            });
        }
      }
    };
    walk(join(__dirname, ".."));
    expect(offenders).toEqual([]);
  });
});
