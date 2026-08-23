// The Tauri equivalent of apps/desktop/src/preload.js's contextBridge — reconstructs the exact
// same window.liferSetup shape (choose/getConfig/platform) that apps/web's SettingsPage.tsx,
// main.tsx, and this folder's own picker.html all already call, just backed by Tauri's
// invoke() instead of Electron's ipcRenderer. Loaded directly on this local picker page;
// apps/web gets the same shape via its own copy of this logic (see main.tsx), since Tauri has
// no single "preload script" that survives navigating the window to a different origin the
// way Electron's preload does.
(function () {
  const { invoke } = window.__TAURI__.core;

  window.liferSetup = {
    choose: (config) => invoke("choose_setup", { config }),
    getConfig: () => invoke("get_config"),
    // window.__LIFER_PLATFORM__ is injected synchronously, before any page script runs, via
    // Rust's WebviewWindowBuilder::initialization_script (see src-tauri/src/lib.rs) — needed
    // as a sync value (not an invoke() Promise) because main.tsx reads it on first paint to
    // set the data-mac-app attribute before React even renders.
    platform: window.__LIFER_PLATFORM__,
  };
})();
