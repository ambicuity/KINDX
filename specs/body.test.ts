/**
 * specs/body.test.ts
 *
 * Unit tests for engine/http/body.ts - HTTP body parser.
 */

import { describe, test, expect } from "vitest";
import { BodyTooLargeError } from "../engine/http/body.js";

describe("body", () => {
  describe("BodyTooLargeError", () => {
    test("creates error with limit bytes", () => {
      const error = new BodyTooLargeError(1024);
      expect(error.limitBytes).toBe(1024);
      expect(error.message).toContain("1024");
    });

    test("has correct name", () => {
      const error = new BodyTooLargeError(1024);
      expect(error.name).toBe("BodyTooLargeError");
    });

    test("is instance of Error", () => {
      const error = new BodyTooLargeError(1024);
      expect(error).toBeInstanceOf(Error);
    });
  });

  describe("collectBody", () => {
    test("is exported function", async () => {
      const { collectBody } = await import("../engine/http/body.js");
      expect(typeof collectBody).toBe("function");
    });
  });
});
