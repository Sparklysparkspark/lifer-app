// Pure helpers for serving files: RFC 6266 Content-Disposition and single-range parsing.

// ASCII fallback for old clients plus filename* (RFC 5987) so non-Latin names don't break
// the header (Node rejects non-Latin1 header values, which surfaced as a 500).
export function contentDisposition(filename: string, type: "attachment" | "inline" = "attachment"): string {
  const fallback = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${type}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

export type RangeResult = { kind: "full" } | { kind: "partial"; start: number; end: number } | { kind: "unsatisfiable" };

// Only single byte ranges are honored. Multi-range, other units and malformed headers fall
// back to a full 200 response, as RFC 9110 allows.
export function parseRange(header: string | undefined, size: number): RangeResult {
  if (!header) return { kind: "full" };
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return { kind: "full" };
  const [, startStr, endStr] = match;
  if (startStr === "" && endStr === "") return { kind: "full" };

  if (startStr === "") {
    // Suffix range: the last N bytes.
    const suffix = Number(endStr);
    if (suffix === 0 || size === 0) return { kind: "unsatisfiable" };
    return { kind: "partial", start: Math.max(0, size - suffix), end: size - 1 };
  }

  const start = Number(startStr);
  if (start >= size) return { kind: "unsatisfiable" };
  const end = endStr === "" ? size - 1 : Math.min(Number(endStr), size - 1);
  if (end < start) return { kind: "full" };
  return { kind: "partial", start, end };
}
