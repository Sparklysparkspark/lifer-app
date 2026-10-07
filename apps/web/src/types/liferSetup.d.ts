// The desktop shell's bridge, injected before the app renders. Absent in a plain browser tab.

// A remote config has either serverUrl, or localUrl + externalUrls (Automatic URL Switching), never both.
export interface DesktopBridgeConfig {
  mode: "local" | "remote";
  dataDir?: string;
  serverUrl?: string;
  localUrl?: string;
  localNetworkName?: string;
  // Try-order, top to bottom.
  externalUrls?: string[];
  offlineMode?: boolean;
}

export interface DesktopBridgeChoice {
  mode: "local" | "remote";
  serverUrl?: string;
  localUrl?: string;
  localNetworkName?: string;
  externalUrls?: string[];
  offlineMode?: boolean;
}

declare global {
  interface Window {
    liferSetup?: {
      // Resolves with { error } (without navigating) when saving the connection config fails.
      choose: (config: DesktopBridgeChoice) => Promise<{ ok?: boolean; canceled?: boolean; error?: string }>;
      getConfig: () => Promise<DesktopBridgeConfig | null>;
      // This machine's LAN IP and Wi-Fi name, to autofill the local-address fields.
      currentNetworkInfo: () => Promise<{ localIp: string | null; wifiName: string | null }>;
      testEndpoint: (url: string) => Promise<boolean>;
      // Checks credentials against a remote server natively; rejects with the server's message.
      testLogin: (url: string, email: string, password: string) => Promise<void>;
      setLocalDataDir?: (dataDir: string) => Promise<void>;
      platform: string;
      // Node's process.arch naming ("arm64", "x64"). Missing from desktop builds before it was added.
      arch?: string;
    };
  }
}
