import { useEffect, useState } from "react";
import { useTheme } from "../hooks/useTheme";

type TauriInvoke = (cmd: string, args?: unknown) => Promise<unknown>;

function tauriInvoke(): TauriInvoke | null {
  const tauri = (window as unknown as { __TAURI__?: { core: { invoke: TauriInvoke } } }).__TAURI__;
  return tauri?.core.invoke ?? null;
}

// Native traffic lights have no public API for an exact custom color when the window is
// unfocused (confirmed across multiple attempts this session) — only dimmed to whatever grey
// AppKit itself picks. Light theme hides the native buttons (see mac_window.rs, invoked here)
// and draws these instead: real colors while focused, a flat, deliberately chosen grey while
// not — matching the design decision to accept owning the buttons ourselves rather than
// settling for native's own, less legible, light-mode dimming. Dark theme leaves the native
// buttons alone; forcing the whole window's appearance to dark (see lib.rs) already gives
// dark-appearance's own inactive-button grey, which reads fine as-is.
export default function TrafficLights() {
  const { theme } = useTheme();
  const [focused, setFocused] = useState(true);
  const [platform, setPlatform] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    window.liferSetup?.getConfig().then(() => {
      if (!cancelled) setPlatform(window.liferSetup?.platform ?? null);
    });
    // platform is set synchronously by the Tauri shim (see main.tsx) even before getConfig
    // resolves — check it directly too so this doesn't wait on an unrelated round-trip.
    if (window.liferSetup?.platform) setPlatform(window.liferSetup.platform);
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const onFocus = () => setFocused(true);
    const onBlur = () => setFocused(false);
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  const isMacTauri = platform === "darwin" && !!tauriInvoke();

  useEffect(() => {
    if (!isMacTauri) return;
    tauriInvoke()?.("set_traffic_lights_hidden", { hidden: theme === "light" });
  }, [isMacTauri, theme]);

  if (!isMacTauri || theme !== "light") return null;

  function control(action: string) {
    tauriInvoke()?.("window_control", { action });
  }

  function Dot({ color, hoverColor, label, onClick }: { color: string; hoverColor: string; label: string; onClick: () => void }) {
    const [hover, setHover] = useState(false);
    return (
      <button
        aria-label={label}
        onClick={onClick}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          width: 12,
          height: 12,
          borderRadius: "50%",
          padding: 0,
          border: "none",
          background: focused ? (hover ? hoverColor : color) : "#d6d6d6",
          boxShadow: "inset 0 0 0 0.5px rgba(0,0,0,0.15)",
          cursor: "default",
          WebkitAppRegion: "no-drag",
        } as React.CSSProperties}
      />
    );
  }

  // Matches lib.rs's .traffic_light_position(20.0, 20.0) exactly: that call sets the
  // top-left corner of the native traffic-light cluster's bounding box, and native dots are
  // 12px diameter spaced 20px center-to-center (8px gap). Positioning this container at the
  // same (20, 20) origin with the same size/gap makes the custom dots occupy the identical
  // pixel box the native ones would have — no eyeballed offsets to drift out of alignment.
  return (
    <div
      style={
        {
          position: "fixed",
          top: 20,
          left: 20,
          width: 12,
          display: "flex",
          alignItems: "flex-start",
          gap: 8,
          WebkitAppRegion: "drag",
          zIndex: 2147483647,
        } as React.CSSProperties
      }
    >
      <Dot color="#ff5f57" hoverColor="#e0443e" label="Close" onClick={() => control("close")} />
      <Dot color="#febc2e" hoverColor="#dea123" label="Minimize" onClick={() => control("minimize")} />
      <Dot color="#28c840" hoverColor="#1aab29" label="Zoom" onClick={() => control("toggle-maximize")} />
    </div>
  );
}
