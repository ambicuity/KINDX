/**
 * store-chunking-boundaries.test.ts - Break point detection, code fences, and cutoff selection tests
 *
 * Split from store.test.ts for focused testing.
 */

import { describe, test, expect } from "vitest";
import {
  scanBreakPoints,
  findCodeFences,
  isInsideCodeFence,
  findBestCutoff,
  type BreakPoint,
  type CodeFenceRegion,
} from "../engine/repository.js";

describe("scanBreakPoints", () => {
  test("detects h1 headings", () => {
    const text = "Intro\n# Heading 1\nMore text";
    const breaks = scanBreakPoints(text);
    const h1 = breaks.find(b => b.type === 'h1');
    expect(h1).toBeDefined();
    expect(h1!.score).toBe(100);
    expect(h1!.pos).toBe(5); // position of \n#
  });

  test("detects multiple heading levels", () => {
    const text = "Text\n# H1\n## H2\n### H3\nMore";
    const breaks = scanBreakPoints(text);

    const h1 = breaks.find(b => b.type === 'h1');
    const h2 = breaks.find(b => b.type === 'h2');
    const h3 = breaks.find(b => b.type === 'h3');

    expect(h1).toBeDefined();
    expect(h2).toBeDefined();
    expect(h3).toBeDefined();
    expect(h1!.score).toBe(100);
    expect(h2!.score).toBe(90);
    expect(h3!.score).toBe(80);
  });

  test("detects code blocks", () => {
    const text = "Before\n```js\ncode\n```\nAfter";
    const breaks = scanBreakPoints(text);
    const codeBlocks = breaks.filter(b => b.type === 'codeblock');
    expect(codeBlocks.length).toBe(2); // opening and closing
    expect(codeBlocks[0]!.score).toBe(80);
  });

  test("detects horizontal rules", () => {
    const text = "Text\n---\nMore text";
    const breaks = scanBreakPoints(text);
    const hr = breaks.find(b => b.type === 'hr');
    expect(hr).toBeDefined();
    expect(hr!.score).toBe(60);
  });

  test("detects blank lines (paragraph boundaries)", () => {
    const text = "First paragraph.\n\nSecond paragraph.";
    const breaks = scanBreakPoints(text);
    const blank = breaks.find(b => b.type === 'blank');
    expect(blank).toBeDefined();
    expect(blank!.score).toBe(20);
  });

  test("detects list items", () => {
    const text = "Intro\n- Item 1\n- Item 2\n1. Numbered";
    const breaks = scanBreakPoints(text);

    const lists = breaks.filter(b => b.type === 'list');
    const numLists = breaks.filter(b => b.type === 'numlist');

    expect(lists.length).toBe(2);
    expect(numLists.length).toBe(1);
    expect(lists[0]!.score).toBe(5);
    expect(numLists[0]!.score).toBe(5);
  });

  test("detects newlines as fallback", () => {
    const text = "Line 1\nLine 2\nLine 3";
    const breaks = scanBreakPoints(text);
    const newlines = breaks.filter(b => b.type === 'newline');
    expect(newlines.length).toBe(2);
    expect(newlines[0]!.score).toBe(1);
  });

  test("returns breaks sorted by position", () => {
    const text = "A\n# B\n\nC\n## D";
    const breaks = scanBreakPoints(text);
    for (let i = 1; i < breaks.length; i++) {
      expect(breaks[i]!.pos).toBeGreaterThan(breaks[i - 1]!.pos);
    }
  });

  test("higher-scoring pattern wins at same position", () => {
    // \n# matches both newline (score 1) and h1 (score 100)
    const text = "Text\n# Heading";
    const breaks = scanBreakPoints(text);
    const atPos = breaks.filter(b => b.pos === 4);
    expect(atPos.length).toBe(1);
    expect(atPos[0]!.type).toBe('h1');
    expect(atPos[0]!.score).toBe(100);
  });
});

describe("findCodeFences", () => {
  test("finds single code fence", () => {
    const text = "Before\n```js\ncode here\n```\nAfter";
    const fences = findCodeFences(text);
    expect(fences.length).toBe(1);
    expect(fences[0]!.start).toBe(6); // position of first \n```
    // End is position after the closing \n``` (which is at position 22, length 4)
    expect(fences[0]!.end).toBe(26);
  });

  test("finds multiple code fences", () => {
    const text = "Intro\n```\nblock1\n```\nMiddle\n```\nblock2\n```\nEnd";
    const fences = findCodeFences(text);
    expect(fences.length).toBe(2);
  });

  test("handles unclosed code fence", () => {
    const text = "Before\n```\nunclosed code block";
    const fences = findCodeFences(text);
    expect(fences.length).toBe(1);
    expect(fences[0]!.end).toBe(text.length); // extends to end of document
  });

  test("returns empty array for no code fences", () => {
    const text = "No code fences here";
    const fences = findCodeFences(text);
    expect(fences.length).toBe(0);
  });
});

describe("isInsideCodeFence", () => {
  test("returns true for position inside fence", () => {
    const fences: CodeFenceRegion[] = [{ start: 10, end: 30 }];
    expect(isInsideCodeFence(15, fences)).toBe(true);
    expect(isInsideCodeFence(20, fences)).toBe(true);
  });

  test("returns false for position outside fence", () => {
    const fences: CodeFenceRegion[] = [{ start: 10, end: 30 }];
    expect(isInsideCodeFence(5, fences)).toBe(false);
    expect(isInsideCodeFence(35, fences)).toBe(false);
  });

  test("returns false for position at fence boundaries", () => {
    const fences: CodeFenceRegion[] = [{ start: 10, end: 30 }];
    expect(isInsideCodeFence(10, fences)).toBe(false); // at start
    expect(isInsideCodeFence(30, fences)).toBe(false); // at end
  });

  test("handles multiple fences", () => {
    const fences: CodeFenceRegion[] = [
      { start: 10, end: 30 },
      { start: 50, end: 70 }
    ];
    expect(isInsideCodeFence(20, fences)).toBe(true);
    expect(isInsideCodeFence(60, fences)).toBe(true);
    expect(isInsideCodeFence(40, fences)).toBe(false);
  });
});

describe("findBestCutoff", () => {
  test("prefers higher-scoring break points", () => {
    const breakPoints: BreakPoint[] = [
      { pos: 100, score: 1, type: 'newline' },
      { pos: 150, score: 100, type: 'h1' },
      { pos: 180, score: 20, type: 'blank' },
    ];
    // Target is 200, window is 100 (so 100-200 is valid)
    const cutoff = findBestCutoff(breakPoints, 200, 100, 0.7);
    expect(cutoff).toBe(150); // h1 wins due to high score
  });

  test("h2 at window edge beats blank at target (squared decay)", () => {
    const breakPoints: BreakPoint[] = [
      { pos: 100, score: 90, type: 'h2' },  // at window edge
      { pos: 195, score: 20, type: 'blank' }, // close to target
    ];
    // Target is 200, window is 100
    // With squared decay:
    // h2 at 100: dist=100, normalized=1.0, mult=1-1*0.7=0.3, final=90*0.3=27
    // blank at 195: dist=5, normalized=0.05, mult=1-0.0025*0.7=0.998, final=20*0.998=19.97
    const cutoff = findBestCutoff(breakPoints, 200, 100, 0.7);
    expect(cutoff).toBe(100); // h2 wins even at edge!
  });

  test("high score easily overcomes distance", () => {
    const breakPoints: BreakPoint[] = [
      { pos: 150, score: 100, type: 'h1' },  // h1 at middle
      { pos: 195, score: 1, type: 'newline' }, // newline near target
    ];
    // Target is 200, window is 100
    // h1 at 150: dist=50, normalized=0.5, mult=1-0.25*0.7=0.825, final=82.5
    // newline at 195: dist=5, mult=0.998, final=0.998
    const cutoff = findBestCutoff(breakPoints, 200, 100, 0.7);
    expect(cutoff).toBe(150); // h1 wins easily
  });

  test("returns target position when no breaks in window", () => {
    const breakPoints: BreakPoint[] = [
      { pos: 10, score: 100, type: 'h1' }, // too far before window
    ];
    const cutoff = findBestCutoff(breakPoints, 200, 100, 0.7);
    expect(cutoff).toBe(200);
  });

  test("skips break points inside code fences", () => {
    const breakPoints: BreakPoint[] = [
      { pos: 150, score: 100, type: 'h1' },  // inside fence
      { pos: 180, score: 20, type: 'blank' }, // outside fence
    ];
    const codeFences: CodeFenceRegion[] = [{ start: 140, end: 160 }];
    const cutoff = findBestCutoff(breakPoints, 200, 100, 0.7, codeFences);
    expect(cutoff).toBe(180); // blank wins since h1 is inside fence
  });

  test("handles empty break points array", () => {
    const cutoff = findBestCutoff([], 200, 100, 0.7);
    expect(cutoff).toBe(200);
  });
});
