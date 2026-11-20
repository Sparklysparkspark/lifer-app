// The API's Content-Security-Policy. ipc: is the desktop shell's bridge.
export function cspDirectives(desktop: boolean): Record<string, string[]> {
  return {
    defaultSrc: ["'self'"],
    baseUri: ["'self'"],
    objectSrc: ["'none'"],
    formAction: ["'self'"],
    frameAncestors: ["'none'"],
    // Desktop only: a companion app serves its page on its own loopback port, unknown until it
    // starts. The shell's navigation check (plugins.rs is_plugin_origin) narrows this to the
    // exact origin of a running app.
    ...(desktop ? { frameSrc: ["'self'", "http://127.0.0.1:*"] } : {}),
    scriptSrc: ["'self'"],
    styleSrc: ["'self'", "'unsafe-inline'"],
    imgSrc: ["'self'", "data:", "blob:", "https:"],
    mediaSrc: ["'self'", "blob:"],
    fontSrc: ["'self'", "data:"],
    workerSrc: ["'self'", "blob:"],
    connectSrc: ["'self'", "https:", "ipc:", "http://ipc.localhost"],
  };
}
