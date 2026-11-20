import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { UNSAFE_createBrowserHistory as createBrowserHistory, Router } from "react-router-dom";
import { isDarkPluginPath } from "../lib/plugins";
import { withThemeTransition } from "../lib/themeFade";

// BrowserRouter, except a route change into or out of a dark plugin page commits inside a view
// transition so the window dissolves as one image.
export function TransitionRouter({ children }: { children: ReactNode }) {
  const [history] = useState(() => createBrowserHistory({ v5Compat: true }));
  const [state, setState] = useState({ action: history.action, location: history.location });
  const previous = useRef(history.location.pathname);
  useLayoutEffect(
    () =>
      history.listen((next) => {
        const darkChange = isDarkPluginPath(previous.current) !== isDarkPluginPath(next.location.pathname);
        previous.current = next.location.pathname;
        if (darkChange) withThemeTransition(() => setState(next));
        else setState(next);
      }),
    [history],
  );
  return (
    <Router location={state.location} navigationType={state.action} navigator={history}>
      {children}
    </Router>
  );
}
