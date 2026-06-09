import { describe, it, expect } from "vitest";
import { KindxError, toKindxError, errorEnvelope } from "../../engine/cli/errors.js";

describe("KindxError", () => {
  it("preserves all fields and defaults exitCode to 1", () => {
    const e = new KindxError({ code: "config.missing", what: "no config" });
    expect(e.code).toBe("config.missing");
    expect(e.what).toBe("no config");
    expect(e.exitCode).toBe(1);
    expect(e.name).toBe("KindxError");
  });

  it("captures cause", () => {
    const root = new Error("root");
    const e = new KindxError({ code: "x", what: "y", cause: root });
    expect(e.cause).toBe(root);
  });
});

describe("toKindxError", () => {
  it("passes through KindxError instances", () => {
    const e = new KindxError({ code: "config.missing", what: "no config" });
    expect(toKindxError(e)).toBe(e);
  });

  it("maps SQLITE_NOTADB to index.corrupted with exit 65", () => {
    const e = toKindxError({ code: "SQLITE_NOTADB", message: "file is not a database" });
    expect(e.code).toBe("index.corrupted");
    expect(e.exitCode).toBe(65);
    expect(e.fix).toMatch(/re-index/i);
  });

  it("maps SQLITE_CANTOPEN to index.cant_open with exit 3", () => {
    const e = toKindxError({ code: "SQLITE_CANTOPEN", message: "no file" });
    expect(e.code).toBe("index.cant_open");
    expect(e.exitCode).toBe(3);
  });

  it("maps SQLITE_BUSY to index.busy", () => {
    const e = toKindxError({ code: "SQLITE_BUSY", message: "locked" });
    expect(e.code).toBe("index.busy");
  });

  it("wraps unknown errors as internal", () => {
    const e = toKindxError(new Error("boom"));
    expect(e.code).toBe("internal");
    expect(e.what).toBe("boom");
    expect(e.exitCode).toBe(1);
  });

  it("wraps plain values", () => {
    const e = toKindxError("oops");
    expect(e.code).toBe("internal");
    expect(e.what).toBe("oops");
  });
});

describe("errorEnvelope", () => {
  it("produces the stable JSON shape", () => {
    const e = new KindxError({
      code: "config.missing",
      what: "no config",
      fix: "run init",
      examples: ["kindx init"],
    });
    const env = errorEnvelope(e, "search");
    expect(env).toEqual({
      ok: false,
      command: "search",
      error: {
        code: "config.missing",
        what: "no config",
        fix: "run init",
        examples: ["kindx init"],
      },
    });
  });

  it("omits empty examples and undefined optional fields", () => {
    const e = new KindxError({ code: "x", what: "y" });
    const env = errorEnvelope(e);
    expect(env).toEqual({ ok: false, error: { code: "x", what: "y" } });
  });
});
