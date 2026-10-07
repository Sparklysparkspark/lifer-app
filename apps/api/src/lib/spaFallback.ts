// Which unmatched paths the built web app answers with index.html, so its own router can take
// them. API and offline-map paths are real resources: a missing one must be a 404, or the web app
// reads the HTML as the file (a map that was never downloaded would look present).
const RESOURCE_ROOTS = ["/api", "/maps"];

export function servesWebApp(url: string): boolean {
  const pathOnly = url.split("?")[0];
  return !RESOURCE_ROOTS.some((root) => pathOnly === root || pathOnly.startsWith(`${root}/`));
}
