import { describe, expect, test } from "vitest";
import { upsertFence, readFence } from "../engine/init/fence.js";

const MARKER = "kindx:auto-invocation";

describe("fence utility", () => {
  test("upsertFence appends to a file without an existing fence", () => {
    const before = "# My notes\n\nSome content.\n";
    const after = upsertFence(before, MARKER, "This is the contract.", 1);
    expect(after).toContain("# My notes");
    expect(after).toContain("<!-- kindx:auto-invocation:start v=1 -->");
    expect(after).toContain("This is the contract.");
    expect(after).toContain("<!-- kindx:auto-invocation:end -->");
  });

  test("upsertFence replaces an existing fence in place", () => {
    const before = `# Header
<!-- kindx:auto-invocation:start v=1 -->
OLD BODY
<!-- kindx:auto-invocation:end -->
Footer text.
`;
    const after = upsertFence(before, MARKER, "NEW BODY", 1);
    expect(after).toContain("NEW BODY");
    expect(after).not.toContain("OLD BODY");
    expect(after).toContain("Footer text.");
    expect(after.match(/kindx:auto-invocation:start/g)!.length).toBe(1);
  });

  test("upsertFence is idempotent — same body produces identical output", () => {
    const before = "# Header\n";
    const once = upsertFence(before, MARKER, "BODY", 1);
    const twice = upsertFence(once, MARKER, "BODY", 1);
    expect(twice).toBe(once);
  });

  test("readFence returns the body or null when absent", () => {
    const text = `<!-- kindx:auto-invocation:start v=1 -->
THE BODY
<!-- kindx:auto-invocation:end -->`;
    expect(readFence(text, MARKER)).toBe("THE BODY");
    expect(readFence("no fence here", MARKER)).toBeNull();
  });
});
