# KINDX Auto-Invocation — Phase A: Instructions & Tool Descriptions

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make MCP-aware agents auto-call `query`/`get`/`memory_*` by sharpening the `initialize` instructions and tool descriptions so the *first* thing every agent sees is a "WHEN TO CALL KINDX" contract — not a reference card.

**Architecture:** Single-file rewrite of `engine/protocol.ts`'s `buildInstructions()` and the `description:` field on the ten registered tools. New env-var (`KINDX_AUTO_INVOKE=off`) opts out. New `--health-check` flag on `kindx mcp` lets installers probe. Snapshot tests guard the wording so future edits stay deliberate.

**Tech Stack:** TypeScript, vitest, MCP SDK (`@modelcontextprotocol/sdk`), zod.

**Spec:** `docs/superpowers/specs/2026-05-23-kindx-auto-invocation-design.md`

**Scope cut:** This plan is Phase A only. The `kindx init` installer is Phase B (separate plan: `2026-05-23-kindx-auto-invocation-init.md`). Phase A ships independent value — agents already configured with kindx will start auto-calling it immediately.

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `engine/protocol.ts` | Modify | Rewrite `buildInstructions()` (~L594), reword 10 tool descriptions, change `query` defaults, honor `KINDX_AUTO_INVOKE=off`, enforce 8 KB ceiling. |
| `engine/kindx.ts` | Modify | Add `--health-check` flag handling near `case "mcp"` (~L4640). |
| `specs/protocol-instructions.test.ts` | Create | Snapshot + behavior tests for `buildInstructionsForTest` across 5 states. |
| `specs/protocol-tool-descriptions.test.ts` | Create | Asserts each tool description leads with the agreed WHEN-TO-USE sentence, and that `query.limit` defaults to 3. |
| `specs/protocol-initialize-smoke.test.ts` | Create | Integration smoke: in-process stdio server → `initialize` → assert contract appears. |
| `specs/mcp-health-check.test.ts` | Create | `kindx mcp --health-check` exits 0 when store is healthy, 1 when broken. |
| `capabilities/kindx/references/mcp-setup.md` | Modify | One-line note that auto-invocation is on by default. |
| `capabilities/kindx/SKILL.md` | Modify | Bump version, note auto-invocation default. |

---

## Task 1: Add contract template constants and `KINDX_AUTO_INVOKE` gate helper

**Files:**
- Modify: `engine/protocol.ts` (insert near existing `MEMORY_PREFETCH_*` constants around line 590)

- [ ] **Step 1: Add constants and helper above `buildInstructions`**

Insert directly above the existing `function buildInstructions(...)` (currently at engine/protocol.ts:594):

```ts
// =============================================================================
// Auto-invocation contract — appears at top of MCP `initialize.instructions`.
// Rewording this changes how aggressively every MCP-aware agent picks up kindx.
// Snapshot-tested in specs/protocol-instructions.test.ts; update snapshots
// deliberately, with a one-line rationale in the commit message.
// =============================================================================
const AUTO_INVOCATION_CONTRACT = [
  "## When to call KINDX (auto-invocation contract)",
  "",
  "Before answering any user turn that is not a greeting, a pure code-generation request",
  "with no reference to user files, or a trivial yes/no, call `query` first.",
  "Auto-invoke is default-on. Skip only when:",
  "  (a) the user explicitly says \"don't search\",",
  "  (b) you already have results from a query this turn, or",
  "  (c) the request is exclusively about writing new code with no need to consult prior notes.",
  "",
  "Decision table:",
  "  | User turn shape                                          | First call                       |",
  "  |----------------------------------------------------------|----------------------------------|",
  "  | \"what did I write about X\" / \"find …\" / \"show me …\"     | `query` (lex+vec)                |",
  "  | \"open <path>\" / mentions a specific file                 | `get`                            |",
  "  | Question that could be answered by existing notes        | `query` (vec+hyde)               |",
  "  | New code, no file reference                              | skip kindx                       |",
  "  | Greeting / chitchat                                      | skip kindx                       |",
  "  | Memory-related (\"remember\", \"what did we decide\")        | `memory_search` then `memory_put`|",
  "",
  "Cost: default `query` returns top 3 snippets (~600 tokens). Pull bodies with `get`",
  "only for snippets that look relevant. Set `KINDX_AUTO_INVOKE=off` on the server to disable.",
].join("\n");

const MAX_INSTRUCTIONS_BYTES = 8 * 1024;
const TRUNCATION_MARKER = "\n\n[instructions truncated — see kindx://capabilities]";

function isAutoInvokeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.KINDX_AUTO_INVOKE ?? "").trim().toLowerCase();
  return v !== "off" && v !== "0" && v !== "false";
}
```

- [ ] **Step 2: Verify the file still compiles**

Run: `npx tsc -p tsconfig.build.json --noEmit`
Expected: exit 0, no new errors.

- [ ] **Step 3: Commit**

```bash
git add engine/protocol.ts
git commit -m "feat(mcp): add auto-invocation contract constants and env gate

No behavior change yet — wires in the AUTO_INVOCATION_CONTRACT template,
8 KB instructions ceiling, and isAutoInvokeEnabled() helper that honors
KINDX_AUTO_INVOKE=off. Used by the next commit."
```

---

## Task 2: TDD — snapshot tests for `buildInstructions` across five states

**Files:**
- Create: `specs/protocol-instructions.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildInstructionsForTest } from "../engine/protocol.js";
import { openStore, closeStore } from "../engine/repository.js";

// Helpers — adapt openStore() to whatever the project exports if the name differs.
function freshIndex(): { root: string; close: () => void } {
  const root = mkdtempSync(join(tmpdir(), "kindx-inst-"));
  process.env.KINDX_DATA_DIR = root;
  openStore(); // creates schema if missing
  return {
    root,
    close: () => {
      closeStore();
      delete process.env.KINDX_DATA_DIR;
      rmSync(root, { recursive: true, force: true });
    },
  };
}

describe("buildInstructions auto-invocation contract", () => {
  let env: { root: string; close: () => void };
  beforeEach(() => { env = freshIndex(); });
  afterEach(() => { env.close(); });

  test("emits contract when collections exist", () => {
    // Seed one collection
    const docs = join(env.root, "notes");
    mkdirSync(docs, { recursive: true });
    writeFileSync(join(docs, "a.md"), "# A\n\nhello\n");
    // Register collection via the store API the project exposes
    // (the call below mirrors how kindx-cli does it — adjust to actual export)
    const { addCollection, indexCollections } = require("../engine/repository.js");
    addCollection({ name: "notes", path: docs });
    indexCollections();

    const out = buildInstructionsForTest(/* store */ undefined as any);
    expect(out).toContain("KINDX is your local search index");
    expect(out).toContain("When to call KINDX (auto-invocation contract)");
    expect(out).toContain("Decision table:");
    expect(out).toContain('"notes"');
  });

  test("suppresses contract when no collections are registered", () => {
    const out = buildInstructionsForTest(undefined as any);
    expect(out).not.toContain("auto-invocation contract");
    expect(out).toContain("no collections — run `kindx collection add`");
  });

  test("omits contract when KINDX_AUTO_INVOKE=off", () => {
    const docs = join(env.root, "notes");
    mkdirSync(docs, { recursive: true });
    writeFileSync(join(docs, "a.md"), "# A\n");
    const { addCollection, indexCollections } = require("../engine/repository.js");
    addCollection({ name: "notes", path: docs });
    indexCollections();

    process.env.KINDX_AUTO_INVOKE = "off";
    try {
      const out = buildInstructionsForTest(undefined as any);
      expect(out).not.toContain("auto-invocation contract");
      expect(out).toContain('"notes"'); // collections list still emitted
    } finally {
      delete process.env.KINDX_AUTO_INVOKE;
    }
  });

  test("notes lex-only mode when vector index is not built", () => {
    const docs = join(env.root, "notes");
    mkdirSync(docs, { recursive: true });
    writeFileSync(join(docs, "a.md"), "# A\n");
    const { addCollection, indexCollections } = require("../engine/repository.js");
    addCollection({ name: "notes", path: docs });
    indexCollections();
    // Do NOT call embed → status.hasVectorIndex is false

    const out = buildInstructionsForTest(undefined as any);
    expect(out).toContain("lex-only mode");
    expect(out).toContain("Run `kindx embed`");
  });

  test("hard-caps output at 8 KB with truncation marker", () => {
    // Seed enough collections to overflow
    const { addCollection, indexCollections } = require("../engine/repository.js");
    for (let i = 0; i < 200; i++) {
      const p = join(env.root, `col${i}`);
      mkdirSync(p, { recursive: true });
      writeFileSync(join(p, "x.md"), "# x\n");
      addCollection({ name: `col${i}`, path: p });
    }
    indexCollections();

    const out = buildInstructionsForTest(undefined as any);
    expect(out.length).toBeLessThanOrEqual(8 * 1024);
    expect(out.endsWith("see kindx://capabilities]")).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `npx vitest run specs/protocol-instructions.test.ts -v`
Expected: 5 failures (contract block, suppression, env-var gate, lex-only note, 8 KB cap all missing).

If `openStore`/`addCollection`/`indexCollections` exports don't exist verbatim, look at how `engine/repository.ts` actually exposes these and substitute — the test must drive *real* indexer behavior, not mocks, per the spec's testing philosophy. If the exact export name differs, update the test imports; don't refactor production code to fit the test.

- [ ] **Step 3: Commit**

```bash
git add specs/protocol-instructions.test.ts
git commit -m "test(protocol): failing snapshot tests for auto-invocation contract

Drives the buildInstructions() rewrite. Five states covered: contract
emission, no-collections suppression, KINDX_AUTO_INVOKE=off, lex-only
mode note, and 8 KB ceiling with truncation marker."
```

---

## Task 3: Rewrite `buildInstructions` to emit the contract

**Files:**
- Modify: `engine/protocol.ts` — replace body of `buildInstructions` (currently L594–L703)

- [ ] **Step 1: Replace the function body**

Replace the entire `function buildInstructions(...)` body (lines 594–703) with this new implementation. The existing memory-prefetch and layered-instructions logic is preserved — only ordering, the contract block, and the suppression/ceiling/lex-only logic are new.

```ts
function buildInstructions(store: Store, session?: KindxSession): string {
  const status = store.getStatus();
  const lines: string[] = [];

  // --- Identity (always first) ---
  const collectionNames = status.collections.map((c) => `"${c.name}"`).join(", ");
  const collectionsClause = collectionNames ? ` across collections: ${collectionNames}` : "";
  lines.push(
    `KINDX is your local search index over ${status.totalDocuments} markdown documents${collectionsClause}.`,
  );
  const globalCtx = getGlobalContext();
  if (globalCtx) lines.push(`Context: ${globalCtx}`);

  // --- Auto-invocation contract (load-bearing) ---
  if (status.collections.length === 0) {
    lines.push("");
    lines.push("kindx is installed but has no collections — run `kindx collection add <path>` to enable auto-search.");
  } else if (isAutoInvokeEnabled()) {
    lines.push("");
    lines.push(AUTO_INVOCATION_CONTRACT);
    if (!status.hasVectorIndex) {
      lines.push("");
      lines.push("Note: lex-only mode — vector index not built. Do not call `vec`/`hyde`. Run `kindx embed` to enable semantic search.");
    } else if (status.needsEmbedding > 0) {
      lines.push("");
      lines.push(`Note: ${status.needsEmbedding} documents need re-embedding. Run \`kindx embed\` to update.`);
    }
  } else if (!status.hasVectorIndex) {
    lines.push("");
    lines.push("Note: No vector embeddings yet. Run `kindx embed` to enable semantic search (vec/hyde).");
  } else if (status.needsEmbedding > 0) {
    lines.push("");
    lines.push(`Note: ${status.needsEmbedding} documents need embedding. Run \`kindx embed\` to update.`);
  }

  // --- Layered project instructions (AGENTS.md / SOUL.md / CLAUDE.md) ---
  const layered = loadLayeredInstructions({
    cwd: process.cwd(),
    globalFiles: [resolve(homedir(), ".codex", "AGENTS.md")],
    fallbackFiles: ["AGENTS.md", "SOUL.md", "CLAUDE.md"],
    maxTotalBytes: 16 * 1024,
  });
  if (layered.sources.length > 0) {
    lines.push("");
    lines.push("Instruction layers loaded (global->project):");
    for (const src of layered.sources) {
      const note = src.truncated ? " (truncated)" : "";
      lines.push(`  - ${src.scope}: ${src.path}${note}`);
    }
    lines.push("");
    lines.push("Layered instructions:");
    lines.push(layered.text);
  }

  // --- Collections list (detail) ---
  if (status.collections.length > 0) {
    lines.push("");
    lines.push("Collections (scope with `collection` parameter):");
    for (const col of status.collections) {
      const collConfig = getCollection(col.name);
      const rootCtx = collConfig?.context?.[""] || collConfig?.context?.["/"];
      const desc = rootCtx ? ` — ${rootCtx}` : "";
      lines.push(`  - "${col.name}" (${col.documents} docs)${desc}`);
    }
  }

  // --- Workspace memory prefetch (unchanged behaviour, kept) ---
  const workspaceScope = session?.scopeContext?.workspaceScope;
  if (workspaceScope) {
    try {
      const stats = getMemoryStats(store.db, workspaceScope);
      let topMemories = stats.topAccessed.slice(0, MEMORY_PREFETCH_LIMIT);
      if (topMemories.length === 0) {
        const recentRows = store.db.prepare(`
          SELECT value FROM memories
          WHERE scope = ? AND superseded_by IS NULL
          ORDER BY accessed_count DESC, appeared_count DESC, id DESC
          LIMIT ?
        `).all(workspaceScope, MEMORY_PREFETCH_LIMIT) as { value: string }[];
        topMemories = recentRows.map((r) => ({ key: "", value: String(r.value ?? ""), accessed: 0 }));
      }
      if (topMemories.length > 0) {
        lines.push("");
        lines.push("Workspace memory (top accessed):");
        let remainingChars = MEMORY_PREFETCH_TOTAL_MAX_CHARS;
        for (const m of topMemories) {
          if (remainingChars <= 0) break;
          const normalized = String(m.value ?? "").replace(/\n/g, " ").trim();
          if (!normalized) continue;
          const line = normalized.slice(0, Math.min(MEMORY_PREFETCH_LINE_MAX_CHARS, remainingChars));
          lines.push(`  - ${line}`);
          remainingChars -= line.length;
        }
      }
    } catch { /* best-effort */ }
  }

  // --- Condensed search/retrieval reference (long examples now live in tool descriptions) ---
  if (status.collections.length > 0) {
    lines.push("");
    lines.push("Tools: `query` (lex/vec/hyde sub-queries), `get` (path or #docid), `multi_get` (glob/list). Use `minScore: 0.5` to filter low-confidence results. File paths in results are collection-relative.");
  }

  // --- Hard ceiling ---
  let out = lines.join("\n");
  if (out.length > MAX_INSTRUCTIONS_BYTES) {
    const budget = MAX_INSTRUCTIONS_BYTES - TRUNCATION_MARKER.length;
    out = out.slice(0, budget) + TRUNCATION_MARKER;
  }
  return out;
}
```

- [ ] **Step 2: Run tests, verify they pass**

Run: `npx vitest run specs/protocol-instructions.test.ts -v`
Expected: all 5 tests PASS.

If a test fails because helper exports differ (e.g., `addCollection` is called `registerCollection` in this codebase) update the test imports, not the production code — production behaviour is the spec, the tests adapt to it.

- [ ] **Step 3: Sanity check nothing else broke**

Run: `npx vitest run specs/instruction-layering.test.ts specs/mcp.test.ts -v`
Expected: existing tests still pass.

- [ ] **Step 4: Commit**

```bash
git add engine/protocol.ts
git commit -m "feat(mcp): emit auto-invocation contract at top of instructions

Rewrites buildInstructions() so the very first thing every MCP-aware
agent sees is a 'WHEN TO CALL KINDX' contract with a 6-row decision
table. Falls back to a 'no collections' nudge when the index is empty,
suppresses entirely under KINDX_AUTO_INVOKE=off, marks lex-only mode
when vectors aren't built, and hard-caps output at 8 KB.

Preserves existing layered-AGENTS.md, collections list, and memory
prefetch logic — only reorders them after the contract."
```

---

## Task 4: Rewrite `query` tool description and tighten defaults

**Files:**
- Modify: `engine/protocol.ts` — `query` registration block (currently L903–L1003)

- [ ] **Step 1: Write the failing test**

Create `specs/protocol-tool-descriptions.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
// The protocol module doesn't export tool defs directly. We assert behaviour
// by spinning up the server in-memory and inspecting the registered tools list.
// If the project doesn't already expose a test hook for this, add one in
// engine/protocol.ts called listRegisteredToolsForTest(store) that returns
// [{ name, description, inputSchema }, ...].
import { listRegisteredToolsForTest } from "../engine/protocol.js";
import { openStore, closeStore } from "../engine/repository.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("tool descriptions lead with WHEN-TO-USE", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kindx-td-"));
    process.env.KINDX_DATA_DIR = root;
    openStore();
  });
  afterEach(() => {
    closeStore();
    delete process.env.KINDX_DATA_DIR;
    rmSync(root, { recursive: true, force: true });
  });

  const expectedLeads: Record<string, string> = {
    query: "Call this first whenever the user asks a question",
    get: "Call after `query` to read the full body",
    multi_get: "Call when you need multiple related docs at once",
    status: "Call once per session if `instructions` did not list collections",
    memory_search: 'Call at the start of any turn that says "we"',
    memory_put: "Call after the user states a preference, decision, or fact",
  };

  test("each tool's description leads with the agreed sentence", () => {
    const tools = listRegisteredToolsForTest();
    for (const [name, lead] of Object.entries(expectedLeads)) {
      const tool = tools.find((t) => t.name === name);
      expect(tool, `missing tool ${name}`).toBeDefined();
      expect(
        tool!.description.split("\n")[0],
        `tool ${name} should lead with: ${lead}`,
      ).toContain(lead);
    }
  });

  test("query.limit defaults to 3 (tight triage)", () => {
    const tools = listRegisteredToolsForTest();
    const query = tools.find((t) => t.name === "query")!;
    const schema: any = query.inputSchema.limit ?? query.inputSchema.shape?.limit;
    // zod stores defaults on `_def.defaultValue` for ZodDefault
    const def = schema?._def?.defaultValue?.() ?? schema?._def?.defaultValue;
    expect(def).toBe(3);
  });

  test("query has maxSnippetLines default of 4", () => {
    const tools = listRegisteredToolsForTest();
    const query = tools.find((t) => t.name === "query")!;
    const schema: any = query.inputSchema.maxSnippetLines ?? query.inputSchema.shape?.maxSnippetLines;
    const def = schema?._def?.defaultValue?.() ?? schema?._def?.defaultValue;
    expect(def).toBe(4);
  });
});
```

Run: `npx vitest run specs/protocol-tool-descriptions.test.ts -v`
Expected: 3 failures (description leads wrong, `limit` default is 10, `maxSnippetLines` has no default).

- [ ] **Step 2: Add the test hook `listRegisteredToolsForTest`**

In `engine/protocol.ts`, add near `buildInstructionsForTest`:

```ts
export function listRegisteredToolsForTest(): Array<{
  name: string;
  description: string;
  inputSchema: any;
}> {
  // Build a server with a fresh store, return the registration list captured.
  // The registry already exists inside createMcpServer as `registeredToolDefs`.
  // Expose it via an internal helper.
  const store = openStoreForCurrentIndex(); // existing helper used by the CLI
  const defs: any[] = [];
  const capture = (name: string, def: any) => defs.push({ name, description: def.description, inputSchema: def.inputSchema });
  createMcpServerWithCapture(store, capture);
  return defs;
}
```

Adjust `createMcpServer` to accept an optional `onRegister` callback that fires inside `maybeRegisterTool` after the tool is added — minimal change. If `openStoreForCurrentIndex` isn't the exact export name, use whatever the existing CLI uses.

- [ ] **Step 3: Replace the `query` description**

In `engine/protocol.ts`, replace the description string in the `query` registration (currently L907–963) with:

```ts
description: `Call this first whenever the user asks a question, references their notes/docs/codebase, or you need context grounded in the user's local knowledge.

## When to use
- User asks "what did I write about ...", "find ...", "show me ..."
- User asks a factual question whose answer might live in their notes
- You need background context before answering or editing
- Skip: greetings, pure code-generation with no file reference, trivial yes/no

## How to call
One or more typed sub-queries combined for best recall.

**lex** — BM25 keyword search. Fast, exact, no LLM needed.
- \`term\` — prefix match ("perf" matches "performance")
- \`"exact phrase"\` — phrase must appear verbatim
- \`-term\` or \`-"phrase"\` — exclude documents

**vec** — Semantic vector search. Write a natural-language question.

**hyde** — Hypothetical document. Write 50–100 words that look like the answer. Often the most powerful for nuanced topics.

| Goal | Approach |
|------|----------|
| Know exact term/name | \`lex\` only |
| Concept search | \`vec\` only |
| Best recall | \`lex\` + \`vec\` |
| Complex/nuanced | \`lex\` + \`vec\` + \`hyde\` |

Defaults to top 3 snippets (~600 tokens). Pull bodies with \`get\` for any snippet that looks relevant. First sub-query gets 2× weight — put your strongest signal first.

Example:
\`\`\`json
[
  { "type": "lex", "query": "\\"connection pool\\" timeout" },
  { "type": "vec", "query": "why do database connections time out under load" }
]
\`\`\``,
```

- [ ] **Step 4: Change `query` defaults — `limit` 10 → 3, add `maxSnippetLines` default 4**

In the same registration's `inputSchema`, change:

```ts
limit: z.number().max(200).optional().default(10).describe("Max results (default: 10, max: 200)"),
```
to:
```ts
limit: z.number().max(200).optional().default(3).describe("Max results (default: 3 for tight triage, max: 200). Use `get` to expand a snippet rather than raising this."),
```

And change:
```ts
maxSnippetLines: z.number().optional().describe(
  "Maximum lines per result snippet. Truncates to the most relevant excerpt. Reduces token usage for agents with limited context windows."
),
```
to:
```ts
maxSnippetLines: z.number().optional().default(4).describe(
  "Maximum lines per result snippet (default: 4). Reduces token usage; use `get` to read the full body of a promising result."
),
```

- [ ] **Step 5: Run tests, verify they pass**

Run: `npx vitest run specs/protocol-tool-descriptions.test.ts -v`
Expected: 3 tests PASS (one of them, the description-lead test, still needs the *other* tool descriptions updated — see Tasks 5 and 6; for now only the `query` row will pass and the others will fail loudly).

- [ ] **Step 6: Commit**

```bash
git add engine/protocol.ts specs/protocol-tool-descriptions.test.ts
git commit -m "feat(mcp): reframe query tool — lead with WHEN, tighten defaults

query description now opens with 'Call this first whenever the user
asks a question'. Default limit drops 10→3 (tight triage); add default
maxSnippetLines=4. Pull bodies with get for promising snippets rather
than raising limit. Adds listRegisteredToolsForTest test hook."
```

---

## Task 5: Rewrite `get`, `multi_get`, `status` tool descriptions

**Files:**
- Modify: `engine/protocol.ts` — `get` (~L1237), `multi_get` (~L1358), `status` (~L1477)

- [ ] **Step 1: Replace each description**

Replace the `description:` field on each registration:

`get` (currently `"Retrieve the full content of a document by its file path or docid..."`):
```ts
description: `Call after \`query\` to read the full body of a result that looked promising in a snippet. Also call when the user mentions a specific file path or docid.

Use paths or docids (#abc123) from search results. Supports line offset via "file.md:100" or the \`fromLine\` param. Suggests similar files if not found.`,
```

`multi_get` (currently `"Retrieve multiple documents by glob pattern..."`):
```ts
description: `Call when you need multiple related docs at once — e.g., a glob like 'journals/2025-05*.md' or a comma-separated list of paths returned by a prior \`query\`. Skips files larger than maxBytes (default 10 KB).`,
```

`status`:
```ts
description: `Call once per session if \`instructions\` did not list collections — surfaces what's actually indexed, vector readiness, and scale metrics. Rarely needed mid-turn.`,
```

- [ ] **Step 2: Run tests**

Run: `npx vitest run specs/protocol-tool-descriptions.test.ts -v`
Expected: `query`, `get`, `multi_get`, `status` rows now pass; `memory_search` / `memory_put` still fail (next task).

- [ ] **Step 3: Commit**

```bash
git add engine/protocol.ts
git commit -m "feat(mcp): reframe get/multi_get/status descriptions

Lead each with WHEN to call, demote syntax/usage to a 'How' section."
```

---

## Task 6: Rewrite `memory_*` tool descriptions

**Files:**
- Modify: `engine/protocol.ts` — `memory_put` (~L1590), `memory_search` (~L1639), `memory_history` (~L1673), `memory_stats` (~L1701), `memory_mark_accessed` (~L1728), `memory_delete` (~L1762), `memory_bulk` (~L1809), `memory_feedback` (~L2085)

- [ ] **Step 1: Replace descriptions**

`memory_search`:
```ts
description: `Call at the start of any turn that says "we", "earlier", "you remember", "the project", or that resumes ongoing work. Searches workspace and session memory; returns ranked entries with their scope.`,
```

`memory_put`:
```ts
description: `Call after the user states a preference, decision, or fact you'll need next session. Do not echo memory back; just persist with the smallest appropriate scope (session > workspace > global).`,
```

For `memory_history`, `memory_stats`, `memory_mark_accessed`, `memory_delete`, `memory_bulk`, `memory_feedback`, prefix each existing description with one diagnostic-only sentence:
```
Diagnostic — only call when the user asks about memory itself, not in normal answer flow. <existing description>
```

- [ ] **Step 2: Run tests**

Run: `npx vitest run specs/protocol-tool-descriptions.test.ts -v`
Expected: all assertions PASS.

- [ ] **Step 3: Run the full suite to confirm no regressions**

Run: `npm test`
Expected: existing suite green; the two new test files pass.

- [ ] **Step 4: Commit**

```bash
git add engine/protocol.ts
git commit -m "feat(mcp): reframe memory_* tool descriptions

memory_search/memory_put now lead with the trigger phrasing they
should match; the diagnostic memory tools (history/stats/mark/delete/
bulk/feedback) are explicitly marked 'only call when the user asks
about memory itself'."
```

---

## Task 7: Add `--health-check` flag to `kindx mcp`

**Files:**
- Modify: `engine/kindx.ts` — `case "mcp"` (~L4640)
- Create: `specs/mcp-health-check.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const cli = resolve(__dirname, "..", "engine", "kindx.ts");

describe("kindx mcp --health-check", () => {
  test("exits 0 when store is reachable", () => {
    const out = execFileSync(
      "npx",
      ["tsx", cli, "mcp", "--health-check"],
      { encoding: "utf-8" },
    );
    expect(out).toContain("ok");
  });

  test("exits 1 when KINDX_DATA_DIR points at a non-existent dir", () => {
    try {
      execFileSync(
        "npx",
        ["tsx", cli, "mcp", "--health-check"],
        { encoding: "utf-8", env: { ...process.env, KINDX_DATA_DIR: "/nonexistent/path/that/will/fail" } },
      );
      throw new Error("should have exited non-zero");
    } catch (err: any) {
      expect(err.status).toBe(1);
    }
  });
});
```

Run: `npx vitest run specs/mcp-health-check.test.ts -v`
Expected: both tests FAIL (flag not recognized).

- [ ] **Step 2: Add flag handling**

In `engine/kindx.ts`, locate `case "mcp": {` (currently L4640) and insert this block immediately *before* the existing `const sub = cli.args[0];` line:

```ts
if (cli.values["health-check"]) {
  try {
    const store = openStoreForCurrentIndex(); // or whatever helper opens the default store
    const status = store.getStatus();
    closeDb();
    console.log(JSON.stringify({ ok: true, totalDocuments: status.totalDocuments, collections: status.collections.length }));
    process.exit(0);
  } catch (err: any) {
    console.error(JSON.stringify({ ok: false, error: String(err?.message ?? err) }));
    process.exit(1);
  }
}
```

Also register the flag in the CLI flag spec near the top of `kindx.ts` (find where other `mcp`-specific flags like `--http`, `--daemon`, `--port` are declared and add):

```ts
"health-check": { type: "boolean" },
```

- [ ] **Step 3: Verify tests pass**

Run: `npx vitest run specs/mcp-health-check.test.ts -v`
Expected: both tests PASS.

- [ ] **Step 4: Commit**

```bash
git add engine/kindx.ts specs/mcp-health-check.test.ts
git commit -m "feat(cli): add 'kindx mcp --health-check' flag

Exits 0 with a {ok, totalDocuments, collections} JSON line when the
store opens cleanly; exits 1 with {ok:false, error} on failure. Used
by 'kindx init' adapters to probe the install."
```

---

## Task 8: Integration smoke — `initialize` returns the contract

**Files:**
- Create: `specs/protocol-initialize-smoke.test.ts`

- [ ] **Step 1: Write the test**

```ts
import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { startMcpServerForTest } from "../engine/protocol.js"; // exposes the McpServer for in-memory pairing

describe("MCP initialize smoke — contract is delivered", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kindx-init-smoke-"));
    process.env.KINDX_DATA_DIR = root;
    const docs = join(root, "notes");
    mkdirSync(docs, { recursive: true });
    writeFileSync(join(docs, "a.md"), "# A\n");
    const { addCollection, indexCollections } = require("../engine/repository.js");
    addCollection({ name: "notes", path: docs });
    indexCollections();
  });
  afterEach(() => {
    delete process.env.KINDX_DATA_DIR;
    rmSync(root, { recursive: true, force: true });
  });

  test("initialize result contains auto-invocation contract and condensed reference", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = startMcpServerForTest(); // returns the McpServer instance (un-connected)
    await server.connect(serverTransport);

    const client = new Client({ name: "test", version: "0.0.1" });
    await client.connect(clientTransport);

    const initResult = (client as any).getServerCapabilities();
    const instructions: string = (client as any).getInstructions?.() ?? "";

    expect(instructions).toContain("When to call KINDX (auto-invocation contract)");
    expect(instructions).toContain("Decision table");
    expect(instructions).toContain('"notes"');

    const tools = await client.listTools();
    const query = tools.tools.find((t: any) => t.name === "query");
    expect(query?.description).toMatch(/^Call this first/);

    await client.close();
    await server.close();
  });
});
```

If `startMcpServerForTest` doesn't exist, add it in `engine/protocol.ts`:
```ts
export function startMcpServerForTest(): McpServer {
  return createMcpServer(openStoreForCurrentIndex());
}
```

- [ ] **Step 2: Run the test**

Run: `npx vitest run specs/protocol-initialize-smoke.test.ts -v`
Expected: PASS.

If `InMemoryTransport` isn't available at that import path, check the installed `@modelcontextprotocol/sdk` version (`npm ls @modelcontextprotocol/sdk`) and adjust. Most versions ship it at `@modelcontextprotocol/sdk/inMemory.js`.

- [ ] **Step 3: Commit**

```bash
git add specs/protocol-initialize-smoke.test.ts engine/protocol.ts
git commit -m "test(mcp): smoke — initialize delivers auto-invocation contract

In-process stdio pairing via InMemoryTransport. Asserts the contract
text reaches the client and that the query tool description leads
with 'Call this first'."
```

---

## Task 9: Surface the new default in user-facing docs

**Files:**
- Modify: `capabilities/kindx/references/mcp-setup.md`
- Modify: `capabilities/kindx/SKILL.md`

- [ ] **Step 1: Update SKILL.md version + add note**

Bump the version in the frontmatter (line ~8) from `2.0.0` to `2.1.0`. Under the existing introductory paragraph, add:

```markdown
> **Auto-invocation:** As of v2.1.0 kindx tells every MCP-aware agent to call `query` automatically before answering questions that could be informed by your notes. Set `KINDX_AUTO_INVOKE=off` in the server's environment to disable.
```

- [ ] **Step 2: Update mcp-setup.md**

After the "Install" section, before "Configure MCP Client", add:

```markdown
## How auto-invocation works

Once kindx is configured in your MCP client and you've added at least one collection, agents will automatically call `query` before answering questions that might be informed by your local notes — no need to say "search my notes". The contract is delivered via MCP `initialize.instructions`.

To disable: run kindx with `KINDX_AUTO_INVOKE=off` in its environment.
```

- [ ] **Step 3: Commit**

```bash
git add capabilities/kindx/SKILL.md capabilities/kindx/references/mcp-setup.md
git commit -m "docs: note auto-invocation is default-on as of v2.1.0

SKILL.md version bump; mcp-setup.md gains a 'How auto-invocation
works' section documenting the default behaviour and the env-var
opt-out."
```

---

## Task 10: Telemetry — `trigger` field, `--auto-invoke-rate` flag, capabilities counter

**Files:**
- Modify: `engine/session.ts` — augment `queryLog` entries with a `trigger?: "user-explicit" | "agent-auto" | "unknown"` field.
- Modify: `engine/protocol.ts` — record `trigger` on tool-call wrap; expose `contractEmitted` on capability manifest.
- Modify: `engine/capability-manifest.ts` — add `autoInvocation: { contractEmitted: boolean; lastTurnTrigger?: string }`.
- Modify: `engine/kindx.ts` — add `--auto-invoke-rate` flag to the `status` subcommand.
- Create: `specs/auto-invoke-telemetry.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const cli = resolve(__dirname, "..", "engine", "kindx.ts");

describe("auto-invoke telemetry", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kindx-tel-"));
    process.env.KINDX_DATA_DIR = root;
    const docs = join(root, "notes");
    mkdirSync(docs, { recursive: true });
    writeFileSync(join(docs, "a.md"), "# A\nhello\n");
  });
  afterEach(() => {
    delete process.env.KINDX_DATA_DIR;
    rmSync(root, { recursive: true, force: true });
  });

  test("'kindx status --auto-invoke-rate' prints a JSON-able summary even with no calls", () => {
    const out = execFileSync(
      "npx",
      ["tsx", cli, "status", "--auto-invoke-rate", "--format", "json"],
      { encoding: "utf-8", env: process.env },
    );
    const parsed = JSON.parse(out);
    // Envelope or direct payload — accept either shape.
    const data = parsed.data ?? parsed;
    expect(data).toHaveProperty("autoInvocation");
    expect(data.autoInvocation).toHaveProperty("totalCalls");
    expect(data.autoInvocation).toHaveProperty("agentAuto");
    expect(data.autoInvocation).toHaveProperty("userExplicit");
  });

  test("capability manifest exposes autoInvocation.contractEmitted", async () => {
    const { buildCapabilityManifest } = await import("../engine/capability-manifest.js");
    const { openStoreForCurrentIndex } = await import("../engine/repository.js");
    const store = openStoreForCurrentIndex();
    const m = buildCapabilityManifest(store, []);
    expect(m).toHaveProperty("autoInvocation");
    expect(typeof (m as any).autoInvocation.contractEmitted).toBe("boolean");
  });
});
```

Run: `npx vitest run specs/auto-invoke-telemetry.test.ts -v`
Expected: 2 failures.

- [ ] **Step 2: Add `trigger` to queryLog and tool-call wrap**

In `engine/session.ts`, extend the queryLog entry type:

```ts
export interface QueryLogEntry {
  tool: string;
  timestamp: number;
  trigger?: "user-explicit" | "agent-auto" | "unknown";
  // ...existing fields
}
```

In `engine/protocol.ts`, wherever tool handlers record a call into `session.queryLog`, infer the trigger by inspecting the request's `_meta` field (MCP SDK exposes it) for a `kindx.trigger` hint, else default to `"unknown"`. Clients that want explicit attribution can pass `_meta.kindx.trigger`, but the default behaviour is unchanged.

```ts
// inside the tool handler closure, after a successful response
const meta = (request as any)?.params?._meta?.kindx;
session?.queryLog.push({
  tool: name,
  timestamp: Date.now(),
  trigger: meta?.trigger === "user-explicit" || meta?.trigger === "agent-auto" ? meta.trigger : "unknown",
});
```

- [ ] **Step 3: Add `autoInvocation` block to the capability manifest**

In `engine/capability-manifest.ts`, extend the manifest type and builder:

```ts
export interface CapabilityManifest {
  // ...existing fields
  autoInvocation: {
    contractEmitted: boolean;
    lastTurnTrigger?: string;
  };
}

// In buildCapabilityManifest:
return {
  // ...existing,
  autoInvocation: {
    contractEmitted: isAutoInvokeEnabled() && store.getStatus().collections.length > 0,
  },
};
```

(Import `isAutoInvokeEnabled` from `./protocol.js` — export it from there.)

- [ ] **Step 4: Wire `--auto-invoke-rate` on the `status` subcommand**

In `engine/kindx.ts` find `case "status":` and add inside it:

```ts
if (cli.values["auto-invoke-rate"]) {
  const store = openStoreForCurrentIndex();
  // Aggregate from the persistent query log table if present, else from in-memory session counters.
  const rows = store.db.prepare(`
    SELECT trigger, COUNT(*) as n FROM mcp_query_log GROUP BY trigger
  `).all() as Array<{ trigger: string | null; n: number }>;
  const counts = { totalCalls: 0, agentAuto: 0, userExplicit: 0, unknown: 0 };
  for (const r of rows) {
    counts.totalCalls += r.n;
    if (r.trigger === "agent-auto") counts.agentAuto += r.n;
    else if (r.trigger === "user-explicit") counts.userExplicit += r.n;
    else counts.unknown += r.n;
  }
  const data = { autoInvocation: counts };
  if (cli.opts.format === "json") {
    console.log(JSON.stringify(jsonEnvelopeEnabled(process.env) ? { ok: true, command: "status", data } : data, null, 2));
  } else {
    console.log(`Auto-invoke rate: ${counts.agentAuto}/${counts.totalCalls} agent-auto, ${counts.userExplicit} user-explicit, ${counts.unknown} unknown.`);
  }
  process.exit(0);
}
```

Register the flag at the top of `kindx.ts`:
```ts
"auto-invoke-rate": { type: "boolean" },
```

If the `mcp_query_log` table doesn't exist yet, add a minimal migration: a one-table `CREATE TABLE IF NOT EXISTS mcp_query_log (id INTEGER PRIMARY KEY, tool TEXT, trigger TEXT, ts INTEGER)` in `engine/schema.ts` (or wherever schema migrations live) and write into it from the tool handler in Step 2.

- [ ] **Step 5: Verify tests pass**

Run: `npx vitest run specs/auto-invoke-telemetry.test.ts -v`
Expected: both PASS.

- [ ] **Step 6: Commit**

```bash
git add engine/session.ts engine/protocol.ts engine/capability-manifest.ts engine/kindx.ts engine/schema.ts specs/auto-invoke-telemetry.test.ts
git commit -m "feat(mcp): trigger telemetry — agent-auto vs user-explicit

Logs a trigger field per tool call (default 'unknown' unless client
passes _meta.kindx.trigger). 'kindx status --auto-invoke-rate' summarises
the rate locally. Capability manifest gains autoInvocation.contractEmitted
so MCP clients can observe whether the contract is active."
```

---

## Final verification

- [ ] **Step 1: Run the full test suite**

```bash
npm test
```
Expected: all green, including new files.

- [ ] **Step 2: Manual smoke — point a real MCP client at the dev build**

```bash
npm run build
node dist/kindx.js mcp --health-check
```
Expected: prints `{"ok":true,...}` and exits 0.

Then add the dev binary temporarily to `~/.claude/settings.json`:
```json
{ "mcpServers": { "kindx-dev": { "command": "node", "args": ["<repo>/dist/kindx.js", "mcp"] } } }
```
Restart Claude Code. Ask "what did I write about <something in your notes>" without saying "search". Confirm the agent auto-fires `query`.

- [ ] **Step 3: Push branch / open PR**

Branch should be ~9 commits, all green. PR title: `feat(mcp): auto-invocation contract — agents call kindx by default`. PR body should link to the spec and the validation transcript.

---

## Done conditions

- `buildInstructionsForTest` snapshot tests pass across 5 states.
- `query.limit` defaults to 3, `maxSnippetLines` defaults to 4.
- All 10 tool descriptions lead with WHEN-TO-USE.
- `kindx mcp --health-check` exits 0/1 cleanly.
- Integration smoke verifies the contract reaches the client.
- `KINDX_AUTO_INVOKE=off` suppresses the contract block.
- `npm test` is green.
