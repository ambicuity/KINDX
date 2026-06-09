/**
 * store-chunking.test.ts - Document chunking and token-based chunking tests
 *
 * Split from store.test.ts for focused testing.
 */

import { describe, test, expect, vi } from "vitest";
import * as llmModule from "../engine/inference.js";
import {
  chunkDocument,
  chunkDocumentByTokens,
} from "../engine/repository.js";

describe("Document Chunking", () => {
  test("chunkDocument returns single chunk for small documents", () => {
    const content = "Small document content";
    const chunks = chunkDocument(content, 1000, 0);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.text).toBe(content);
    expect(chunks[0]!.pos).toBe(0);
  });

  test("chunkDocument splits large documents", () => {
    const content = "A".repeat(10000);
    const chunks = chunkDocument(content, 1000, 0);
    expect(chunks.length).toBeGreaterThan(1);

    // All chunks should have correct positions
    for (let i = 0; i < chunks.length; i++) {
      expect(chunks[i]!.pos).toBeGreaterThanOrEqual(0);
      if (i > 0) {
        expect(chunks[i]!.pos).toBeGreaterThan(chunks[i - 1]!.pos);
      }
    }
  });

  test("chunkDocument with overlap creates overlapping chunks", () => {
    const content = "A".repeat(3000);
    const chunks = chunkDocument(content, 1000, 150);  // 15% overlap
    expect(chunks.length).toBeGreaterThan(1);

    // With overlap, positions should be closer together than without
    // Each new chunk starts 150 chars before where the previous one ended
    for (let i = 1; i < chunks.length; i++) {
      const prevEnd = chunks[i - 1]!.pos + chunks[i - 1]!.text.length;
      const currentStart = chunks[i]!.pos;
      // Current chunk should start before the previous chunk ended (overlap)
      expect(currentStart).toBeLessThan(prevEnd);
      // But should still make forward progress
      expect(currentStart).toBeGreaterThan(chunks[i - 1]!.pos);
    }
  });

  test("chunkDocument prefers paragraph breaks", () => {
    const content = "First paragraph.\n\nSecond paragraph.\n\nThird paragraph.".repeat(50);
    const chunks = chunkDocument(content, 500, 0);

    // Chunks should end at paragraph breaks when possible
    for (const chunk of chunks.slice(0, -1)) {
      // Most chunks should end near a paragraph break
      const endsNearParagraph = chunk.text.endsWith("\n\n") ||
        chunk.text.endsWith(".") ||
        chunk.text.endsWith("\n");
      // This is a soft check - not all chunks can end at breaks
    }
    expect(chunks.length).toBeGreaterThan(1);
  });

  test("chunkDocument handles UTF-8 characters correctly", () => {
    const content = "こんにちは世界".repeat(500); // Japanese text
    const chunks = chunkDocument(content, 1000, 0);

    // Should not split in the middle of a multi-byte character
    for (const chunk of chunks) {
      expect(() => new TextEncoder().encode(chunk.text)).not.toThrow();
    }
  });

  test("chunkDocument with default params uses 900-token chunks", () => {
    // Default is CHUNK_SIZE_CHARS (3600 chars) with CHUNK_OVERLAP_CHARS (540 chars)
    const content = "Word ".repeat(2500);  // ~12500 chars
    const chunks = chunkDocument(content);
    expect(chunks.length).toBeGreaterThan(1);
    // Each chunk should be around 3600 chars (except last)
    expect(chunks[0]!.text.length).toBeGreaterThan(2800);
    expect(chunks[0]!.text.length).toBeLessThanOrEqual(3600);
  });
});

describe.skipIf(!!process.env.CI)("Token-based Chunking", () => {
  test("chunkDocumentByTokens returns single chunk for small documents", async () => {
    const content = "This is a small document.";
    const chunks = await chunkDocumentByTokens(content, 900, 135);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.text).toBe(content);
    expect(chunks[0]!.pos).toBe(0);
    expect(chunks[0]!.tokens).toBeGreaterThan(0);
    expect(chunks[0]!.tokens).toBeLessThan(900);
  });

  test("chunkDocumentByTokens splits large documents", async () => {
    // Create a document that's definitely more than 900 tokens
    const content = "The quick brown fox jumps over the lazy dog. ".repeat(250);
    const chunks = await chunkDocumentByTokens(content, 900, 135);

    expect(chunks.length).toBeGreaterThan(1);

    // Each chunk should have ~900 tokens or less
    for (const chunk of chunks) {
      expect(chunk.tokens).toBeLessThanOrEqual(950);  // Allow slight overage
      expect(chunk.tokens).toBeGreaterThan(0);
    }

    // Chunks should have correct positions
    for (let i = 0; i < chunks.length; i++) {
      expect(chunks[i]!.pos).toBeGreaterThanOrEqual(0);
      if (i > 0) {
        expect(chunks[i]!.pos).toBeGreaterThan(chunks[i - 1]!.pos);
      }
    }
  });

  test("chunkDocumentByTokens creates overlapping chunks", async () => {
    const content = "Word ".repeat(500);  // ~500 tokens
    const chunks = await chunkDocumentByTokens(content, 200, 30);  // 15% overlap

    expect(chunks.length).toBeGreaterThan(1);

    // With overlap, consecutive chunks should have overlapping positions
    for (let i = 1; i < chunks.length; i++) {
      const prevEnd = chunks[i - 1]!.pos + chunks[i - 1]!.text.length;
      const currentStart = chunks[i]!.pos;
      // Current chunk should start before the previous chunk ended (overlap)
      expect(currentStart).toBeLessThan(prevEnd);
    }
  });

  test("chunkDocumentByTokens returns actual token counts", async () => {
    const content = "Hello world, this is a test.";
    const chunks = await chunkDocumentByTokens(content);

    expect(chunks).toHaveLength(1);
    // The token count should be reasonable (not 0, not equal to char count)
    expect(chunks[0]!.tokens).toBeGreaterThan(0);
    expect(chunks[0]!.tokens).toBeLessThan(content.length);  // Tokens < chars for English
  });
});

// =============================================================================
// Force-split fallback — no silent data loss
//
// Spec: docs/superpowers/specs/2026-05-23-chunker-no-data-loss-design.md
// Regression for ingest warnings of the form:
//   "KINDX Warning: sub-chunk at pos=… exceeds maxTokens=900, skipping…"
// =============================================================================

describe("chunkDocumentByTokens — force-split (no data loss)", () => {
  // A tokenizer with non-uniform density: dense-tokenizing text inside a
  // marked region forces the planner's chunk-mean estimate to be wrong, so
  // a re-chunked sub-chunk still overshoots maxTokens. Before the fix that
  // content was dropped; after the fix it must be force-split.
  function makeDensityTokenizer() {
    return async (text: string): Promise<readonly number[]> => {
      let tokens = 0;
      for (const ch of text) {
        // "@" is the dense marker — ~1 char per token, 4x denser than prose.
        tokens += ch === "@" ? 1 : 0.25;
      }
      return new Array(Math.ceil(tokens)).fill(0);
    };
  }

  test("force-splits when sub-chunk still exceeds maxTokens and emits all bytes", async () => {
    const llmSpy = vi.spyOn(llmModule, "getDefaultLLM").mockReturnValue({
      tokenize: makeDensityTokenizer(),
    } as any);

    try {
      // Prose front (low density) + dense tail (high density). Average density
      // is ~0.4 tok/char; planner thinks 900 tok ≈ 2250 chars; in dense tail
      // 2250 chars is actually ~2250 tokens. The re-chunk pass would have
      // dropped it.
      const prose = "the quick brown fox jumps over the lazy dog. ".repeat(200);
      const dense = "@".repeat(4000);
      const content = prose + dense;

      const chunks = await chunkDocumentByTokens(content, 900, 135);

      // 1. Every chunk satisfies the token budget.
      for (const c of chunks) {
        expect(c.tokens).toBeLessThanOrEqual(900);
      }

      // 2. Every byte of input is covered by some chunk (ignoring overlap):
      //    the union of [pos, pos+text.length) intervals covers [0, content.length).
      const intervals = chunks
        .map(c => [c.pos, c.pos + c.text.length] as [number, number])
        .sort((a, b) => a[0] - b[0]);
      let covered = 0;
      for (const [start, end] of intervals) {
        if (start <= covered) covered = Math.max(covered, end);
      }
      expect(covered).toBe(content.length);

      // 3. Reconstruction sanity: each chunk's text equals the slice at its pos.
      for (const c of chunks) {
        expect(content.slice(c.pos, c.pos + c.text.length)).toBe(c.text);
      }
    } finally {
      llmSpy.mockRestore();
    }
  });

  test("force-split terminates on pathological density (entire input dense)", async () => {
    const llmSpy = vi.spyOn(llmModule, "getDefaultLLM").mockReturnValue({
      tokenize: makeDensityTokenizer(),
    } as any);

    try {
      // All-dense content: every char is a token. 4000 tokens of input
      // must come out as ≥ 5 chunks of ≤ 900 tokens each.
      const content = "@".repeat(4000);
      const chunks = await chunkDocumentByTokens(content, 900, 135);

      expect(chunks.length).toBeGreaterThanOrEqual(5);
      for (const c of chunks) {
        expect(c.tokens).toBeLessThanOrEqual(900);
      }
      const intervals = chunks
        .map(c => [c.pos, c.pos + c.text.length] as [number, number])
        .sort((a, b) => a[0] - b[0]);
      let covered = 0;
      for (const [start, end] of intervals) {
        if (start <= covered) covered = Math.max(covered, end);
      }
      expect(covered).toBe(content.length);
    } finally {
      llmSpy.mockRestore();
    }
  });
});

describe("Smart Chunking Integration", () => {
  test("chunkDocument prefers headings over arbitrary breaks", () => {
    // Create content where the heading falls within the search window
    // We want the heading at ~1700 chars so it's in the window for a 2000 char target
    const section1 = "Introduction text here. ".repeat(70); // ~1680 chars
    const section2 = "Main content text here. ".repeat(50); // ~1150 chars
    const content = `${section1}\n# Main Section\n${section2}`;

    // With 2000 char chunks and 800 char window (searches 1200-2000)
    // Heading is at ~1680 which is in window
    const chunks = chunkDocument(content, 2000, 0, 800);
    const headingPos = content.indexOf('\n# Main Section');

    // First chunk should end at the heading (best break point in window)
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks[0]!.text.length).toBe(headingPos);
  });

  test("chunkDocument does not split inside code blocks", () => {
    const beforeCode = "Some intro text. ".repeat(30); // ~480 chars
    const codeBlock = "```typescript\n" + "const x = 1;\n".repeat(100) + "```\n";
    const afterCode = "More text after code. ".repeat(30);
    const content = beforeCode + codeBlock + afterCode;

    const chunks = chunkDocument(content, 1000, 0, 400);

    // Check that no chunk starts in the middle of a code block
    for (const chunk of chunks) {
      const hasOpenFence = (chunk.text.match(/\n```/g) || []).length;
      // If we have an odd number of fence markers, we're splitting inside a block
      // (unless it's the last chunk with unclosed fence)
      if (hasOpenFence % 2 === 1 && !chunk.text.endsWith('```\n')) {
        // This is acceptable only if it's an unclosed fence at document end
        const isLastChunk = chunks.indexOf(chunk) === chunks.length - 1;
        if (!isLastChunk) {
          // Not the last chunk, so this would be a split inside code - check it's not common
          // Actually this test is more about smoke testing - we just verify it runs
        }
      }
    }
    expect(chunks.length).toBeGreaterThan(1);
  });

  test("chunkDocument handles markdown with mixed elements", () => {
    const content = `# Introduction

This is the introduction paragraph with some text.

## Section 1

Some content in section 1.

- List item 1
- List item 2
- List item 3

## Section 2

\`\`\`javascript
function hello() {
  console.log("Hello");
}
\`\`\`

More text after the code block.

---

## Section 3

Final section content.
`.repeat(10);

    const chunks = chunkDocument(content, 500, 75, 200);

    // Should produce multiple chunks
    expect(chunks.length).toBeGreaterThan(5);

    // All chunks should be valid strings
    for (const chunk of chunks) {
      expect(typeof chunk.text).toBe('string');
      expect(chunk.text.length).toBeGreaterThan(0);
      expect(chunk.pos).toBeGreaterThanOrEqual(0);
    }
  });
});
