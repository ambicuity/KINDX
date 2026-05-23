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
  const snippetsRows: SearchRenderRow[] = [
    {
      rank: 1,
      docid: "ce0c46",
      displayPath: "downloads/submission-folder/foo/faq.md",
      title: "Frequently Asked Questions",
      score: 0.89,
      snippet: "@@ -20,4 @@ (19 before, 40 after)\n\n### How to switch auth?",
      matchedLine: 21,
    },
    {
      rank: 2,
      docid: "451ca9",
      displayPath: "downloads/submission-folder/bar/faq.md",
      title: "FAQ",
      score: 0.80,
      snippet: "@@ -41,3 @@ (40 before, 0 after)\n  - [Auth setup]",
      matchedLine: 42,
    },
  ];

  it("renders legacy-shaped output: path:line #docid / Title / Score / @@ diff", () => {
    const out = renderSearchResults(snippetsRows, {
      layout: "snippets", color: false, query: "auth", showHints: false,
    });
    expect(out).toContain("kindx://downloads/submission-folder/foo/faq.md:21 #ce0c46");
    expect(out).toContain("Title: Frequently Asked Questions");
    expect(out).toContain("Score:");
    expect(out).toContain(" 89%");
    expect(out).toContain("@@ -20,4 @@ (19 before, 40 after)");
    expect(out).toContain("### How to switch auth?");
  });

  it("is selected when no layout is specified (new default)", () => {
    const explicit = renderSearchResults(snippetsRows, {
      layout: "snippets", color: false, query: "auth", showHints: false,
    });
    const defaulted = renderSearchResults(snippetsRows, {
      color: false, query: "auth", showHints: false,
    });
    expect(defaulted).toBe(explicit);
  });

  it("emits no ANSI when color is off", () => {
    const out = renderSearchResults(snippetsRows, {
      layout: "snippets", color: false, query: "auth",
    });
    expect(out).toBe(stripAnsi(out));
  });

  it("omits the :line suffix when matchedLine is undefined", () => {
    const noMatch: SearchRenderRow[] = [{
      rank: 1, displayPath: "x.md", score: 0.5, snippet: "@@ ... @@\nbody",
    }];
    const out = renderSearchResults(noMatch, { layout: "snippets", color: false });
    expect(out).toContain("kindx://x.md");
    expect(out).not.toContain("kindx://x.md:");
  });

  it("appends explainLines under Score when provided", () => {
    const withExplain: SearchRenderRow[] = [{
      rank: 1, displayPath: "x.md", score: 0.5, snippet: "body",
      explainLines: ["Explain: fts=[0.5] vec=[0.4]", "  RRF: total=0.9"],
    }];
    const out = renderSearchResults(withExplain, { layout: "snippets", color: false });
    expect(out).toContain("Explain: fts=[0.5] vec=[0.4]");
    expect(out).toContain("RRF: total=0.9");
  });
});
