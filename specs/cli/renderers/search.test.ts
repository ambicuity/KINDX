import { describe, it, expect } from "vitest";
import {
  renderSearchResults,
  type SearchRenderRow,
} from "../../../engine/cli/renderers/search.js";
import { stripAnsi } from "../../../engine/cli/output.js";

const rows: SearchRenderRow[] = [
  {
    rank: 1,
    docid: "abc123",
    displayPath: "docs/auth.md",
    title: "Authentication",
    context: "How auth works",
    score: 0.84,
    snippet: "JWT tokens are issued on login\nand verified by middleware.",
    matchedLine: 12,
    collection: "docs",
    retrievalMode: "hybrid",
  },
  {
    rank: 2,
    docid: "def456",
    displayPath: "src/jwt.ts",
    title: "JWT utilities",
    score: 0.42,
    snippet: "export function sign(...)",
    collection: "code",
  },
];

describe("renderSearchResults — cards", () => {
  it("renders rank, path, title, score, and snippet", () => {
    const out = renderSearchResults(rows, { layout: "cards", color: false, query: "auth", showHints: false });
    expect(out).toContain("#1");
    expect(out).toContain("kindx://docs/auth.md");
    expect(out).toContain("Authentication");
    expect(out).toContain("score  84%");
    expect(out).toContain("JWT tokens are issued");
    expect(out).toContain(":12"); // matched line shown
  });

  it("does not emit ANSI when color is off", () => {
    const out = renderSearchResults(rows, { layout: "cards", color: false, query: "auth", showHints: false });
    expect(out).toBe(stripAnsi(out));
  });

  it("emits ANSI when color is on", () => {
    const out = renderSearchResults(rows, { layout: "cards", color: true, query: "auth", showHints: false });
    expect(out).not.toBe(stripAnsi(out));
  });

  it("includes metadata block when requested", () => {
    const out = renderSearchResults(rows, {
      layout: "cards",
      color: false,
      showMetadata: true,
      query: "auth",
      showHints: false,
    });
    expect(out).toContain("col: docs");
    expect(out).toContain("mode: hybrid");
  });

  it("includes next-step hint when not suppressed", () => {
    const out = renderSearchResults(rows, { layout: "cards", color: false, query: "auth" });
    expect(out).toContain("Next:");
    expect(out).toContain("kindx get");
  });

  it("renders empty state for zero rows", () => {
    const out = renderSearchResults([], { layout: "cards", color: false });
    expect(out).toContain("No results");
  });
});

describe("renderSearchResults — table", () => {
  it("emits a one-row-per-result table", () => {
    const out = renderSearchResults(rows, { layout: "table", color: false, showHints: false });
    expect(out).toContain("score");
    expect(out).toContain("path / title");
    expect(out).toContain("docs/auth.md");
    expect(out).toContain("src/jwt.ts");
  });
});

describe("renderSearchResults — lines", () => {
  it("emits one line per result with score and path", () => {
    const out = renderSearchResults(rows, { layout: "lines", color: false, showHints: false });
    const lines = out.split("\n").filter((l) => l.trim());
    expect(lines.length).toBe(2);
    expect(lines[0]).toContain("1");
    expect(lines[0]).toContain("84%");
    expect(lines[0]).toContain("docs/auth.md");
    expect(lines[1]).toContain("src/jwt.ts");
  });
});

describe("renderSearchResults — snippets (default)", () => {
  // New shape: caller passes snippet body without the @@ header, plus
  // bodyStartLine + totalLines so the renderer can compose the friendly
  // header and the line-number gutter.
  const snippetsRows: SearchRenderRow[] = [
    {
      rank: 1,
      docid: "ce0c46",
      displayPath: "downloads/submission-folder/foo/faq.md",
      absolutePath: "/Users/x/foo/faq.md",
      title: "Frequently Asked Questions",
      score: 0.89,
      snippet: "### How to switch auth?\nSee the auth dialog.",
      bodyStartLine: 21,
      totalLines: 64,
      matchedLine: 21,
    },
    {
      rank: 2,
      docid: "451ca9",
      displayPath: "downloads/submission-folder/bar/faq.md",
      absolutePath: "/Users/x/bar/faq.md",
      title: "FAQ",
      score: 0.80,
      snippet: "  - [Auth setup]",
      bodyStartLine: 42,
      totalLines: 42,
      matchedLine: 42,
    },
  ];

  it("renders header + gutter shape: path:line #docid / Title / Score / lines X–Y / gutter body", () => {
    const out = renderSearchResults(snippetsRows, {
      layout: "snippets", color: false, query: "auth", showHints: false,
    });
    expect(out).toContain("kindx://downloads/submission-folder/foo/faq.md:21 #ce0c46");
    expect(out).toContain("Title: Frequently Asked Questions");
    expect(out).toContain("Score:");
    expect(out).toContain(" 89%");
    // New friendly header replaces `@@ -X,Y @@`
    expect(out).toContain("lines 21–22 (20 before, 42 after)");
    expect(out).not.toContain("@@");
    // Line-number gutter on each snippet body line
    expect(out).toContain("21 │ ### How to switch auth?");
    expect(out).toContain("22 │ See the auth dialog.");
  });

  it("is selected when no layout is specified (default)", () => {
    const explicit = renderSearchResults(snippetsRows, {
      layout: "snippets", color: false, query: "auth", showHints: false,
    });
    const defaulted = renderSearchResults(snippetsRows, {
      color: false, query: "auth", showHints: false,
    });
    expect(defaulted).toBe(explicit);
  });

  it("emits no ANSI when color is off (no OSC 8 either)", () => {
    const out = renderSearchResults(snippetsRows, {
      layout: "snippets", color: false, query: "auth",
    });
    expect(out).toBe(stripAnsi(out));
    expect(out).not.toContain("\x1b]8;");
  });

  it("wraps the kindx:// URI in an OSC 8 hyperlink when color is on and absolutePath is provided", () => {
    const out = renderSearchResults(snippetsRows, {
      layout: "snippets", color: true, query: "auth", showHints: false,
    });
    // OSC 8 hyperlink: ESC ] 8 ; ; <url> BEL <text> ESC ] 8 ; ; BEL
    expect(out).toContain("\x1b]8;;file:///Users/x/foo/faq.md#L21\x07");
    expect(out).toContain("\x1b]8;;\x07");
  });

  it("omits the OSC 8 hyperlink when absolutePath is missing (gracefully falls back to plain cyan URI)", () => {
    const noAbs: SearchRenderRow[] = [{
      rank: 1, displayPath: "x.md", score: 0.5,
      snippet: "body", bodyStartLine: 1, totalLines: 1,
    }];
    const out = renderSearchResults(noAbs, { layout: "snippets", color: true });
    expect(out).not.toContain("\x1b]8;");
    expect(out).toContain("kindx://x.md");
  });

  it("omits the :line suffix when matchedLine is undefined", () => {
    const noMatch: SearchRenderRow[] = [{
      rank: 1, displayPath: "x.md", score: 0.5,
      snippet: "body", bodyStartLine: 1, totalLines: 1,
    }];
    const out = renderSearchResults(noMatch, { layout: "snippets", color: false });
    expect(out).toContain("kindx://x.md");
    expect(out).not.toContain("kindx://x.md:");
  });

  it("omits the (X before, Y after) annotation when totalLines is unknown", () => {
    const noTotal: SearchRenderRow[] = [{
      rank: 1, displayPath: "x.md", score: 0.5,
      snippet: "body", bodyStartLine: 10,
    }];
    const out = renderSearchResults(noTotal, { layout: "snippets", color: false });
    expect(out).toContain("lines 10–10");
    expect(out).not.toContain("before, ");
  });

  it("appends explainLines under Score when provided", () => {
    const withExplain: SearchRenderRow[] = [{
      rank: 1, displayPath: "x.md", score: 0.5,
      snippet: "body", bodyStartLine: 1, totalLines: 1,
      explainLines: ["Explain: fts=[0.5] vec=[0.4]", "  RRF: total=0.9"],
    }];
    const out = renderSearchResults(withExplain, { layout: "snippets", color: false });
    expect(out).toContain("Explain: fts=[0.5] vec=[0.4]");
    expect(out).toContain("RRF: total=0.9");
  });

  it("falls back to legacy pre-formatted snippet when bodyStartLine is undefined", () => {
    const legacy: SearchRenderRow[] = [{
      rank: 1, displayPath: "x.md", score: 0.5,
      snippet: "@@ -20,4 @@ (19 before, 40 after)\nbody line",
    }];
    const out = renderSearchResults(legacy, { layout: "snippets", color: false });
    expect(out).toContain("@@ -20,4 @@");
    expect(out).toContain("body line");
    // No new-style header rendered
    expect(out).not.toMatch(/lines \d+–\d+/);
  });

  it("auto-fits the gutter width to the largest line number", () => {
    const wide: SearchRenderRow[] = [{
      rank: 1, displayPath: "x.md", score: 0.5,
      snippet: "a\nb\nc",
      bodyStartLine: 98,
      totalLines: 200,
    }];
    const out = renderSearchResults(wide, { layout: "snippets", color: false });
    // Lines 98, 99, 100 → gutter width = 3
    expect(out).toContain(" 98 │ a");
    expect(out).toContain(" 99 │ b");
    expect(out).toContain("100 │ c");
  });
});
