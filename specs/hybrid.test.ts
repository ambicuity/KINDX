/**
 * specs/hybrid.test.ts
 *
 * Unit tests for engine/repository/retrieval/hybrid.ts - Hybrid search orchestrator.
 */

import { describe, test, expect } from "vitest";
import {
  detectContentType,
  extractSchemaFromBody,
} from "../engine/repository/retrieval/hybrid.js";

describe("hybrid", () => {
  describe("detectContentType", () => {
    test("detects text content", () => {
      expect(detectContentType("Hello world", "file.txt")).toBe("text");
      expect(detectContentType("# Markdown", "README.md")).toBe("text");
    });

    test("detects image content by extension", () => {
      expect(detectContentType("", "image.png")).toBe("image");
      expect(detectContentType("", "photo.jpg")).toBe("image");
      expect(detectContentType("", "picture.jpeg")).toBe("image");
      expect(detectContentType("", "animation.gif")).toBe("image");
      expect(detectContentType("", "image.webp")).toBe("image");
    });

    test("detects CSV content by extension", () => {
      expect(detectContentType("", "data.csv")).toBe("csv");
    });

    test("detects JSON content by extension", () => {
      expect(detectContentType("", "config.json")).toBe("json");
    });

    test("detects CSV content by body pattern", () => {
      const body = "Schema: name,age\nRows 100\nJohn,30";
      expect(detectContentType(body, "data.txt")).toBe("csv");
    });

    test("detects JSON content by body pattern", () => {
      const body = 'Schema: name:string,age:number\nItems 100\n{"name":"John"}';
      expect(detectContentType(body, "data.txt")).toBe("json");
    });

    test("defaults to text for unknown extensions", () => {
      expect(detectContentType("content", "file.xyz")).toBe("text");
    });
  });

  describe("extractSchemaFromBody", () => {
    test("extracts schema from body", () => {
      const body = "Schema: name:string,age:number\nSome data here";
      const schema = extractSchemaFromBody(body);
      expect(schema).toEqual({ name: "string", age: "number" });
    });

    test("returns undefined when no schema", () => {
      const body = "Just some text without schema";
      expect(extractSchemaFromBody(body)).toBeUndefined();
    });

    test("handles empty schema", () => {
      const body = "Schema: \nSome data";
      expect(extractSchemaFromBody(body)).toBeUndefined();
    });

    test("handles malformed schema", () => {
      const body = "Schema: invalid-format\nSome data";
      expect(extractSchemaFromBody(body)).toBeUndefined();
    });
  });
});
