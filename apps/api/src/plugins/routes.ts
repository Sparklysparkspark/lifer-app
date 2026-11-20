// Pairing a companion app with Lifer (docs/plans/plugin-host-and-integration-api.md, section 5).
// Three flows end in the same key: a desktop launch's ticket plus the user's consent in Lifer's
// window, a desktop request the user compares a 6-digit code for, and a server's pairing code.
// The /pair and /pair-requests routes are public (auth/publicRoutes.ts) and protected by ticket,
// code or consent instead; the consent and ticket routes are for Lifer itself.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Type } from "typebox";
import { SINGLE_USER_MODE } from "@lifer/core/config.js";
import { DateTime, Nullable, Ok, replies, withSchemas } from "../lib/schema.js";
import { getOrCreateLocalUser, requireAuth } from "../auth/session.js";
import { hasLaunchTokenHeader } from "../auth/localCredential.js";
import { PLUGIN_SCOPES } from "../auth/desktopGate.js";
import { ipRateLimitKey, isRateLimited, recordAttempt } from "../auth/rateLimiter.js";
import {
  alreadyAllowed,
  cancelPairGrant,
  cancelPairRequest,
  clearHostTicket,
  collectPairResult,
  createPairCode,
  createPairGrant,
  createPairRequest,
  getPairRequest,
  issuePluginKey,
  pairGrants,
  pendingPairRequests,
  setHostTicket,
  settlePairRequest,
  sixDigitCode,
  takeHostTicket,
  takePairGrant,
  takePairCode,
} from "./pairing.js";
import { hostPreferenceRoutes, setHostOpen } from "./hostPreference.js";

const PAIR_ATTEMPTS_PER_MINUTE = 5;

const PluginId = Type.String({ pattern: "^[A-Za-z0-9-]+(\\.[A-Za-z0-9-]+)+$", maxLength: 200 });
const Name = Type.String({ minLength: 1, maxLength: 200 });
// An unknown scope is refused rather than dropped, so a key never has less than the app asked for.
const Scopes = Type.Array(Type.Enum([...PLUGIN_SCOPES]), { minItems: 1, maxItems: PLUGIN_SCOPES.size });
const Hex64 = Type.String({ pattern: "^[0-9a-f]{64}$" });
const RequestId = Type.Object({ id: Hex64 });

const PairedKey = Type.Object({ key: Type.String(), scopes: Type.Array(Type.String()) });
const PairRequestStatus = Type.Object({
  status: Type.Union([
    Type.Literal("pending"),
    Type.Literal("approved"),
    Type.Literal("denied"),
    Type.Literal("expired"),
  ]),
  key: Type.Optional(Type.String()),
  scopes: Type.Optional(Type.Array(Type.String())),
});
const Consent = Type.Object({
  id: Type.String(),
  /** `hostPreference`: a paired app asks to open inside Lifer from now on (hostPreference.ts). */
  kind: Type.Union([Type.Literal("pair"), Type.Literal("hostPreference")]),
  /** For hostPreference: what the app asks to change it to. */
  openInHost: Type.Optional(Type.Boolean()),
  pluginId: Type.String(),
  name: Type.String(),
  scopes: Type.Array(Type.String()),
  code: Nullable(Type.String()),
  expiresAt: DateTime(),
});

/** Pairing is for an app's own process: a browser page always sends Origin, and one could otherwise
 *  start pairings from any site. Counts toward the per-address limit. False once it has replied. */
function admitPairAttempt(request: FastifyRequest, reply: FastifyReply): boolean {
  if (request.headers.origin !== undefined) {
    reply.code(403).send({ error: "Pair from the app itself, not from a web page." });
    return false;
  }
  const key = `pair:${ipRateLimitKey(request.ip)}`;
  if (isRateLimited(key, PAIR_ATTEMPTS_PER_MINUTE, 60_000)) {
    reply.code(429).header("Retry-After", "60").send({ error: "Too many pairing attempts. Try again in a minute." });
    return false;
  }
  recordAttempt(key);
  return true;
}

// The ticket routes take only the shell's own header, not the window's cookie: a ticket comes
// from a launch, never from a page.
async function requireShell(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!SINGLE_USER_MODE || !hasLaunchTokenHeader(request)) reply.code(404).send({ error: "Not found" });
}

export async function pluginRoutes(fastify: FastifyInstance): Promise<void> {
  const app = withSchemas(fastify);

  app.post(
    "/plugins/v1/pair",
    {
      schema: {
        body: Type.Object(
          {
            pluginId: PluginId,
            scopes: Scopes,
            ticket: Type.Optional(Hex64),
            code: Type.Optional(Type.String({ pattern: "^[0-9]{6}$" })),
            name: Type.Optional(Name),
          },
          { additionalProperties: false },
        ),
        response: replies(PairedKey),
      },
    },
    async (request, reply) => {
      if (!admitPairAttempt(request, reply)) return reply;
      const { pluginId, ticket, code } = request.body;
      const scopes = [...new Set(request.body.scopes)];
      if ((ticket === undefined) === (code === undefined)) {
        return reply.code(400).send({ error: "Send either ticket or code." });
      }

      if (code !== undefined) {
        if (SINGLE_USER_MODE) return reply.code(400).send({ error: "Pairing codes are for Lifer servers." });
        const name = request.body.name?.trim();
        if (!name) return reply.code(400).send({ error: "name is required with a code." });
        const userId = takePairCode(code);
        if (!userId) return reply.code(401).send({ error: "That code isn't valid. Make a new one in Lifer." });
        return { key: await issuePluginKey(userId, pluginId, name, scopes), scopes };
      }

      if (!SINGLE_USER_MODE) return reply.code(400).send({ error: "Tickets are for the Lifer desktop app." });
      const taken = await takeHostTicket(pluginId, ticket!);
      if (!taken) return reply.code(401).send({ error: "That ticket isn't valid." });
      const outside = scopes.filter((s) => !taken.entry.scopes.includes(s));
      if (outside.length > 0) {
        taken.restore();
        return reply.code(403).send({ error: `The app's manifest doesn't list ${outside.join(", ")}.` });
      }
      const user = await getOrCreateLocalUser();
      // Allowed before, or just now by the user's own click in Lifer (a grant). Only a launch
      // ticket proves the caller is the installed app, so a grant never pairs anything else.
      if ((await alreadyAllowed(user.id, pluginId, scopes)) || takePairGrant(user.id, pluginId, scopes)) {
        return { key: await issuePluginKey(user.id, pluginId, taken.entry.name, scopes), scopes };
      }

      // Waits for the user's answer in Lifer's window; an app that hangs up withdraws the request.
      const pending = createPairRequest({ userId: user.id, pluginId, name: taken.entry.name, scopes, code: null });
      reply.raw.once("close", () => cancelPairRequest(pending.id));
      const result = await pending.done;
      if (result.status === "approved") return { key: result.key, scopes: result.scopes };
      if (result.status === "denied") return reply.code(403).send({ error: "The request to connect was declined." });
      taken.restore();
      return reply.code(408).send({ error: "Nobody answered the request to connect." });
    },
  );

  app.post(
    "/plugins/v1/pair-requests",
    {
      schema: {
        body: Type.Object({ pluginId: PluginId, name: Name, scopes: Scopes }, { additionalProperties: false }),
        response: replies(Type.Object({ id: Type.String(), code: Type.String(), expiresAt: DateTime() })),
      },
    },
    async (request, reply) => {
      if (!SINGLE_USER_MODE) return reply.code(404).send({ error: "Not found" });
      if (!admitPairAttempt(request, reply)) return reply;
      const name = request.body.name.trim();
      if (!name) return reply.code(400).send({ error: "name is required." });
      const user = await getOrCreateLocalUser();
      const pending = createPairRequest({
        userId: user.id,
        pluginId: request.body.pluginId,
        name,
        scopes: [...new Set(request.body.scopes)],
        code: sixDigitCode(),
      });
      return { id: pending.id, code: pending.code!, expiresAt: pending.expiresAt.toISOString() };
    },
  );

  app.get(
    "/plugins/v1/pair-requests/:id",
    { schema: { params: RequestId, response: replies(PairRequestStatus) } },
    async (request, reply) => {
      // A host preference request is answered on the app's own waiting call, never here.
      const known = getPairRequest(request.params.id);
      if (!known || known.kind) {
        // Ids are 256-bit random, but a stream of misses is still someone guessing.
        if (!admitPairAttempt(request, reply)) return reply;
        return reply.code(404).send({ error: "No such request. It may have expired." });
      }
      const result = collectPairResult(request.params.id);
      return result ?? { status: "pending" as const };
    },
  );

  // Lifer's own window polls this and shows each request in its consent dialog.
  app.get(
    "/plugins/v1/consents",
    { preValidation: requireAuth, schema: { response: replies(Type.Object({ consents: Type.Array(Consent) })) } },
    async (request) => ({
      consents: pendingPairRequests(request.user!.id).map((r) => ({
        id: r.id,
        kind: r.kind ?? ("pair" as const),
        openInHost: r.openInHost,
        pluginId: r.pluginId,
        name: r.name,
        scopes: r.scopes,
        code: r.code,
        expiresAt: r.expiresAt.toISOString(),
      })),
    }),
  );

  app.post(
    "/plugins/v1/consents/:id",
    {
      preValidation: requireAuth,
      schema: {
        params: RequestId,
        body: Type.Object({ allow: Type.Boolean() }, { additionalProperties: false }),
        response: replies(Ok),
      },
    },
    async (request, reply) => {
      const pending = getPairRequest(request.params.id);
      if (!pending || pending.result || pending.userId !== request.user!.id) {
        return reply.code(404).send({ error: "That request already ended." });
      }
      if (!request.body.allow) {
        settlePairRequest(pending.id, { status: "denied" });
        return { ok: true };
      }
      if (pending.kind === "hostPreference") {
        // Lifer's window turns the preference on; the app's waiting call reads only the status.
        await setHostOpen(pending.userId, pending.pluginId, pending.openInHost ?? true);
        settlePairRequest(pending.id, { status: "approved", key: "", scopes: [] });
        return { ok: true };
      }
      const key = await issuePluginKey(pending.userId, pending.pluginId, pending.name, pending.scopes);
      settlePairRequest(pending.id, { status: "approved", key, scopes: pending.scopes });
      return { ok: true };
    },
  );

  // The user's click in Lifer that allows an app before it's installed or opened: the next launch
  // of that app pairs with exactly these scopes, once, without the consent dialog. Lifer's own
  // window only (session auth, behind the cross-site guard), so an app can't grant itself.
  const Grant = Type.Object({
    pluginId: Type.String(),
    name: Type.String(),
    scopes: Type.Array(Type.String()),
    expiresAt: DateTime(),
  });
  app.post(
    "/plugins/v1/grants",
    {
      preValidation: requireAuth,
      schema: {
        body: Type.Object({ pluginId: PluginId, name: Name, scopes: Scopes }, { additionalProperties: false }),
        response: replies(Grant),
      },
    },
    async (request, reply) => {
      if (!SINGLE_USER_MODE) return reply.code(404).send({ error: "Not found" });
      const limit = `grant:${request.user!.id}`;
      if (isRateLimited(limit, PAIR_ATTEMPTS_PER_MINUTE, 60_000)) {
        return reply.code(429).header("Retry-After", "60").send({ error: "Too many requests. Try again in a minute." });
      }
      recordAttempt(limit);
      const g = createPairGrant({ userId: request.user!.id, ...request.body, name: request.body.name.trim() });
      return { pluginId: g.pluginId, name: g.name, scopes: g.scopes, expiresAt: g.expiresAt.toISOString() };
    },
  );

  app.get(
    "/plugins/v1/grants",
    { preValidation: requireAuth, schema: { response: replies(Type.Object({ grants: Type.Array(Grant) })) } },
    async (request) => ({
      grants: pairGrants(request.user!.id).map((g) => ({
        pluginId: g.pluginId,
        name: g.name,
        scopes: g.scopes,
        expiresAt: g.expiresAt.toISOString(),
      })),
    }),
  );

  app.delete(
    "/plugins/v1/grants/:pluginId",
    { preValidation: requireAuth, schema: { params: Type.Object({ pluginId: PluginId }), response: replies(Ok) } },
    async (request) => {
      cancelPairGrant(request.user!.id, request.params.pluginId);
      return { ok: true };
    },
  );

  // Server: Settings > Connected apps shows this code for the user to type into the app.
  app.post(
    "/plugins/v1/pair-codes",
    {
      preValidation: requireAuth,
      schema: { response: replies(Type.Object({ code: Type.String(), expiresAt: DateTime() })) },
    },
    async (request, reply) => {
      if (SINGLE_USER_MODE) return reply.code(404).send({ error: "Not found" });
      const { code, expiresAt } = createPairCode(request.user!.id);
      return { code, expiresAt: expiresAt.toISOString() };
    },
  );

  // The desktop shell, after it launched an app and checked the running process, passes the
  // launch ticket's hash here (plugins.rs), and clears it when the app stops.
  app.put(
    "/plugins/v1/host-tickets/:pluginId",
    {
      preValidation: [requireAuth, requireShell],
      schema: {
        params: Type.Object({ pluginId: PluginId }),
        body: Type.Object(
          { ticketHash: Hex64, name: Name, scopes: Type.Array(Type.String({ maxLength: 100 }), { maxItems: 50 }) },
          { additionalProperties: false },
        ),
        response: replies(Ok),
      },
    },
    async (request) => {
      const { ticketHash, name, scopes } = request.body;
      setHostTicket(request.params.pluginId, ticketHash, { name, scopes });
      return { ok: true };
    },
  );

  app.delete(
    "/plugins/v1/host-tickets/:pluginId/:ticketHash",
    {
      preValidation: [requireAuth, requireShell],
      schema: { params: Type.Object({ pluginId: PluginId, ticketHash: Hex64 }), response: replies(Ok) },
    },
    async (request) => {
      clearHostTicket(request.params.pluginId, request.params.ticketHash);
      return { ok: true };
    },
  );

  await hostPreferenceRoutes(fastify);
}
