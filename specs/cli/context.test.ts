import { describe, it, expect } from "vitest";
import { makeCliContext } from "../../engine/cli/context.js";

describe("makeCliContext", () => {
  it("derives normal verbosity when no flags set", () => {
    const ctx = makeCliContext({
      command: "search",
      args: [],
      flags: {},
      env: {},
      stdoutIsTty: true,
    });
    expect(ctx.verbosity).toBe("normal");
    expect(ctx.output.mode).toBe("pretty");
  });

  it("picks --trace over --debug", () => {
    const ctx = makeCliContext({
      command: "search",
      args: [],
      flags: { trace: true, debug: true },
      env: {},
      stdoutIsTty: true,
    });
    expect(ctx.verbosity).toBe("trace");
  });

  it("picks --debug over --verbose", () => {
    const ctx = makeCliContext({
      command: "search",
      args: [],
      flags: { debug: true, verbose: true },
      env: {},
      stdoutIsTty: true,
    });
    expect(ctx.verbosity).toBe("debug");
  });

  it("--quiet overrides default", () => {
    const ctx = makeCliContext({
      command: "search",
      args: [],
      flags: { quiet: true },
      env: {},
      stdoutIsTty: true,
    });
    expect(ctx.verbosity).toBe("quiet");
  });

  it("envelope is on when --format json", () => {
    const ctx = makeCliContext({
      command: "search",
      args: [],
      flags: { format: "json" },
      env: {},
      stdoutIsTty: true,
    });
    expect(ctx.envelopeOn).toBe(true);
  });

  it("envelope honors KINDX_JSON_ENVELOPE=1 even with legacy --json", () => {
    const ctx = makeCliContext({
      command: "search",
      args: [],
      flags: { json: true },
      env: { KINDX_JSON_ENVELOPE: "1" },
      stdoutIsTty: true,
    });
    expect(ctx.envelopeOn).toBe(true);
  });

  it("envelope off when neither --format json nor env var set", () => {
    const ctx = makeCliContext({
      command: "search",
      args: [],
      flags: { json: true },
      env: {},
      stdoutIsTty: true,
    });
    expect(ctx.envelopeOn).toBe(false);
  });

  it("dryRun and assumeYes track their flags", () => {
    const ctx = makeCliContext({
      command: "cleanup",
      args: [],
      flags: { "dry-run": true, yes: true },
      env: {},
      stdoutIsTty: true,
    });
    expect(ctx.dryRun).toBe(true);
    expect(ctx.assumeYes).toBe(true);
  });

  it("palette is identity when color disabled", () => {
    const ctx = makeCliContext({
      command: "search",
      args: [],
      flags: { "no-color": true },
      env: {},
      stdoutIsTty: true,
    });
    expect(ctx.palette.bold("x")).toBe("x");
    expect(ctx.output.color).toBe(false);
  });
});
