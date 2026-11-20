// Phones that pair with this desktop or server: the pairing code a signed-in user shows as a QR
// code, the phone's own pairing call, and the device list with revoke.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Type } from "typebox";
import { pool } from "@lifer/core/db.js";
import { SINGLE_USER_MODE } from "@lifer/core/config.js";
import {
  DEVICE_PLATFORMS,
  PAIRING_CODE_PATTERN,
  PAIRING_PAYLOAD_VERSION,
  PAKE_POINT_PATTERN,
  PAKE_SID_PATTERN,
  PAKE_TAG_PATTERN,
  encodePairingPayload,
} from "@lifer/shared";
import { IdParams, Ok, notFoundOnInvalidId, replies, withSchemas } from "../lib/schema.js";
import { readInstanceId } from "../lib/health.js";
import { getSessionUser, requireAuth } from "../auth/session.js";
import { DEVICE_KEY_SCOPES } from "../auth/apiKeyRoutes.js";
import { ipRateLimitKey, isRateLimited, recordAttempt } from "../auth/rateLimiter.js";
import { createDeviceKey, listDevices, revokeDevice } from "./devices.js";
import { finishPakeSession, mintPairingCode, startPakeSession, takePairingCode } from "./pairing.js";
import { DeviceList, PairCode, PairedDevice, PakeStarted } from "./responses.js";

const PAIR_ATTEMPTS_PER_MINUTE = 5;
const CODE_INVALID = "That code isn't valid. Show a new one in Lifer.";
const DeviceFields = {
  deviceName: Type.String({ minLength: 1, maxLength: 100 }),
  platform: Type.Enum(DEVICE_PLATFORMS),
};

/** A phone app never sends Origin; a web page always does, and could otherwise start pairings. */
function refuseWebPage(request: FastifyRequest, reply: FastifyReply): boolean {
  if (request.headers.origin === undefined) return false;
  void reply.code(403).send({ error: "Pair from the phone app, not from a web page." });
  return true;
}

/** Per-address limit on code guesses; true when this request is over it (and already answered). */
function overPairLimit(request: FastifyRequest, reply: FastifyReply): boolean {
  const limitKey = `companion-pair:${ipRateLimitKey(request.ip)}`;
  if (isRateLimited(limitKey, PAIR_ATTEMPTS_PER_MINUTE, 60_000)) {
    void reply.code(429).header("Retry-After", "60").send({ error: "Too many tries. Wait a minute." });
    return true;
  }
  recordAttempt(limitKey);
  return false;
}

async function issueDeviceKey(userId: string, deviceName: string, platform: (typeof DEVICE_PLATFORMS)[number]) {
  const instanceId = await readInstanceId();
  if (!instanceId) return null;
  const { id, token } = await createDeviceKey(pool, userId, deviceName, platform);
  return { deviceId: id, token, instanceId, scopes: [...DEVICE_KEY_SCOPES] };
}

export async function companionRoutes(fastify: FastifyInstance): Promise<void> {
  const app = withSchemas(fastify);

  // The code goes into the QR code with where the phone can reach this install. A desktop's
  // listener has a self-signed certificate, so the shell supplies its fingerprint; a server's
  // address is the one the signed-in browser used.
  app.post(
    "/companion/v1/pair-codes",
    {
      preValidation: requireAuth,
      schema: {
        body: Type.Object(
          {
            addresses: Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { minItems: 1, maxItems: 8 }),
            certSha256: Type.Optional(Type.String({ pattern: "^[0-9a-f]{64}$" })),
          },
          { additionalProperties: false },
        ),
        response: replies(PairCode),
      },
    },
    async (request, reply) => {
      if (SINGLE_USER_MODE && !request.body.certSha256) {
        return reply.code(400).send({ error: "A desktop pairing code needs its certificate fingerprint." });
      }
      const instanceId = await readInstanceId();
      if (!instanceId) return reply.code(503).send({ error: "Lifer is still starting. Try again in a moment." });
      // Only a desktop's code takes part in typed pairing (a server's TLS is checked by the system).
      const cert = SINGLE_USER_MODE ? request.body.certSha256 : undefined;
      const { code, expiresAt } = mintPairingCode(request.user!.id, cert);
      const payload = encodePairingPayload({
        v: PAIRING_PAYLOAD_VERSION,
        kind: SINGLE_USER_MODE ? "desktop" : "server",
        instanceId,
        addresses: request.body.addresses,
        ...(SINGLE_USER_MODE ? { certSha256: request.body.certSha256 } : {}),
        code,
      });
      return { code, expiresAt: expiresAt.toISOString(), payload };
    },
  );

  // The phone trades a scanned code (or one typed for a server), or on a server a signed-in
  // session, for its own key.
  app.post(
    "/companion/v1/pair",
    {
      schema: {
        body: Type.Object(
          { code: Type.Optional(Type.String({ pattern: PAIRING_CODE_PATTERN })), ...DeviceFields },
          { additionalProperties: false },
        ),
        response: replies(PairedDevice),
      },
    },
    async (request, reply) => {
      if (refuseWebPage(request, reply) || overPairLimit(request, reply)) return reply;
      const { code, deviceName, platform } = request.body;
      let userId: string | null;
      if (code !== undefined) userId = takePairingCode(code);
      else if (SINGLE_USER_MODE)
        return reply.code(400).send({ error: "Scan the code shown in Lifer on your computer." });
      else userId = (await getSessionUser(request))?.id ?? null;
      if (!userId) return reply.code(401).send({ error: CODE_INVALID });
      const paired = await issueDeviceKey(userId, deviceName, platform);
      return paired ?? reply.code(503).send({ error: "Lifer is still starting. Try again in a moment." });
    },
  );

  // Typed pairing with a computer, step 1: a key exchange keyed by the code (companionPake.ts). The
  // reply proves to the phone that this Lifer knows the code and holds the certificate it saw.
  app.post(
    "/companion/v1/pair/start",
    {
      schema: {
        body: Type.Object(
          { sid: Type.String({ pattern: PAKE_SID_PATTERN }), ya: Type.String({ pattern: PAKE_POINT_PATTERN }) },
          { additionalProperties: false },
        ),
        response: replies(PakeStarted),
      },
    },
    async (request, reply) => {
      if (refuseWebPage(request, reply) || overPairLimit(request, reply)) return reply;
      const started = startPakeSession(request.body);
      if (started === "no_code") return reply.code(401).send({ error: CODE_INVALID });
      if (started === "bad_hello") return reply.code(400).send({ error: "That pairing request isn't valid." });
      return { session: started.session, ...started.reply };
    },
  );

  // Step 2: the phone's tag proves it held the code; only then is a key issued.
  app.post(
    "/companion/v1/pair/finish",
    {
      schema: {
        body: Type.Object(
          {
            session: Type.String({ pattern: "^[0-9a-f]{32}$" }),
            tagA: Type.String({ pattern: PAKE_TAG_PATTERN }),
            ...DeviceFields,
          },
          { additionalProperties: false },
        ),
        response: replies(PairedDevice),
      },
    },
    async (request, reply) => {
      if (refuseWebPage(request, reply)) return reply;
      const { session, tagA, deviceName, platform } = request.body;
      const userId = finishPakeSession(session, tagA);
      if (!userId) return reply.code(401).send({ error: CODE_INVALID });
      const paired = await issueDeviceKey(userId, deviceName, platform);
      return paired ?? reply.code(503).send({ error: "Lifer is still starting. Try again in a moment." });
    },
  );

  app.get(
    "/companion/v1/devices",
    { preValidation: requireAuth, schema: { response: replies(DeviceList) } },
    async (request) => ({ devices: await listDevices(pool, request.user!.id) }),
  );

  app.delete(
    "/companion/v1/devices/:id",
    {
      preValidation: requireAuth,
      config: notFoundOnInvalidId("Device not found"),
      schema: { params: IdParams, response: replies(Ok) },
    },
    async (request, reply) => {
      if (!(await revokeDevice(pool, request.user!.id, request.params.id))) {
        return reply.code(404).send({ error: "Device not found" });
      }
      return { ok: true };
    },
  );
}
