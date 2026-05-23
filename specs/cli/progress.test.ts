import { describe, it, expect, beforeEach } from "vitest";
import { Writable } from "node:stream";
import { createProgressReporter, pickProgressMode } from "../../engine/cli/progress.js";
import { stripAnsi } from "../../engine/cli/output.js";

class CaptureStream extends Writable {
  chunks: string[] = [];
  override _write(chunk: Buffer | string, _enc: string, cb: () => void): void {
    this.chunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    cb();
  }
  get text(): string { return this.chunks.join(""); }
  get plain(): string { return stripAnsi(this.text); }
  clear(): void { this.chunks = []; }
}

describe("pickProgressMode", () => {
  it("silent when --quiet", () => {
    expect(pickProgressMode({
      format: "pretty", color: true, glyphsUtf8: true, stderrIsTty: true, quiet: true, env: {},
    })).toBe("silent");
  });

  it("silent when KINDX_PROGRESS=off", () => {
    expect(pickProgressMode({
      format: "pretty", color: true, glyphsUtf8: true, stderrIsTty: true,
      env: { KINDX_PROGRESS: "off" },
    })).toBe("silent");
  });

  it("ndjson for structured formats", () => {
    for (const f of ["json", "csv", "md", "xml", "files"] as const) {
      expect(pickProgressMode({
        format: f, color: true, glyphsUtf8: true, stderrIsTty: true, env: {},
      })).toBe("ndjson");
    }
  });

  it("pretty-tty when TTY + color + utf8", () => {
    expect(pickProgressMode({
      format: "pretty", color: true, glyphsUtf8: true, stderrIsTty: true, env: {},
    })).toBe("pretty-tty");
  });

  it("pretty-log when not TTY", () => {
    expect(pickProgressMode({
      format: "pretty", color: true, glyphsUtf8: true, stderrIsTty: false, env: {},
    })).toBe("pretty-log");
  });

  it("pretty-log when color is off (even on TTY)", () => {
    expect(pickProgressMode({
      format: "pretty", color: false, glyphsUtf8: true, stderrIsTty: true, env: {},
    })).toBe("pretty-log");
  });
});

describe("silent reporter", () => {
  let out: CaptureStream;
  beforeEach(() => { out = new CaptureStream(); });

  it("drops phase events", () => {
    const r = createProgressReporter({ mode: "silent", color: false, stderr: out });
    r.start("expand", "Expanding query");
    r.detail(["foo"]);
    r.end("expand");
    r.warn("w", "ignored");
    r.done();
    expect(out.text).toBe("");
  });

  it("still emits errors", () => {
    const r = createProgressReporter({ mode: "silent", color: false, stderr: out });
    r.error("boom", "something failed");
    expect(out.plain).toContain("error: boom: something failed");
  });
});

describe("ndjson reporter", () => {
  let out: CaptureStream;
  let clock: number;
  beforeEach(() => { out = new CaptureStream(); clock = 1000; });

  it("emits one JSON object per event", () => {
    const r = createProgressReporter({
      mode: "ndjson", color: false, stderr: out, now: () => clock,
    });
    r.start("expand", "Expanding query");
    clock += 1700;
    r.end("expand");
    const lines = out.text.trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ event: "phase-start", name: "expand", label: "Expanding query" });
    expect(lines[1]).toMatchObject({ event: "phase-end", name: "expand", durationMs: 1700 });
  });

  it("warnings and errors get their own events", () => {
    const r = createProgressReporter({ mode: "ndjson", color: false, stderr: out, now: () => clock });
    r.warn("missing-embeddings", "5072 documents need embedding", { count: 5072, pct: 55 });
    r.error("rerank-failed", "model unavailable");
    const lines = out.text.trim().split("\n").map((l) => JSON.parse(l));
    expect(lines[0]).toMatchObject({
      event: "warn", code: "missing-embeddings", message: "5072 documents need embedding",
      detail: { count: 5072, pct: 55 },
    });
    expect(lines[1]).toMatchObject({ event: "error", code: "rerank-failed", message: "model unavailable" });
  });
});

describe("pretty-log reporter", () => {
  let out: CaptureStream;
  let clock: number;
  beforeEach(() => { out = new CaptureStream(); clock = 0; });

  it("prints a ▸ line per phase and ✓ on completion with timing", () => {
    const r = createProgressReporter({
      mode: "pretty-log", color: false, stderr: out, now: () => clock,
    });
    r.start("expand", "Expanding query");
    clock = 1700;
    r.end("expand");
    const text = out.plain;
    expect(text).toContain("▸ Expanding query…");
    expect(text).toContain("✓");
    expect(text).toContain("1.7s");
  });

  it("flushes buffered detail lines on end", () => {
    const r = createProgressReporter({
      mode: "pretty-log", color: false, stderr: out, now: () => clock,
    });
    r.start("expand", "Expanding query");
    r.detail(["├─ how does auth work", "└─ lex: how does auth function"]);
    r.end("expand");
    const text = out.plain;
    expect(text).toContain("├─ how does auth work");
    expect(text).toContain("└─ lex: how does auth function");
  });

  it("warn writes a single line with code", () => {
    const r = createProgressReporter({ mode: "pretty-log", color: false, stderr: out });
    r.warn("missing-embeddings", "5072 documents need embedding");
    expect(out.plain).toContain("warn[missing-embeddings]: 5072 documents need embedding");
  });
});

describe("pretty-tty reporter", () => {
  let out: CaptureStream;
  let clock: number;
  beforeEach(() => { out = new CaptureStream(); clock = 0; });

  it("collapses spinner into ✓ line on end", () => {
    const r = createProgressReporter({
      mode: "pretty-tty", color: false, stderr: out, now: () => clock, intervalMs: 0,
    });
    r.start("expand", "Expanding query");
    clock = 1700;
    r.end("expand");
    r.done();
    const text = out.plain;
    expect(text).toContain("✓ Expanding query");
    expect(text).toContain("(1.7s)");
  });

  it("flushes detail lines after the ✓ on end", () => {
    const r = createProgressReporter({
      mode: "pretty-tty", color: false, stderr: out, now: () => clock, intervalMs: 0,
    });
    r.start("expand", "Expanding query");
    r.detail(["├─ a", "└─ b"]);
    clock = 500;
    r.end("expand");
    r.done();
    const text = out.plain;
    const okIdx = text.indexOf("✓ Expanding query");
    const aIdx = text.indexOf("├─ a");
    expect(okIdx).toBeGreaterThanOrEqual(0);
    expect(aIdx).toBeGreaterThan(okIdx);
  });

  it("implicitly closes previous phase when start() is called twice", () => {
    const r = createProgressReporter({
      mode: "pretty-tty", color: false, stderr: out, now: () => clock, intervalMs: 0,
    });
    r.start("expand", "Expanding query");
    clock = 100;
    r.start("search", "Searching 6 queries");
    clock = 200;
    r.end("search");
    r.done();
    const text = out.plain;
    expect(text).toContain("✓ Expanding query");
    expect(text).toContain("✓ Searching 6 queries");
  });

  it("spinner frame is cyan while elapsed < 1.5× expected", () => {
    let clk = 0;
    const r = createProgressReporter({
      mode: "pretty-tty", color: true, stderr: out,
      now: () => clk, intervalMs: 0,
    });
    r.start("rerank", "Reranking 40 candidates", { expectedDurationMs: 10000 });
    // 5s in: well under expected (10s), spinner stays cyan
    clk = 5000;
    out.clear();
    // Re-render via warn() which pauses + repaints the spinner.
    r.warn("noise", "x");
    // Look at the spinner frame specifically — it's the braille char in
    // SPINNER_FRAMES wrapped in a color code. Cyan = [36m.
    expect(out.text).toMatch(/\x1b\[36m[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
    expect(out.text).not.toMatch(/\x1b\[33m[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
    r.done();
  });

  it("spinner frame is yellow once elapsed > 1.5× expected", () => {
    let clk = 0;
    const r = createProgressReporter({
      mode: "pretty-tty", color: true, stderr: out,
      now: () => clk, intervalMs: 0,
    });
    r.start("rerank", "Reranking 40 candidates", { expectedDurationMs: 10000 });
    // 16s in: 1.6× expected → spinner should be yellow
    clk = 16000;
    out.clear();
    r.warn("noise", "x");
    expect(out.text).toMatch(/\x1b\[33m[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
    expect(out.text).not.toMatch(/\x1b\[36m[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
    r.done();
  });

  it("ndjson reporter records expectedDurationMs on phase-start", () => {
    let clk = 1000;
    const r = createProgressReporter({
      mode: "ndjson", color: false, stderr: out, now: () => clk,
    });
    r.start("rerank", "Reranking 40 candidates", { expectedDurationMs: 10000 });
    const ev = JSON.parse(out.text.trim());
    expect(ev).toMatchObject({
      event: "phase-start", name: "rerank", label: "Reranking 40 candidates",
      expectedDurationMs: 10000,
    });
  });

  it("done() restores cursor visibility", () => {
    const r = createProgressReporter({
      mode: "pretty-tty", color: false, stderr: out, intervalMs: 0,
    });
    r.start("x", "X");
    out.clear();
    r.done();
    expect(out.text).toContain("\x1b[?25h");
  });

  it("warn interleaves above the active spinner without erasing it", () => {
    const r = createProgressReporter({
      mode: "pretty-tty", color: false, stderr: out, intervalMs: 0,
    });
    r.start("expand", "Expanding query");
    r.warn("missing-embeddings", "5072 documents need embedding");
    r.end("expand");
    r.done();
    const text = out.plain;
    expect(text).toContain("warn[missing-embeddings]");
    expect(text).toContain("✓ Expanding query");
  });
});
