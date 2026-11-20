// The /api routes that answer without signing in, each with the reason. Everything else needs a
// session, an API key with the route's scope or, in the desktop app, the app's own credential.
// apiRoutes.test.ts fails when a route has no sign-in hook and isn't listed here, and when an entry
// here no longer matches a public route. The desktop app's request gate (index.ts) lets exactly
// these through without its credential. Keyed "METHOD /api/path", as Fastify spells the route.
export const PUBLIC_API_ROUTES: Readonly<Record<string, string>> = {
  "GET /api/auth/setup-status": "The setup page asks whether the account exists yet; answers a yes or no only.",
  "POST /api/auth/register": "Creates the first account; refused once any account exists.",
  "POST /api/auth/login": "Signing in. Rate limited per email and address.",
  "POST /api/auth/logout": "Ends the caller's own session, if any.",
  "GET /api/auth/me": "Says who the caller is, or null; reveals nothing to a signed-out caller.",
  "POST /api/auth/desktop-session":
    "The desktop app's window trades the launch secret for its cookie; checks the secret itself, and 404s outside desktop mode.",
  "GET /api/sync/link/proof":
    "A linked desktop app asks the server to prove it is the one it linked to, before sending its key; answers a nonce with an HMAC only this server can make. Rate limited.",
  "GET /api/share/:token": "A share link's album, for visitors with the link.",
  "POST /api/share/:token/unlock": "A visitor enters a share link's password. Rate limited.",
  "GET /api/share/:token/photos/:photoId/display": "A shared album's photo, for visitors with the link.",
  "GET /api/share/:token/photos/:photoId/thumb": "A shared album's thumbnail, for visitors with the link.",
  "GET /api/p/:token": "A published portfolio's photos page, for visitors with the link.",
  "GET /api/p/:token/life-list": "A published portfolio's life list page, for visitors with the link.",
  "GET /api/p/:token/photos/:file": "A published portfolio's photo, for visitors with the link.",
  "GET /api/openapi.json": "The API description; the same for everyone and contains no data.",
  "GET /api/inaturalist/callback":
    "iNaturalist's sign-in redirect, which carries no Lifer cookie; acts only on a state value a signed-in user started.",
  "POST /api/plugins/v1/pair":
    "A companion app trades a desktop launch ticket (then the user's consent) or a server pairing code for its key. Rate limited.",
  "POST /api/plugins/v1/pair-requests":
    "A desktop companion app asks to connect; nothing is granted until the user allows it in Lifer's window. Rate limited.",
  "POST /api/companion/v1/pair":
    "A phone trades a one-time pairing code (or, on a server, a signed-in session) for its device key. Rate limited.",
  "POST /api/companion/v1/pair/start":
    "Typed pairing with a computer: a key exchange keyed by the live pairing code; each run spends one of the code's few guesses. Rate limited.",
  "POST /api/companion/v1/pair/finish":
    "Typed pairing, step 2: a key is issued only for a random session whose tag proves the code. One try per session.",
  "GET /api/plugins/v1/pair-requests/:id":
    "The app collects the answer to its request by the request's secret random id.",
};

/** "GET /api/x" for a request: HEAD is answered by the GET route. */
export function publicRouteKey(method: string, routeUrl: string): string {
  return `${method === "HEAD" ? "GET" : method} ${routeUrl}`;
}

export function isPublicApiRoute(method: string, routeUrl: string | undefined): boolean {
  return !!routeUrl && Object.hasOwn(PUBLIC_API_ROUTES, publicRouteKey(method, routeUrl));
}
