import type { PairedHub } from "../connection/pair";

/** A pairing for a computer that is not there: the app looks paired and offline, for screenshots. */
export const PAIRED_DEMO: PairedHub = {
  token: "dev",
  hub: {
    kind: "desktop",
    instanceId: "dev-instance",
    baseUrl: "https://127.0.0.1:1",
    fallbackUrls: [],
    certSha256: "ab".repeat(32),
    deviceId: "dev",
    scopes: ["companion"],
  },
};
