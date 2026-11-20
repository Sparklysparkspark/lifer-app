import type { FastifyInstance } from "fastify";
import { Type } from "typebox";
import { pool } from "@lifer/core/db.js";
import { requireScope } from "../auth/session.js";
import { getInstallSetting, setInstallSetting } from "../lib/installSettings.js";
import { Open, replies, withSchemas } from "../lib/schema.js";
import { SmartAlbumRules, SmartAlbumRulesInput, checkedRules } from "./smartRules.js";

// A pin is a named Gallery filter set, stored as the same rules a smart album holds.
const MAX_PINS = 50;
const MAX_NAME = 80;

const Pin = Open({
  id: Type.String({ pattern: "^[A-Za-z0-9-]{1,40}$" }),
  name: Type.String({ minLength: 1, maxLength: MAX_NAME }),
  rules: SmartAlbumRules,
});
const PinList = Open({ pins: Type.Array(Pin, { maxItems: MAX_PINS }) });
type PinRow = { id: string; name: string; rules: SmartAlbumRules };

const key = (userId: string) => `pinned_filters:${userId}`;

export async function pinnedFilterRoutes(fastify: FastifyInstance): Promise<void> {
  const app = withSchemas(fastify);

  app.get(
    "/pinned-filters",
    { preValidation: requireScope("album.read"), schema: { response: replies(PinList) } },
    async (request) => ({
      pins: (await getInstallSetting<PinRow[]>(pool, key(request.user!.id))) ?? [],
    }),
  );

  // The whole list is replaced: adding, renaming, reordering and unpinning are one save.
  app.put(
    "/pinned-filters",
    {
      preValidation: requireScope("album.write"),
      schema: {
        body: Type.Object(
          {
            pins: Type.Array(
              Type.Object(
                { id: Pin.properties.id, name: Pin.properties.name, rules: SmartAlbumRulesInput },
                { additionalProperties: false },
              ),
              { maxItems: MAX_PINS },
            ),
          },
          { additionalProperties: false },
        ),
        response: replies(PinList),
      },
    },
    async (request, reply) => {
      const pins: PinRow[] = [];
      for (const pin of request.body.pins) {
        const checked = checkedRules(pin.rules);
        if ("error" in checked) return reply.code(400).send({ error: checked.error });
        pins.push({ id: pin.id, name: pin.name.trim(), rules: checked.rules });
      }
      if (new Set(pins.map((p) => p.id)).size !== pins.length)
        return reply.code(400).send({ error: "Pin ids must be unique" });
      await setInstallSetting(pool, key(request.user!.id), pins);
      return { pins };
    },
  );
}
