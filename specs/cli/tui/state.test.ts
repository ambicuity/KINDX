import { describe, it, expect } from "vitest";
import {
  reduce,
  applyHits,
  setLoading,
  INITIAL_STATE,
  type TuiState,
  type SearchHitState,
} from "../../../engine/cli/tui/state.js";

const hits: SearchHitState[] = [
  { rank: 1, displayPath: "a.md", title: "A", score: 0.9 },
  { rank: 2, displayPath: "b.md", title: "B", score: 0.7 },
  { rank: 3, displayPath: "c.md", title: "C", score: 0.5 },
];

const seeded = (): TuiState => applyHits(INITIAL_STATE, hits);

describe("TUI reducer — search view", () => {
  it("typing characters appends to the query", () => {
    const s1 = reduce(INITIAL_STATE, { kind: "char", ch: "a" });
    const s2 = reduce(s1, { kind: "char", ch: "u" });
    expect(s2.query).toBe("au");
  });

  it("backspace pops the last char", () => {
    let s = reduce(INITIAL_STATE, { kind: "char", ch: "a" });
    s = reduce(s, { kind: "char", ch: "b" });
    s = reduce(s, { kind: "backspace" });
    expect(s.query).toBe("a");
  });

  it("down/up navigate the result cursor and clamp", () => {
    let s = seeded();
    s = reduce(s, { kind: "down" });
    s = reduce(s, { kind: "down" });
    s = reduce(s, { kind: "down" }); // clamps
    expect(s.cursor).toBe(2);
    s = reduce(s, { kind: "up" });
    expect(s.cursor).toBe(1);
  });

  it("'m' on empty query cycles search mode", () => {
    let s = INITIAL_STATE;
    s = reduce(s, { kind: "char", ch: "m" });
    expect(s.mode).toBe("lex");
    s = reduce(s, { kind: "char", ch: "m" });
    expect(s.mode).toBe("vec");
    s = reduce(s, { kind: "char", ch: "m" });
    expect(s.mode).toBe("hyde");
    s = reduce(s, { kind: "char", ch: "m" });
    expect(s.mode).toBe("hybrid");
  });

  it("'m' typed inside a non-empty query is a literal char", () => {
    let s = reduce(INITIAL_STATE, { kind: "char", ch: "f" });
    s = reduce(s, { kind: "char", ch: "m" });
    expect(s.query).toBe("fm");
    expect(s.mode).toBe("hybrid"); // unchanged
  });

  it("'q' on empty query exits, on filled query is a literal char", () => {
    const s1 = reduce(INITIAL_STATE, { kind: "char", ch: "q" });
    expect(s1.exited).toBe(true);

    let s2 = reduce(INITIAL_STATE, { kind: "char", ch: "f" });
    s2 = reduce(s2, { kind: "char", ch: "q" });
    expect(s2.query).toBe("fq");
    expect(s2.exited).toBe(false);
  });

  it("Enter on hits transitions to details view", () => {
    const s = reduce(seeded(), { kind: "enter" });
    expect(s.view).toBe("details");
    expect(s.previousView).toBe("search");
  });

  it("Esc clears non-empty query before exiting", () => {
    let s = reduce(INITIAL_STATE, { kind: "char", ch: "f" });
    s = reduce(s, { kind: "name", name: "escape" });
    expect(s.query).toBe("");
    expect(s.exited).toBe(false);
    s = reduce(s, { kind: "name", name: "escape" });
    expect(s.exited).toBe(true);
  });

  it("Ctrl-C exits immediately even with a query buffered", () => {
    let s = reduce(INITIAL_STATE, { kind: "char", ch: "f" });
    s = reduce(s, { kind: "ctl", ch: "c" });
    expect(s.exited).toBe(true);
  });
});

describe("TUI reducer — details view", () => {
  it("Esc returns to the search view", () => {
    let s = reduce(seeded(), { kind: "enter" });
    s = reduce(s, { kind: "name", name: "escape" });
    expect(s.view).toBe("search");
  });

  it("'q' or 'b' also returns to search", () => {
    let s = reduce(seeded(), { kind: "enter" });
    s = reduce(s, { kind: "char", ch: "q" });
    expect(s.view).toBe("search");
  });
});

describe("TUI reducer — help overlay", () => {
  it("'?' opens help, '?' again closes it", () => {
    let s = reduce(INITIAL_STATE, { kind: "char", ch: "?" });
    expect(s.view).toBe("help");
    s = reduce(s, { kind: "char", ch: "?" });
    expect(s.view).toBe("search");
  });
});

describe("applyHits / setLoading", () => {
  it("applyHits resets cursor and clears loading", () => {
    const s = applyHits({ ...INITIAL_STATE, cursor: 5, loading: true }, hits);
    expect(s.hits).toBe(hits);
    expect(s.cursor).toBe(0);
    expect(s.loading).toBe(false);
  });

  it("setLoading toggles the flag", () => {
    expect(setLoading(INITIAL_STATE, true).loading).toBe(true);
    expect(setLoading({ ...INITIAL_STATE, loading: true }, false).loading).toBe(false);
  });
});
