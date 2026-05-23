/**
 * specs/chunker.test.ts
 *
 * Unit tests for engine/chunker.ts - Smart chunking and break point detection.
 */

import { describe, test, expect } from "vitest";
import {
  CHUNK_SIZE_TOKENS,
  CHUNK_OVERLAP_TOKENS,
  CHUNK_SIZE_CHARS,
  CHUNK_OVERLAP_CHARS,
  CHUNK_WINDOW_TOKENS,
  CHUNK_WINDOW_CHARS,
  BREAK_PATTERNS,
  scanBreakPoints,
  findCodeFences,
  isInsideCodeFence,
  findBestCutoff,
  type BreakPoint,
  type CodeFenceRegion,
} from "../engine/chunker.js";

describe("chunker", () => {
  describe("constants", () => {
    test("CHUNK_SIZE_TOKENS is 900", () => {
      expect(CHUNK_SIZE_TOKENS).toBe(900);
    });

    test("CHUNK_OVERLAP_TOKENS is 15% of CHUNK_SIZE_TOKENS", () => {
      expect(CHUNK_OVERLAP_TOKENS).toBe(135);
    });

    test("CHUNK_SIZE_CHARS is 4x CHUNK_SIZE_TOKENS", () => {
      expect(CHUNK_SIZE_CHARS).toBe(3600);
    });

    test("CHUNK_OVERLAP_CHARS is 4x CHUNK_OVERLAP_TOKENS", () => {
      expect(CHUNK_OVERLAP_CHARS).toBe(540);
    });

    test("CHUNK_WINDOW_TOKENS is 200", () => {
      expect(CHUNK_WINDOW_TOKENS).toBe(200);
    });

    test("CHUNK_WINDOW_CHARS is 4x CHUNK_WINDOW_TOKENS", () => {
      expect(CHUNK_WINDOW_CHARS).toBe(800);
    });
  });

  describe("BREAK_PATTERNS", () => {
    test("is an array of [RegExp, number, string] tuples", () => {
      expect(Array.isArray(BREAK_PATTERNS)).toBe(true);
      expect(BREAK_PATTERNS.length).toBeGreaterThan(0);
      for (const [pattern, score, type] of BREAK_PATTERNS) {
        expect(pattern).toBeInstanceOf(RegExp);
        expect(typeof score).toBe("number");
        expect(typeof type).toBe("string");
      }
    });

    test("has h1 pattern with highest score", () => {
      const h1 = BREAK_PATTERNS.find(([_, __, type]) => type === "h1");
      expect(h1).toBeDefined();
      expect(h1![1]).toBe(100);
    });

    test("has newline pattern with lowest score", () => {
      const newline = BREAK_PATTERNS.find(([_, __, type]) => type === "newline");
      expect(newline).toBeDefined();
      expect(newline![1]).toBe(1);
    });
  });

  describe("scanBreakPoints", () => {
    test("returns empty array for empty text", () => {
      expect(scanBreakPoints("")).toEqual([]);
    });

    test("finds h1 headings", () => {
      const text = "# Heading 1\n\nSome content\n\n# Another Heading";
      const points = scanBreakPoints(text);
      const h1Points = points.filter(p => p.type === "h1");
      expect(h1Points.length).toBeGreaterThan(0);
    });

    test("finds h2 headings", () => {
      const text = "## Heading 2\n\nSome content\n\n## Another";
      const points = scanBreakPoints(text);
      const h2Points = points.filter(p => p.type === "h2");
      expect(h2Points.length).toBeGreaterThan(0);
    });

    test("finds paragraph boundaries", () => {
      const text = "Paragraph 1\n\nParagraph 2\n\nParagraph 3";
      const points = scanBreakPoints(text);
      const blankPoints = points.filter(p => p.type === "blank");
      expect(blankPoints.length).toBeGreaterThan(0);
    });

    test("finds code blocks", () => {
      const text = "Text\n\n```javascript\ncode\n```\n\nMore text";
      const points = scanBreakPoints(text);
      const codePoints = points.filter(p => p.type === "codeblock");
      expect(codePoints).toHaveLength(2); // opening and closing
    });

    test("returns points sorted by position", () => {
      const text = "# First\n\nParagraph\n\n## Second\n\nMore text";
      const points = scanBreakPoints(text);
      for (let i = 1; i < points.length; i++) {
        expect(points[i].pos).toBeGreaterThanOrEqual(points[i - 1].pos);
      }
    });

    test("keeps highest score when multiple patterns match same position", () => {
      const text = "# Heading\n\nParagraph";
      const points = scanBreakPoints(text);
      // The position after "# Heading\n" should be a blank (paragraph boundary)
      const blankPoints = points.filter(p => p.type === "blank");
      expect(blankPoints.length).toBeGreaterThan(0);
      // Each position should appear only once
      const positions = points.map(p => p.pos);
      expect(new Set(positions).size).toBe(positions.length);
    });
  });

  describe("findCodeFences", () => {
    test("returns empty array for text without code fences", () => {
      expect(findCodeFences("No code fences here")).toEqual([]);
    });

    test("finds single code fence", () => {
      const text = "Text\n```\ncode\n```\nMore text";
      const fences = findCodeFences(text);
      expect(fences).toHaveLength(1);
      expect(fences[0].start).toBeLessThan(fences[0].end);
    });

    test("finds multiple code fences", () => {
      const text = "```\ncode1\n```\nText\n```\ncode2\n```";
      const fences = findCodeFences(text);
      expect(fences).toHaveLength(2);
    });

    test("handles unclosed code fence", () => {
      const text = "Text\n```\ncode without closing";
      const fences = findCodeFences(text);
      expect(fences).toHaveLength(1);
      expect(fences[0].end).toBe(text.length);
    });

    test("handles code fence at start of document", () => {
      const text = "```\ncode\n```";
      const fences = findCodeFences(text);
      expect(fences).toHaveLength(1);
      expect(fences[0].start).toBe(0);
    });
  });

  describe("isInsideCodeFence", () => {
    test("returns false for empty fences array", () => {
      expect(isInsideCodeFence(5, [])).toBe(false);
    });

    test("returns true for position inside fence", () => {
      const fences: CodeFenceRegion[] = [{ start: 5, end: 20 }];
      expect(isInsideCodeFence(10, fences)).toBe(true);
    });

    test("returns false for position outside fence", () => {
      const fences: CodeFenceRegion[] = [{ start: 5, end: 20 }];
      expect(isInsideCodeFence(25, fences)).toBe(false);
    });

    test("returns false for position at fence boundary", () => {
      const fences: CodeFenceRegion[] = [{ start: 5, end: 20 }];
      expect(isInsideCodeFence(5, fences)).toBe(false);
      expect(isInsideCodeFence(20, fences)).toBe(false);
    });

    test("checks multiple fences", () => {
      const fences: CodeFenceRegion[] = [
        { start: 5, end: 20 },
        { start: 30, end: 45 },
      ];
      expect(isInsideCodeFence(10, fences)).toBe(true);
      expect(isInsideCodeFence(35, fences)).toBe(true);
      expect(isInsideCodeFence(25, fences)).toBe(false);
    });
  });

  describe("findBestCutoff", () => {
    test("returns target position when no break points in window", () => {
      const breakPoints: BreakPoint[] = [];
      expect(findBestCutoff(breakPoints, 1000)).toBe(1000);
    });

    test("prefers heading over paragraph break", () => {
      const breakPoints: BreakPoint[] = [
        { pos: 900, score: 20, type: "blank" },
        { pos: 950, score: 100, type: "h1" },
      ];
      const cutoff = findBestCutoff(breakPoints, 1000, 800);
      expect(cutoff).toBe(950);
    });

    test("applies distance decay", () => {
      const breakPoints: BreakPoint[] = [
        { pos: 200, score: 100, type: "h1" },  // far from target
        { pos: 950, score: 20, type: "blank" },  // near target
      ];
      const cutoff = findBestCutoff(breakPoints, 1000, 800);
      // The h1 point should still win despite distance because its score is much higher
      expect(cutoff).toBe(200);
    });

    test("skips break points inside code fences", () => {
      const breakPoints: BreakPoint[] = [
        { pos: 900, score: 100, type: "h1" },
      ];
      const codeFences: CodeFenceRegion[] = [{ start: 850, end: 950 }];
      const cutoff = findBestCutoff(breakPoints, 1000, 800, 0.7, codeFences);
      expect(cutoff).toBe(1000); // falls back to target
    });

    test("respects window size", () => {
      const breakPoints: BreakPoint[] = [
        { pos: 100, score: 100, type: "h1" },  // outside window
        { pos: 900, score: 20, type: "blank" },  // inside window
      ];
      const cutoff = findBestCutoff(breakPoints, 1000, 200);
      expect(cutoff).toBe(900);
    });

    test("uses custom decay factor", () => {
      const breakPoints: BreakPoint[] = [
        { pos: 500, score: 100, type: "h1" },
        { pos: 950, score: 20, type: "blank" },
      ];
      const cutoff = findBestCutoff(breakPoints, 1000, 800, 0.99);
      expect(cutoff).toBe(500);
    });
  });
});
