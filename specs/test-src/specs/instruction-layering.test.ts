import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadLayeredInstructions } from "../engine/instruction-layering.js";

describe("instruction layering", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("loads global then project chain with nearest file last", () => {
    const root = mkdtempSync(join(tmpdir(), "kindx-instr-"));
    roots.push(root);
    const child = join(root, "apps", "svc");
    mkdirSync(child, { recursive: true });
    const globalFile = join(root, "global.md");
    writeFileSync(globalFile, "GLOBAL");
    writeFileSync(join(root, "AGENTS.md"), "ROOT");
    writeFileSync(join(child, "AGENTS.md"), "CHILD");

    const out = loadLayeredInstructions({
      cwd: child,
      globalFiles: [globalFile],
    });

    expect(out.sources.length).toBe(3);
    expect(out.text).toContain("GLOBAL");
    expect(out.text).toContain("ROOT");
    expect(out.text).toContain("CHILD");
    expect(out.sources[out.sources.length - 1]?.path).toBe(join(child, "AGENTS.md"));
  });

  test("enforces max bytes and marks truncation", () => {
    const root = mkdtempSync(join(tmpdir(), "kindx-instr-"));
    roots.push(root);
    writeFileSync(join(root, "AGENTS.md"), "x".repeat(200));
    const out = loadLayeredInstructions({ cwd: root, maxTotalBytes: 32 });
    expect(out.text.length).toBeLessThanOrEqual(32);
    expect(out.truncated).toBe(true);
  });
});

