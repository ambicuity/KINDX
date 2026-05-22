/**
 * engine/http/body.ts
 *
 * Pure helper for reading an HTTP request body with a hard byte cap.
 * Extracted from engine/protocol.ts so it can be unit-tested directly.
 * Behavior must remain identical to the inline closure it replaces.
 */
import type { IncomingMessage } from "node:http";

export class BodyTooLargeError extends Error {
  readonly limitBytes: number;
  constructor(limitBytes: number) {
    super(`request body exceeds ${limitBytes} bytes`);
    this.name = "BodyTooLargeError";
    this.limitBytes = limitBytes;
  }
}

/**
 * Read the full request body into a UTF-8 string, throwing
 * `BodyTooLargeError` once cumulative bytes exceed `capBytes`.
 *
 * On overflow the request stream is paused (not destroyed) so the caller
 * can write a 413 response before the socket closes. This matches the
 * behavior of the inline `collectBody` in `engine/protocol.ts`.
 */
export async function collectBody(req: IncomingMessage, capBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > capBytes) {
      try { req.pause(); } catch { /* noop */ }
      throw new BodyTooLargeError(capBytes);
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf-8");
}
