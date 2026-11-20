// A connected app's "open inside Lifer from now on" preference, and asking Lifer to open it.
// The app can only ask: the preference changes through the same consent dialog as pairing, or
// through the switch in Settings > Connected apps. Desktop only, since only the desktop app has
// app frames and a window to bring forward. Any paired app's key may call these, including keys
// paired before the host.preference scope existed; they open nothing else.
import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Type } from "typebox";
import { SINGLE_USER_MODE } from "@lifer/core/config.js";
import { pool } from "@lifer/core/db.js";
import { Ok, replies, withSchemas } from "../lib/schema.js";
import { hashApiKey } from "../auth/apiKeys.js";
import { requireAuth, requireScope } from "../auth/session.js";
import { isRateLimited, recordAttempt } from "../auth/rateLimiter.js";
import { cancelPairRequest, createPairRequest, pendingPairRequests } from "./pairing.js";

export const HOST_SCOPE = "host.preference";
// Lifer's window checks for opens every 2 s; one that hasn't for this long isn't showing this
// library (it's connected to a server) or isn't open at all.
const POLL_STALE_MS = 10_000;
// Then it has this long to take the request, and this long to show the app's frame.
export const CLAIM_WAIT_MS = 5_000;
export const SHOW_WAIT_MS = 30_000;
// The scopes every paired app holds at least one of.
const ANY_APP_SCOPE = ["userdata.read", "userdata.write", "imports.write", "opendata.read"];
const CALLS_PER_MINUTE = 10;

const PluginId = Type.String({ pattern: "^[A-Za-z0-9-]+(\\.[A-Za-z0-9-]+)+$", maxLength: 200 });
const Preference = Type.Object({ openInHost: Type.Boolean() });
const Decision = Type.Object({ granted: Type.Boolean(), openInHost: Type.Boolean() });
const OpenResult = Type.Union([
  Type.Object({ ok: Type.Literal(true) }),
  Type.Object({
    ok: Type.Literal(false),
    reason: Type.Union([Type.Literal("busy"), Type.Literal("not_ready"), Type.Literal("no_frame")]),
  }),
]);
type OpenResultT = { ok: true } | { ok: false; reason: "busy" | "not_ready" | "no_frame" };

interface PairedApp {
  userId: string;
  pluginId: string;
  name: string;
  hostOpen: boolean;
}

const SELECT = `SELECT user_id, plugin_id, name, host_open FROM api_keys`;
const toApp = (r: { user_id: string; plugin_id: string; name: string; host_open: boolean } | undefined) =>
  r ? { userId: r.user_id, pluginId: r.plugin_id, name: r.name, hostOpen: r.host_open } : null;

/** The paired app behind the request's key. A key the user made by hand has no app, and Lifer's
 *  own window passes requireScope too but isn't an app, so both get null here. */
async function appFromKey(request: FastifyRequest): Promise<PairedApp | null> {
  const token = request.headers["x-api-key"];
  if (typeof token !== "string" || !token) return null;
  const res = await pool.query(`${SELECT} WHERE key_hash = $1 AND plugin_id IS NOT NULL`, [hashApiKey(token)]);
  return toApp(res.rows[0]);
}

/** A paired app of this user; anything else is not an app Lifer knows. */
async function pairedApp(userId: string, pluginId: string): Promise<PairedApp | null> {
  const res = await pool.query(`${SELECT} WHERE user_id = $1 AND plugin_id = $2`, [userId, pluginId]);
  return toApp(res.rows[0]);
}

export async function setHostOpen(userId: string, pluginId: string, open: boolean): Promise<boolean> {
  const res = await pool.query(`UPDATE api_keys SET host_open = $3 WHERE user_id = $1 AND plugin_id = $2`, [
    userId,
    pluginId,
    open,
  ]);
  return (res.rowCount ?? 0) > 0;
}

/** False once it has replied with 429. Per app, so one app can't use up another's budget. */
function admit(pluginId: string, reply: FastifyReply): boolean {
  const key = `host:${pluginId}`;
  if (isRateLimited(key, CALLS_PER_MINUTE, 60_000)) {
    reply.code(429).header("Retry-After", "60").send({ error: "Too many requests. Try again in a minute." });
    return false;
  }
  recordAttempt(key);
  return true;
}

/** Shows the confirm dialog in Lifer's window (the consent queue) and waits for the answer. One
 *  dialog per app and answer: a second ask while one waits joins it. "Not now" and expiry change
 *  nothing. Asking for what's already set needs no dialog. */
async function ask(
  app: PairedApp,
  want: boolean,
  reply: FastifyReply,
): Promise<{ granted: boolean; openInHost: boolean }> {
  if (app.hostOpen === want) return { granted: true, openInHost: want };
  const waiting = pendingPairRequests(app.userId).find(
    (r) => r.kind === "hostPreference" && r.pluginId === app.pluginId && r.openInHost === want,
  );
  const pending =
    waiting ??
    createPairRequest({
      userId: app.userId,
      pluginId: app.pluginId,
      name: app.name,
      scopes: [],
      code: null,
      kind: "hostPreference",
      openInHost: want,
    });
  if (!waiting) reply.raw.once("close", () => cancelPairRequest(pending.id));
  const result = await pending.done;
  const granted = result.status === "approved";
  return { granted, openInHost: granted ? want : app.hostOpen };
}

// ---- Opening an app in Lifer's window ----

interface PendingOpen {
  id: string;
  userId: string;
  pluginId: string;
  claimed: boolean;
  claim: () => void;
  settle: (r: OpenResultT) => void;
}
const opens = new Map<string, PendingOpen>();
// When each user's window last checked for opens.
const lastPoll = new Map<string, number>();

function requestOpen(userId: string, pluginId: string): Promise<OpenResultT> {
  // shortcut: a window that stopped polling reads as no_frame; a shell signal would tell a
  // server-connected window from a closed one, if the two ever need different answers.
  if (Date.now() - (lastPoll.get(userId) ?? 0) > POLL_STALE_MS)
    return Promise.resolve({ ok: false, reason: "no_frame" });
  // A dialog already waits for the person: opening an app now would pull the window out from under it.
  const busy =
    pendingPairRequests(userId).length > 0 ||
    [...opens.values()].some((o) => o.userId === userId && o.pluginId === pluginId);
  if (busy) return Promise.resolve({ ok: false, reason: "busy" });
  const id = randomBytes(16).toString("hex");
  return new Promise((resolve) => {
    let timer = setTimeout(() => settle({ ok: false, reason: "not_ready" }), CLAIM_WAIT_MS);
    timer.unref();
    function settle(r: OpenResultT) {
      if (!opens.delete(id)) return;
      clearTimeout(timer);
      resolve(r);
    }
    const open: PendingOpen = {
      id,
      userId,
      pluginId,
      claimed: false,
      claim: () => {
        open.claimed = true;
        clearTimeout(timer);
        timer = setTimeout(() => settle({ ok: false, reason: "not_ready" }), SHOW_WAIT_MS);
        timer.unref();
      },
      settle,
    };
    opens.set(id, open);
  });
}

// For tests.
export function resetHostOpens(): void {
  for (const o of opens.values()) o.settle({ ok: false, reason: "not_ready" });
  lastPoll.clear();
}

async function requireDesktop(_request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!SINGLE_USER_MODE) reply.code(404).send({ error: "Not found" });
}

const NOT_AN_APP = "Only a connected app can call this.";
const NOT_PAIRED = "That app isn't connected.";

export async function hostPreferenceRoutes(fastify: FastifyInstance): Promise<void> {
  const app = withSchemas(fastify);
  // Older keys hold only the scopes they paired with; any of them reaches these routes and no others.
  const scope = requireScope(HOST_SCOPE, ANY_APP_SCOPE);

  // ---- For the connected app, with its key ----

  app.get(
    "/plugins/v1/host-preference",
    { preValidation: [scope, requireDesktop], schema: { response: replies(Preference) } },
    async (request, reply) => {
      const paired = await appFromKey(request);
      if (!paired) return reply.code(403).send({ error: NOT_AN_APP });
      return { openInHost: paired.hostOpen };
    },
  );

  app.post(
    "/plugins/v1/host-preference/request",
    {
      preValidation: [scope, requireDesktop],
      schema: {
        body: Type.Object({ openInHost: Type.Boolean() }, { additionalProperties: false }),
        response: replies(Decision),
      },
    },
    async (request, reply) => {
      const paired = await appFromKey(request);
      if (!paired) return reply.code(403).send({ error: NOT_AN_APP });
      if (!admit(paired.pluginId, reply)) return reply;
      return ask(paired, request.body.openInHost, reply);
    },
  );

  app.post(
    "/plugins/v1/host/open",
    {
      preValidation: [scope, requireDesktop],
      schema: {
        body: Type.Object({ pluginId: PluginId }, { additionalProperties: false }),
        response: replies(OpenResult),
      },
    },
    async (request, reply) => {
      const paired = await appFromKey(request);
      if (!paired) return reply.code(403).send({ error: NOT_AN_APP });
      // An app opens only itself, and only once the person said yes.
      if (request.body.pluginId !== paired.pluginId)
        return reply.code(403).send({ error: "An app can only open itself." });
      if (!paired.hostOpen) return reply.code(403).send({ error: "Opening inside Lifer is turned off for this app." });
      if (!admit(paired.pluginId, reply)) return reply;
      return requestOpen(paired.userId, paired.pluginId);
    },
  );

  // ---- For Lifer's own window ----

  const AppParams = Type.Object({ pluginId: PluginId });

  app.get(
    "/plugins/v1/apps/:pluginId/host-preference",
    { preValidation: [requireAuth, requireDesktop], schema: { params: AppParams, response: replies(Preference) } },
    async (request, reply) => {
      const paired = await pairedApp(request.user!.id, request.params.pluginId);
      if (!paired) return reply.code(404).send({ error: NOT_PAIRED });
      return { openInHost: paired.hostOpen };
    },
  );

  // The Settings switch: the person's own choice, either way.
  app.put(
    "/plugins/v1/apps/:pluginId/host-preference",
    {
      preValidation: [requireAuth, requireDesktop],
      schema: {
        params: AppParams,
        body: Type.Object({ openInHost: Type.Boolean() }, { additionalProperties: false }),
        response: replies(Preference),
      },
    },
    async (request, reply) => {
      const { pluginId } = request.params;
      if (!(await pairedApp(request.user!.id, pluginId))) return reply.code(404).send({ error: NOT_PAIRED });
      await setHostOpen(request.user!.id, pluginId, request.body.openInHost);
      return { openInHost: request.body.openInHost };
    },
  );

  // An app shown in Lifer's frame asks through the host protocol; Lifer's window relays it here.
  app.post(
    "/plugins/v1/apps/:pluginId/host-preference/request",
    {
      preValidation: [requireAuth, requireDesktop],
      schema: {
        params: AppParams,
        body: Type.Object({ openInHost: Type.Boolean() }, { additionalProperties: false }),
        response: replies(Decision),
      },
    },
    async (request, reply) => {
      const paired = await pairedApp(request.user!.id, request.params.pluginId);
      if (!paired) return reply.code(404).send({ error: NOT_PAIRED });
      if (!admit(paired.pluginId, reply)) return reply;
      return ask(paired, request.body.openInHost, reply);
    },
  );

  // Lifer's window polls this, claims each open, brings itself forward and shows the app's frame.
  // The GET only records when the window last looked.
  app.get(
    "/plugins/v1/host/opens",
    {
      preValidation: [requireAuth, requireDesktop],
      schema: {
        response: replies(
          Type.Object({ opens: Type.Array(Type.Object({ id: Type.String(), pluginId: Type.String() })) }),
        ),
      },
    },
    async (request) => {
      lastPoll.set(request.user!.id, Date.now());
      return {
        opens: [...opens.values()]
          .filter((o) => o.userId === request.user!.id && !o.claimed)
          .map((o) => ({ id: o.id, pluginId: o.pluginId })),
      };
    },
  );

  // Taken: the window is bringing itself forward and starting the app's frame.
  app.post(
    "/plugins/v1/host/opens/:id/claim",
    {
      preValidation: [requireAuth, requireDesktop],
      schema: { params: Type.Object({ id: Type.String({ pattern: "^[0-9a-f]{32}$" }) }), response: replies(Ok) },
    },
    async (request, reply) => {
      const open = opens.get(request.params.id);
      if (!open || open.claimed || open.userId !== request.user!.id)
        return reply.code(404).send({ error: "That request already ended." });
      open.claim();
      return { ok: true };
    },
  );

  app.post(
    "/plugins/v1/host/opens/:id",
    {
      preValidation: [requireAuth, requireDesktop],
      schema: {
        params: Type.Object({ id: Type.String({ pattern: "^[0-9a-f]{32}$" }) }),
        body: Type.Object({ ok: Type.Boolean() }, { additionalProperties: false }),
        response: replies(Ok),
      },
    },
    // ok: the frame is on screen.
    async (request, reply) => {
      const open = opens.get(request.params.id);
      if (!open || open.userId !== request.user!.id)
        return reply.code(404).send({ error: "That request already ended." });
      open.settle(request.body.ok ? { ok: true } : { ok: false, reason: "not_ready" });
      return { ok: true };
    },
  );
}
