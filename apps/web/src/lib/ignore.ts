/** A .catch handler for best-effort work whose failure the user doesn't need to see: it's logged
 *  (so it isn't invisible when debugging) and otherwise dropped. A cancelled request isn't logged. */
export function ignore(reason: string): (err: unknown) => void {
  return (err) => {
    if (err instanceof DOMException && err.name === "AbortError") return;
    console.warn(`${reason}:`, err);
  };
}
