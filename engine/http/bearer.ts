/**
 * engine/http/bearer.ts
 *
 * Pure Bearer-header parser. Returns the token string when the header is a
 * valid `Bearer <token>` (case-insensitive, whitespace-tolerant), otherwise
 * null. Tokens containing whitespace or control characters (CR/LF/NUL/TAB)
 * are rejected so a malformed header cannot smuggle additional headers
 * downstream.
 *
 * Replaces the inline regex in `startMcpHttpServer`'s auth block.
 */
export function parseBearer(headerValue: string | null | undefined): string | null {
  if (typeof headerValue !== "string") return null;
  const trimmed = headerValue.trim();
  if (trimmed.length === 0) return null;
  const match = /^bearer\s+(\S+)\s*$/i.exec(trimmed);
  if (!match) return null;
  const token = match[1];
  // Reject any control-character contamination (including CR, LF, NUL, TAB).
  if (/[\x00-\x1f\x7f]/.test(token)) return null;
  return token;
}
