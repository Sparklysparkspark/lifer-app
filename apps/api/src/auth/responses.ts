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
  keys: Type.Array(Open({ ...ApiKeyFields, lastUsedAt: Nullable(DateTime()) })),
});

export const CreatedApiKey = Open({
  ...ApiKeyFields,
  token: Type.String({ description: "The key itself, shown only this once" }),
});
