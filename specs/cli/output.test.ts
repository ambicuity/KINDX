import { describe, it, expect } from "vitest";
import {
  resolveOutputMode,
  jsonEnvelope,
  jsonEnvelopeEnabled,
  paletteFor,
  glyphsFor,
  stripAnsi,
} from "../../engine/cli/output.js";

describe("resolveOutputMode", () => {
  it("defaults to pretty on a TTY without NO_COLOR", () => {
    const r = resolveOutputMode({}, {}, true);
    expect(r.mode).toBe("pretty");
    expect(r.format).toBe("pretty");
    expect(r.color).toBe(true);
    expect(r.explicit).toBe(false);
  });

  it("defaults to plain on a non-TTY", () => {
    const r = resolveOutputMode({}, {}, false);
    expect(r.mode).toBe("plain");
    expect(r.format).toBe("plain");
    expect(r.color).toBe(false);
  });

  it("honors NO_COLOR even on a TTY", () => {
    const r = resolveOutputMode({}, { NO_COLOR: "1" }, true);
    expect(r.color).toBe(false);
    expect(r.format).toBe("plain");
  });

  it("--no-color always wins", () => {
    const r = resolveOutputMode({ noColor: true, color: true }, {}, true);
    expect(r.color).toBe(false);
  });

  it("--color forces color on a non-TTY", () => {
    const r = resolveOutputMode({ color: true, format: "pretty" }, {}, false);
    expect(r.color).toBe(true);
    expect(r.mode).toBe("pretty");
  });

  it("--format wins over --json", () => {
    const r = resolveOutputMode({ json: true, format: "cards" }, {}, true);
    expect(r.mode).toBe("pretty");
    expect(r.format).toBe("cards");
    expect(r.explicit).toBe(true);
  });

  it("legacy --json maps to mode=json", () => {
    const r = resolveOutputMode({ json: true }, {}, true);
    expect(r.mode).toBe("json");
    expect(r.format).toBe("json");
    expect(r.explicit).toBe(true);
  });

  it("legacy --csv maps to format=csv (mode=plain)", () => {
    const r = resolveOutputMode({ csv: true }, {}, true);
    expect(r.format).toBe("csv");
    expect(r.mode).toBe("plain");
    expect(r.explicit).toBe(true);
  });

  it("KINDX_OUTPUT env var applies when no flag set", () => {
    const r = resolveOutputMode({}, { KINDX_OUTPUT: "json" }, true);
    expect(r.mode).toBe("json");
    expect(r.format).toBe("json");
    expect(r.explicit).toBe(false);
  });

  it("ignores unknown --format values, falls back to TTY default", () => {
    const r = resolveOutputMode({ format: "rainbow" }, {}, true);
    expect(r.format).toBe("pretty");
  });

  it("recognizes --format=snippets", () => {
    const r = resolveOutputMode({ format: "snippets" }, {}, true);
    expect(r.format).toBe("snippets");
    expect(r.mode).toBe("pretty");
    expect(r.explicit).toBe(true);
  });

  it("computes progress=pretty-tty on a color TTY with utf8 locale", () => {
    const r = resolveOutputMode({}, { LANG: "en_US.UTF-8" }, true, true);
    expect(r.progress).toBe("pretty-tty");
    expect(r.glyphsUtf8).toBe(true);
  });

  it("computes progress=pretty-log when stderr is not a TTY", () => {
    const r = resolveOutputMode({}, { LANG: "en_US.UTF-8" }, true, false);
    expect(r.progress).toBe("pretty-log");
  });

  it("computes progress=ndjson when --format=json", () => {
    const r = resolveOutputMode({ json: true }, {}, true, true);
    expect(r.progress).toBe("ndjson");
  });

  it("computes progress=silent when --quiet", () => {
    const r = resolveOutputMode({ quiet: true }, {}, true, true);
    expect(r.progress).toBe("silent");
  });

  it("computes progress=silent when KINDX_PROGRESS=off", () => {
    const r = resolveOutputMode({}, { KINDX_PROGRESS: "off" }, true, true);
    expect(r.progress).toBe("silent");
  });
});

describe("paletteFor", () => {
  it("returns identity helpers when color disabled", () => {
    const p = paletteFor(false);
    expect(p.bold("hi")).toBe("hi");
    expect(p.cyan("hi")).toBe("hi");
    expect(p.reset).toBe("");
  });

  it("wraps in ANSI when color enabled", () => {
    const p = paletteFor(true);
    expect(p.bold("hi")).toBe("\x1b[1mhi\x1b[0m");
  });
});

describe("glyphsFor", () => {
  it("returns Unicode when locale is UTF-8", () => {
    const g = glyphsFor({ LANG: "en_US.UTF-8" });
    expect(g.ok).toBe("✓");
  });

  it("returns ASCII fallback when locale is unset", () => {
    const g = glyphsFor({});
    expect(g.ok).toBe("[ok]");
  });

  it("KINDX_FORCE_UTF8=1 forces Unicode glyphs", () => {
    const g = glyphsFor({ KINDX_FORCE_UTF8: "1" });
    expect(g.ok).toBe("✓");
  });
});

describe("stripAnsi", () => {
  it("removes CSI escapes", () => {
    expect(stripAnsi("\x1b[1mhello\x1b[0m")).toBe("hello");
  });
  it("removes OSC sequences", () => {
    expect(stripAnsi("\x1b]9;4;1;50\x07x")).toBe("x");
  });
});

describe("jsonEnvelope", () => {
  it("wraps data in a stable shape", () => {
    const env = jsonEnvelope("search", { hits: [] });
    expect(env.ok).toBe(true);
    expect(env.command).toBe("search");
    expect(env.data).toEqual({ hits: [] });
    expect(env.warnings).toBeUndefined();
    expect(env.meta).toBeUndefined();
  });

  it("omits empty warnings and meta", () => {
    const env = jsonEnvelope("search", { hits: [] }, { warnings: [], meta: {} });
    expect(env.warnings).toBeUndefined();
    expect(env.meta).toBeUndefined();
  });

  it("includes non-empty warnings and meta", () => {
    const env = jsonEnvelope("search", { hits: [] }, { warnings: ["slow"], meta: { elapsedMs: 42 } });
    expect(env.warnings).toEqual(["slow"]);
    expect(env.meta).toEqual({ elapsedMs: 42 });
  });
});

describe("jsonEnvelopeEnabled", () => {
  it("returns true for KINDX_JSON_ENVELOPE=1", () => {
    expect(jsonEnvelopeEnabled({ KINDX_JSON_ENVELOPE: "1" })).toBe(true);
  });
  it("returns true for KINDX_JSON_ENVELOPE=true", () => {
    expect(jsonEnvelopeEnabled({ KINDX_JSON_ENVELOPE: "true" })).toBe(true);
  });
  it("returns false otherwise", () => {
    expect(jsonEnvelopeEnabled({})).toBe(false);
    expect(jsonEnvelopeEnabled({ KINDX_JSON_ENVELOPE: "0" })).toBe(false);
  });
});
