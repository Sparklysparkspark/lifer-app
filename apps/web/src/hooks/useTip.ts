import { useEffect, useState, useSyncExternalStore } from "react";
import { api } from "../api/client";
import { useSettings } from "./useSettings";
import { useLatest } from "./useLatest";
import { isTypingTarget } from "./useKeyboardShortcuts";
import { ignore } from "../lib/ignore";
import { matches } from "../lib/keymap";
import { TIPS, TIPS_ALWAYS, type TipId } from "../lib/tips";

// One tip on screen at a time: the first to ask holds the slot until it's dismissed or unmounts.
let activeTip: TipId | null = null;
const listeners = new Set<() => void>();
function setActive(id: TipId | null) {
  activeTip = id;
  for (const l of listeners) l();
}
// The guided tour (components/Tour.tsx) hides every tip while it runs.
let tourActive = false;
export function setTourActive(on: boolean) {
  tourActive = on;
  for (const l of listeners) l();
}
function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** A contextual hint is a tip: `useHint(id, when)`.
 *  Whether tip `id` shows now (`when`: the screen is usable for it), and how to retire it.
 *  Retiring records it as seen on the account; a dismissal also lasts for this visit, which is
 *  what keeps it closed in the dev always-on mode. `takeOver`: a tip in something opened on top
 *  of the page (the photo viewer) shows in place of the page's own, which returns afterwards. */
export function useTip(id: TipId, when: boolean, takeOver = false): { show: boolean; dismiss: () => void } {
  const { settings, setLocal } = useSettings();
  const [dismissed, setDismissed] = useState(false);
  const active = useSyncExternalStore(subscribe, () => activeTip);
  const touring = useSyncExternalStore(subscribe, () => tourActive);
  const eligible =
    !touring &&
    when &&
    !dismissed &&
    !!settings &&
    settings.tipsEnabled &&
    (TIPS_ALWAYS || !settings.tipsSeen.includes(id));
  const show = eligible && active === id;

  // Claims the slot when it's free (again, after another tip closes), or at once when taking over.
  useEffect(() => {
    if (eligible && active !== id && (active === null || takeOver)) setActive(id);
  }, [eligible, active, id, takeOver]);
  // Frees it when this tip stops applying or its screen goes away.
  useEffect(() => {
    if (!eligible) return;
    return () => {
      if (activeTip === id) setActive(null);
    };
  }, [eligible, id]);

  const dismiss = () => {
    setDismissed(true);
    if (settings && !settings.tipsSeen.includes(id)) setLocal({ tipsSeen: [...settings.tipsSeen, id] });
    api.post("/settings/tips/seen", { id }).catch(ignore("Couldn't save that the tip was seen"));
  };
  const dismissRef = useLatest(dismiss);

  // Using what the tip teaches retires it, so it never needs a click.
  const learn = TIPS[id].learn;
  useEffect(() => {
    if (!show || !learn) return;
    const onKey = (e: KeyboardEvent) => {
      // Typing an "s" in a search box isn't using the shortcut.
      if (learn.some((a) => matches(e, a)) && !isTypingTarget(e.target)) dismissRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [show, learn, dismissRef]);

  return { show, dismiss };
}

export const useHint = useTip;
