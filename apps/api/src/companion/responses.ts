// Response schemas for the companion routes; fields not listed still pass through.
import { Type } from "typebox";
import { DEVICE_PLATFORMS } from "@lifer/shared";
import { DateTime, Nullable, Open, Uuid } from "../lib/schema.js";

export const DeviceList = Open({
  devices: Type.Array(
    Open({
      id: Uuid(),
      name: Type.String(),
      platform: Nullable(Type.Enum(DEVICE_PLATFORMS)),
      lastUsedAt: Nullable(DateTime()),
      createdAt: DateTime(),
    }),
  ),
});

export const PairCode = Open({
  code: Type.String(),
  expiresAt: DateTime(),
  payload: Type.String({ description: "What the QR code holds (companionPairing.ts)" }),
});

export const PairedDevice = Open({
  deviceId: Uuid(),
  token: Type.String({ description: "The device key, shown only this once" }),
  instanceId: Type.String(),
  scopes: Type.Array(Type.String()),
});

export const PakeStarted = Open({
  session: Type.String(),
  yb: Type.String(),
  tagB: Type.String({ description: "The hub's key-confirmation tag (companionPake.ts)" }),
});
