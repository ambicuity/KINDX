import { describe, it, expect } from "vitest";
import { render } from "../../../engine/cli/tui/view.js";
import { INITIAL_STATE, applyHits, type SearchHitState } from "../../../engine/cli/tui/state.js";
import { stripAnsi } from "../../../engine/cli/output.js";

const caps = { width: 100, height: 24, color: false, unicode: false };

const hits: SearchHitState[] = [
  { rank: 1, displayPath: "a.md", title: "Authentication", score: 0.84 },
  { rank: 2, displayPath: "b.md", title: "Backup", score: 0.42 },
];

describe("TUI render — search view", () => {
  it("renders the prompt placeholder when query is empty", () => {
    const out = stripAnsi(render(INITIAL_STATE, caps));
    expect(out).toContain("(type to search)");
    expect(out).toContain("[mode: hybrid]");
  });

  it("renders hits with rank, score and path", () => {
    const state = applyHits({ ...INITIAL_STATE, query: "auth" }, hits);
    const out = stripAnsi(render(state, caps));
    expect(out).toContain("1");
    expect(out).toContain("84%");
    expect(out).toContain("kindx://a.md");
    expect(out).toContain("Authentication");
  });

  it("emits no ANSI when caps.color is false", () => {
    const out = render(INITIAL_STATE, caps);
    expect(out).toBe(stripAnsi(out));
  });

  it("compact layout suppresses chips when width < 80", () => {
    const out = stripAnsi(render(INITIAL_STATE, { ...caps, width: 60 }));
    expect(out).not.toContain("[mode: hybrid]");
  });

  it("includes the keyboard hint line in the status bar", () => {
    const out = stripAnsi(render(INITIAL_STATE, caps));
    // ascii hint chosen for non-unicode caps
    expect(out).toContain("up/down move");
    expect(out).toContain("q quit");
  });
});

describe("TUI render — help overlay", () => {
  it("lists keyboard shortcuts", () => {
    const state = { ...INITIAL_STATE, view: "help" as const };
    const out = stripAnsi(render(state, caps));
    expect(out).toContain("focus search input");
    expect(out).toContain("cycle search mode");
    expect(out).toContain("quit");
  });
});

describe("TUI render — details view", () => {
  it("shows title, path, and score for the selected hit", () => {
    const state = applyHits({ ...INITIAL_STATE, view: "details", query: "auth" }, hits);
    const out = stripAnsi(render(state, caps));
    expect(out).toContain("kindx://a.md");
    expect(out).toContain("Authentication");
    expect(out).toContain("84%");
  });
});
