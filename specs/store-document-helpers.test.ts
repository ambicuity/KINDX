/**
 * store-document-helpers.test.ts - Document hashing, title extraction, and embedding formatting tests
 *
 * Split from store.test.ts for focused testing.
 */

import { describe, test, expect } from "vitest";
import {
  hashContent,
  extractTitle,
  formatQueryForEmbedding,
  formatDocForEmbedding,
} from "../engine/repository.js";

describe("Document Helpers", () => {
  test("hashContent produces consistent SHA256 hashes", async () => {
    const content = "Hello, World!";
    const hash1 = await hashContent(content);
    const hash2 = await hashContent(content);
    expect(hash1).toBe(hash2);
    expect(hash1).toMatch(/^[a-f0-9]{64}$/);
  });

  test("hashContent produces different hashes for different content", async () => {
    const hash1 = await hashContent("Hello");
    const hash2 = await hashContent("World");
    expect(hash1).not.toBe(hash2);
  });

  test("extractTitle extracts H1 heading", () => {
    const content = "# My Title\n\nSome content here.";
    expect(extractTitle(content, "file.md")).toBe("My Title");
  });

  test("extractTitle extracts H2 heading if no H1", () => {
    const content = "## My Subtitle\n\nSome content here.";
    expect(extractTitle(content, "file.md")).toBe("My Subtitle");
  });

  test("extractTitle falls back to filename", () => {
    const content = "Just some plain text without headings.";
    expect(extractTitle(content, "my-document.md")).toBe("my-document");
  });

  test("extractTitle skips generic 'Notes' heading", () => {
    const content = "# Notes\n\n## Actual Title\n\nContent";
    expect(extractTitle(content, "file.md")).toBe("Actual Title");
  });

  test("extractTitle handles 📝 Notes heading", () => {
    const content = "# 📝 Notes\n\n## Meeting Summary\n\nContent";
    expect(extractTitle(content, "file.md")).toBe("Meeting Summary");
  });
});

describe("Embedding Formatting", () => {
  test("formatQueryForEmbedding adds search task prefix", () => {
    const formatted = formatQueryForEmbedding("how to deploy");
    expect(formatted).toBe("task: search result | query: how to deploy");
  });

  test("formatDocForEmbedding adds title and text prefix", () => {
    const formatted = formatDocForEmbedding("Some content", "My Title");
    expect(formatted).toBe("title: My Title | text: Some content");
  });

  test("formatDocForEmbedding handles missing title", () => {
    const formatted = formatDocForEmbedding("Some content");
    expect(formatted).toBe("title: none | text: Some content");
  });
});
