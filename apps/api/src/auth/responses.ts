// Response schemas for the account and API key routes. They document the answer in the OpenAPI
// document and type the web app's calls; fields not listed still pass through.
import { Type } from "typebox";
import { DateTime, Nullable, Open, Uuid } from "../lib/schema.js";

export const AuthUser = Open({ id: Uuid(), email: Type.String() });

export const Me = Open({ user: Nullable(AuthUser) });

const ApiKeyFields = {
  id: Uuid(),
  name: Type.String(),
  permissions: Type.Array(Type.String()),
  createdAt: DateTime(),
};

export const ApiKeyList = Open({
  keys: Type.Array(
    Open({
      ...ApiKeyFields,
      lastUsedAt: Nullable(DateTime()),
      pluginId: Nullable(Type.String({ description: "The app this key was paired for, if any" })),
    }),
  ),
});

export const CreatedApiKey = Open({
  ...ApiKeyFields,
  token: Type.String({ description: "The key itself, shown only this once" }),
});
/** A desktop app's key, with the secret it later checks the server against (sync/linkProof.ts). */
export const DesktopLink = Open({
  ...CreatedApiKey.properties,
  linkSecret: Type.String({ description: "Proves this server to the app that holds the key" }),
});
