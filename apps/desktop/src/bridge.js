// Builds window.liferSetup from Tauri's invoke() for the local picker page. apps/web builds the
// same shape in main.tsx, since no preload script survives navigating to another origin.
(function () {
  const { invoke } = window.__TAURI__.core;

  window.liferSetup = {
    choose: (config) => invoke("choose_setup", { config }),
    getConfig: () => invoke("get_config"),
    currentNetworkInfo: () => invoke("current_network_info"),
    testEndpoint: (url) => invoke("test_endpoint", { url }),
    testLogin: (url, email, password) => invoke("test_login", { url, email, password }),
    setLocalDataDir: (dataDir) => invoke("set_local_data_dir", { dataDir }),
    // Injected synchronously by lib.rs's initialization_script, since main.tsx needs it
    // before React renders.
    platform: window.__LIFER_PLATFORM__,
  };
})();
