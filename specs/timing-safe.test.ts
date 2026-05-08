import { describe, expect, test } from "vitest";
import { timingSafeBufferEqual, timingSafeStringEqual } from "../engine/utils/timing-safe.js";

describe("timingSafeStringEqual", () => {
  test("returns true for equal strings", () => {
    expect(timingSafeStringEqual("hello", "hello")).toBe(true);
    expect(timingSafeStringEqual("", "")).toBe(true);
    expect(timingSafeStringEqual("a".repeat(1000), "a".repeat(1000))).toBe(true);
  });

  test("returns false for different strings of equal length", () => {
    expect(timingSafeStringEqual("hello", "world")).toBe(false);
  });

  test("returns false for strings of different lengths without throwing", () => {
    expect(timingSafeStringEqual("a", "abc")).toBe(false);
    expect(timingSafeStringEqual("longer", "x")).toBe(false);
  });

  test("returns false when first byte matches but rest differ", () => {
    expect(timingSafeStringEqual("abcdef", "abcdeg")).toBe(false);
  });

  test("handles unicode strings correctly", () => {
    expect(timingSafeStringEqual("é", "é")).toBe(true);
    expect(timingSafeStringEqual("é", "e")).toBe(false);
  });
});

describe("timingSafeBufferEqual", () => {
  test("returns true for equal buffers", () => {
    expect(timingSafeBufferEqual(Buffer.from([1, 2, 3]), Buffer.from([1, 2, 3]))).toBe(true);
  });

  test("returns false for different buffers of equal length", () => {
    expect(timingSafeBufferEqual(Buffer.from([1, 2, 3]), Buffer.from([1, 2, 4]))).toBe(false);
  });

  test("returns false for buffers of different lengths without throwing", () => {
    expect(timingSafeBufferEqual(Buffer.from([1, 2]), Buffer.from([1, 2, 3]))).toBe(false);
  });

  test("compares 64-char hex digest reliably (token-hash use case)", () => {
    const a = "f".repeat(64);
    const b = "f".repeat(64);
    const c = "f".repeat(63) + "e";
    expect(timingSafeStringEqual(a, b)).toBe(true);
    expect(timingSafeStringEqual(a, c)).toBe(false);
  });
});
