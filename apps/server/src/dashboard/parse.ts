/** Parses an absolute URL string; `null` when malformed, so callers answer 400 instead of throwing. */
export function tryParseUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/** Parses the inbound request URL; `null` when malformed, so handlers answer 400 instead of a 500. */
export function parseRequestUrl(c: { req: { url: string } }): URL | null {
  return tryParseUrl(c.req.url);
}

/**
 * Outcome of parsing a stored serialized value. A failure is reported as `ok: false` rather than as
 * a `null` value, because a JSON document that IS `null` parses successfully.
 */
export type JsonParseResult = { ok: true; value: unknown } | { ok: false };

/** Parses stored JSON text; `ok: false` on malformed input so callers fall back to the raw text, not a 500. */
export function tryParseJson(raw: string): JsonParseResult {
  try {
    return { ok: true, value: JSON.parse(raw) as unknown };
  } catch {
    return { ok: false };
  }
}
