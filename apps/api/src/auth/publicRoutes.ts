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
  "GET /api/share/:token": "A share link's album, for visitors with the link.",
  "POST /api/share/:token/unlock": "A visitor enters a share link's password. Rate limited.",
  "GET /api/share/:token/photos/:photoId/display": "A shared album's photo, for visitors with the link.",
  "GET /api/share/:token/photos/:photoId/thumb": "A shared album's thumbnail, for visitors with the link.",
  "GET /api/openapi.json": "The API description; the same for everyone and contains no data.",
  "GET /api/inaturalist/callback":
    "iNaturalist's sign-in redirect, which carries no Lifer cookie; acts only on a state value a signed-in user started.",
};

/** "GET /api/x" for a request: HEAD is answered by the GET route. */
export function publicRouteKey(method: string, routeUrl: string): string {
  return `${method === "HEAD" ? "GET" : method} ${routeUrl}`;
}

export function isPublicApiRoute(method: string, routeUrl: string | undefined): boolean {
  return !!routeUrl && Object.hasOwn(PUBLIC_API_ROUTES, publicRouteKey(method, routeUrl));
}
