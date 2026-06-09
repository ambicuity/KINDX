# KINDX Auto-Invocation — Phase B: `kindx init` Subcommand

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `kindx init` — a single CLI command that wires the kindx MCP server into every detected MCP-aware client (Claude Code, Claude Desktop, Cursor, Continue, OpenCode, Codex CLI, Copilot CLI, Zed) and drops a fenced auto-invocation block into project AGENTS.md/CLAUDE.md/.cursorrules so the contract survives in hosts that bury MCP instructions.

**Architecture:** Adapter pattern. A generic `createJsonAdapter()` builds an adapter from a config (name, config path, key path); `createTomlAdapter()` does the same for Codex. A single `adapters.ts` lists them all. A `fence.ts` utility handles idempotent fenced-block read/replace/append. The CLI dispatcher gains `case "init"` near `case "mcp"`.

**Tech Stack:** TypeScript, vitest, `@iarna/toml` (for Codex) — add to dependencies. JSON is parsed manually so we can tolerate JSONC comments where Cursor/Zed use them.

**Spec:** `docs/superpowers/specs/2026-05-23-kindx-auto-invocation-design.md`

**Dependency:** Phase A (`2026-05-23-kindx-auto-invocation-instructions.md`) MUST ship first. Phase B reuses the contract template constant from Phase A when rendering the fenced project block.

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `engine/init/types.ts` | Create | `Adapter` interface, `InitOptions` shape, `DetectResult`. |
| `engine/init/fence.ts` | Create | `readFence(text, marker)`, `upsertFence(text, marker, body)`. Pure functions, no I/O. |
| `engine/init/json-adapter.ts` | Create | `createJsonAdapter({ name, configPath, keyPath, jsoncTolerant })` → `Adapter`. |
| `engine/init/toml-adapter.ts` | Create | `createTomlAdapter({ name, configPath, key })` → `Adapter`. |
| `engine/init/adapters.ts` | Create | Exports `ALL_ADAPTERS: Adapter[]` — the 9 client adapters. |
| `engine/init/index.ts` | Create | Orchestrator: `runInit(opts)` — detect, prompt, write, summarise. |
| `engine/init/render-project-block.ts` | Create | Renders the fenced AGENTS.md block from the Phase A `AUTO_INVOCATION_CONTRACT` constant. |
| `engine/kindx.ts` | Modify | New `case "init":` in CLI dispatcher (near line 4640 where `case "mcp"` lives). |
| `specs/init-fence.test.ts` | Create | Unit tests for the fence utility (round-trip, idempotency). |
| `specs/init-json-adapter.test.ts` | Create | Per-adapter parse → write → re-parse round-trip; preserves unrelated keys; JSONC comments survive. |
| `specs/init-toml-adapter.test.ts` | Create | Same for the TOML adapter. |
| `specs/init-orchestrator.test.ts` | Create | End-to-end: tmpdir filesystem, run `runInit`, assert all configured files exist with kindx entries. |
| `docs/auto-invocation-validation.md` | Create | Manual matrix template engineer fills in per release. |
| `capabilities/kindx/references/mcp-setup.md` | Modify | Point users to `kindx init` first; keep manual config as fallback. |
| `capabilities/kindx/references/ollama-bridge.md` | Create | Docs for the Ollama bridge shim (no auto-wire in v1). |

---

## Task 1: Add `@iarna/toml` dependency

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install**

```bash
npm install --save @iarna/toml
```

- [ ] **Step 2: Verify the dependency was added**

```bash
grep -A1 '"@iarna/toml"' package.json
```
Expected: shows a line under `"dependencies"`.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add @iarna/toml for Codex MCP config parsing"
```

---

## Task 2: Define the Adapter interface and types

**Files:**
- Create: `engine/init/types.ts`

- [ ] **Step 1: Write the file**

```ts
export interface DetectResult {
  /** Absolute path the adapter looks at. */
  configPath: string;
  /** True if the file exists; false if absent (init may create it). */
  exists: boolean;
  /** True if a `kindx` entry is already present. */
  alreadyWired: boolean;
}

export interface WriteResult {
  configPath: string;
  /** Path of the timestamped backup, if a backup was created. */
  backupPath?: string;
  /** "created" | "updated" | "skipped". */
  outcome: "created" | "updated" | "skipped";
  /** Human-readable reason for skipped, e.g. "already wired (use --force to overwrite)". */
  reason?: string;
}

export interface Adapter {
  /** Stable id, e.g. "claude-code". Matches `--client <name>`. */
  name: string;
  /** User-friendly label for the summary table. */
  label: string;
  /** Best-effort detection of whether the client is installed/configured locally. */
  detect(): DetectResult;
  /**
   * Write kindx into the config. Idempotent — if `force` is false and `alreadyWired`
   * is true, return outcome="skipped".
   */
  write(opts: { force: boolean; dryRun: boolean; command: string; args: string[] }): WriteResult;
}

export interface InitOptions {
  clients: string[]; // ["auto"] | ["all"] | ["claude-code", "cursor", ...]
  projectPath?: string; // default cwd; "" or "--global" disables project file write
  globalOnly: boolean;
  dryRun: boolean;
  force: boolean;
}
```

- [ ] **Step 2: Commit**

```bash
git add engine/init/types.ts
git commit -m "feat(init): define Adapter and InitOptions types"
```

---

## Task 3: Implement the fence utility (TDD)

**Files:**
- Create: `specs/init-fence.test.ts`
- Create: `engine/init/fence.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, test } from "vitest";
import { upsertFence, readFence } from "../engine/init/fence.js";

const MARKER = "kindx:auto-invocation";

describe("fence utility", () => {
  test("upsertFence appends to a file without an existing fence", () => {
    const before = "# My notes\n\nSome content.\n";
    const body = "This is the contract.";
    const after = upsertFence(before, MARKER, body, 1);
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
    // No duplicate fences
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
```

Run: `npx vitest run specs/init-fence.test.ts -v`
Expected: 4 failures (module does not exist).

- [ ] **Step 2: Implement `engine/init/fence.ts`**

```ts
/**
 * Idempotent fenced-block utilities.
 * Markers look like:  <!-- {marker}:start v={version} -->  ...  <!-- {marker}:end -->
 */

function fenceRegex(marker: string): RegExp {
  const m = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `<!--\\s*${m}:start\\s+v=\\d+\\s*-->[\\s\\S]*?<!--\\s*${m}:end\\s*-->`,
    "g",
  );
}

export function readFence(text: string, marker: string): string | null {
  const match = fenceRegex(marker).exec(text);
  if (!match) return null;
  const block = match[0];
  const inner = block
    .replace(new RegExp(`^<!--\\s*${marker}:start\\s+v=\\d+\\s*-->\\n?`), "")
    .replace(new RegExp(`\\n?<!--\\s*${marker}:end\\s*-->$`), "");
  return inner.trim();
}

export function upsertFence(text: string, marker: string, body: string, version = 1): string {
  const block = `<!-- ${marker}:start v=${version} -->\n${body.trim()}\n<!-- ${marker}:end -->`;
  if (fenceRegex(marker).test(text)) {
    return text.replace(fenceRegex(marker), block);
  }
  const sep = text.endsWith("\n") ? "\n" : "\n\n";
  return text + sep + block + "\n";
}
```

- [ ] **Step 3: Run tests, verify they pass**

Run: `npx vitest run specs/init-fence.test.ts -v`
Expected: 4 tests PASS.

- [ ] **Step 4: Commit**

```bash
git add engine/init/fence.ts specs/init-fence.test.ts
git commit -m "feat(init): idempotent fence utility for AGENTS.md blocks"
```

---

## Task 4: Implement `createJsonAdapter` (TDD)

**Files:**
- Create: `specs/init-json-adapter.test.ts`
- Create: `engine/init/json-adapter.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJsonAdapter } from "../engine/init/json-adapter.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "kindx-jsa-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("createJsonAdapter", () => {
  test("creates file with mcpServers.kindx when missing", () => {
    const cfg = join(dir, "settings.json");
    const a = createJsonAdapter({ name: "test", label: "Test", configPath: cfg, keyPath: ["mcpServers", "kindx"] });
    expect(a.detect().exists).toBe(false);
    const r = a.write({ force: false, dryRun: false, command: "kindx", args: ["mcp"] });
    expect(r.outcome).toBe("created");
    const parsed = JSON.parse(readFileSync(cfg, "utf-8"));
    expect(parsed.mcpServers.kindx).toEqual({ command: "kindx", args: ["mcp"] });
  });

  test("preserves unrelated keys", () => {
    const cfg = join(dir, "settings.json");
    writeFileSync(cfg, JSON.stringify({ theme: "dark", mcpServers: { other: { command: "x" } } }, null, 2));
    const a = createJsonAdapter({ name: "test", label: "Test", configPath: cfg, keyPath: ["mcpServers", "kindx"] });
    const r = a.write({ force: false, dryRun: false, command: "kindx", args: ["mcp"] });
    expect(r.outcome).toBe("updated");
    const parsed = JSON.parse(readFileSync(cfg, "utf-8"));
    expect(parsed.theme).toBe("dark");
    expect(parsed.mcpServers.other).toEqual({ command: "x" });
    expect(parsed.mcpServers.kindx).toEqual({ command: "kindx", args: ["mcp"] });
  });

  test("skips when already wired and force=false", () => {
    const cfg = join(dir, "settings.json");
    writeFileSync(cfg, JSON.stringify({ mcpServers: { kindx: { command: "kindx", args: ["mcp"] } } }));
    const a = createJsonAdapter({ name: "test", label: "Test", configPath: cfg, keyPath: ["mcpServers", "kindx"] });
    expect(a.detect().alreadyWired).toBe(true);
    const r = a.write({ force: false, dryRun: false, command: "kindx", args: ["mcp"] });
    expect(r.outcome).toBe("skipped");
  });

  test("overwrites when force=true", () => {
    const cfg = join(dir, "settings.json");
    writeFileSync(cfg, JSON.stringify({ mcpServers: { kindx: { command: "old", args: [] } } }));
    const a = createJsonAdapter({ name: "test", label: "Test", configPath: cfg, keyPath: ["mcpServers", "kindx"] });
    const r = a.write({ force: true, dryRun: false, command: "kindx", args: ["mcp"] });
    expect(r.outcome).toBe("updated");
    expect(JSON.parse(readFileSync(cfg, "utf-8")).mcpServers.kindx.command).toBe("kindx");
    expect(r.backupPath && existsSync(r.backupPath)).toBe(true);
  });

  test("dryRun does not touch disk", () => {
    const cfg = join(dir, "settings.json");
    const a = createJsonAdapter({ name: "test", label: "Test", configPath: cfg, keyPath: ["mcpServers", "kindx"] });
    const r = a.write({ force: false, dryRun: true, command: "kindx", args: ["mcp"] });
    expect(r.outcome).toBe("created");
    expect(existsSync(cfg)).toBe(false);
  });

  test("handles nested keyPath (e.g. ['mcp','servers','kindx'])", () => {
    const cfg = join(dir, "opencode.json");
    const a = createJsonAdapter({ name: "test", label: "Test", configPath: cfg, keyPath: ["mcp", "servers", "kindx"] });
    a.write({ force: false, dryRun: false, command: "kindx", args: ["mcp"] });
    const parsed = JSON.parse(readFileSync(cfg, "utf-8"));
    expect(parsed.mcp.servers.kindx).toEqual({ command: "kindx", args: ["mcp"] });
  });

  test("jsoncTolerant: tolerates // line comments and trailing commas in input, but writes plain JSON", () => {
    const cfg = join(dir, "cursor-mcp.json");
    writeFileSync(cfg, `// header comment\n{\n  "mcpServers": { },\n}`);
    const a = createJsonAdapter({ name: "test", label: "Test", configPath: cfg, keyPath: ["mcpServers", "kindx"], jsoncTolerant: true });
    const r = a.write({ force: false, dryRun: false, command: "kindx", args: ["mcp"] });
    expect(r.outcome).toBe("updated");
    const parsed = JSON.parse(readFileSync(cfg, "utf-8")); // strict JSON
    expect(parsed.mcpServers.kindx).toEqual({ command: "kindx", args: ["mcp"] });
  });
});
```

Run: `npx vitest run specs/init-json-adapter.test.ts -v`
Expected: 7 failures (module does not exist).

- [ ] **Step 2: Implement `engine/init/json-adapter.ts`**

```ts
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, copyFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Adapter, DetectResult, WriteResult } from "./types.js";

export interface JsonAdapterConfig {
  name: string;
  label: string;
  configPath: string;
  keyPath: string[];      // e.g. ["mcpServers", "kindx"] or ["mcp","servers","kindx"]
  jsoncTolerant?: boolean; // strip // and trailing commas before parsing
}

function stripJsonc(text: string): string {
  // Strip // line comments outside strings, then trailing commas.
  let out = "";
  let i = 0;
  let inString = false;
  let stringChar = "";
  let escaped = false;
  while (i < text.length) {
    const c = text[i];
    if (inString) {
      out += c;
      if (escaped) { escaped = false; }
      else if (c === "\\") { escaped = true; }
      else if (c === stringChar) { inString = false; }
      i++;
    } else if (c === '"' || c === "'") {
      inString = true;
      stringChar = c;
      out += c;
      i++;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
    } else {
      out += c;
      i++;
    }
  }
  // Remove trailing commas before } or ]
  return out.replace(/,(\s*[}\]])/g, "$1");
}

function readConfig(path: string, jsoncTolerant?: boolean): any {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, "utf-8");
  if (!raw.trim()) return {};
  const parsed = jsoncTolerant ? JSON.parse(stripJsonc(raw)) : JSON.parse(raw);
  return parsed && typeof parsed === "object" ? parsed : {};
}

function getAtPath(obj: any, keyPath: string[]): any {
  let cur = obj;
  for (const k of keyPath) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = cur[k];
  }
  return cur;
}

function setAtPath(obj: any, keyPath: string[], value: any): void {
  let cur = obj;
  for (let i = 0; i < keyPath.length - 1; i++) {
    const k = keyPath[i];
    if (cur[k] == null || typeof cur[k] !== "object") cur[k] = {};
    cur = cur[k];
  }
  cur[keyPath[keyPath.length - 1]] = value;
}

function atomicWriteJson(path: string, value: any): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${Date.now()}.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  renameSync(tmp, path);
}

export function createJsonAdapter(cfg: JsonAdapterConfig): Adapter {
  return {
    name: cfg.name,
    label: cfg.label,
    detect(): DetectResult {
      const exists = existsSync(cfg.configPath);
      let alreadyWired = false;
      if (exists) {
        try {
          const parsed = readConfig(cfg.configPath, cfg.jsoncTolerant);
          alreadyWired = getAtPath(parsed, cfg.keyPath) != null;
        } catch { /* unreadable → treat as not wired */ }
      }
      return { configPath: cfg.configPath, exists, alreadyWired };
    },
    write(opts): WriteResult {
      const detected = this.detect();
      if (detected.alreadyWired && !opts.force) {
        return { configPath: cfg.configPath, outcome: "skipped", reason: "already wired (use --force to overwrite)" };
      }
      const parsed = readConfig(cfg.configPath, cfg.jsoncTolerant);
      setAtPath(parsed, cfg.keyPath, { command: opts.command, args: opts.args });

      if (opts.dryRun) {
        return { configPath: cfg.configPath, outcome: detected.exists ? "updated" : "created" };
      }

      let backupPath: string | undefined;
      if (detected.exists) {
        backupPath = `${cfg.configPath}.kindx.bak.${Date.now()}`;
        copyFileSync(cfg.configPath, backupPath);
      }
      atomicWriteJson(cfg.configPath, parsed);
      return { configPath: cfg.configPath, outcome: detected.exists ? "updated" : "created", backupPath };
    },
  };
}
```

- [ ] **Step 3: Run tests, verify they pass**

Run: `npx vitest run specs/init-json-adapter.test.ts -v`
Expected: 7 tests PASS.

- [ ] **Step 4: Commit**

```bash
git add engine/init/json-adapter.ts specs/init-json-adapter.test.ts
git commit -m "feat(init): createJsonAdapter — generic JSON/JSONC MCP config wirer

Handles arbitrary keyPaths (mcpServers.kindx, mcp.servers.kindx, etc.),
preserves unrelated keys, dry-run/force/idempotent, atomic writes with
.kindx.bak.<ts> backups, optional JSONC-tolerant parsing."
```

---

## Task 5: Implement `createTomlAdapter` (TDD)

**Files:**
- Create: `specs/init-toml-adapter.test.ts`
- Create: `engine/init/toml-adapter.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import TOML from "@iarna/toml";
import { createTomlAdapter } from "../engine/init/toml-adapter.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "kindx-toml-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("createTomlAdapter (Codex CLI)", () => {
  test("creates file with [mcp_servers.kindx] when missing", () => {
    const cfg = join(dir, "config.toml");
    const a = createTomlAdapter({ name: "codex", label: "Codex", configPath: cfg, key: "mcp_servers.kindx" });
    const r = a.write({ force: false, dryRun: false, command: "kindx", args: ["mcp"] });
    expect(r.outcome).toBe("created");
    const parsed: any = TOML.parse(readFileSync(cfg, "utf-8"));
    expect(parsed.mcp_servers.kindx).toEqual({ command: "kindx", args: ["mcp"] });
  });

  test("preserves unrelated keys in existing file", () => {
    const cfg = join(dir, "config.toml");
    writeFileSync(cfg, `model = "gpt-5"\n\n[mcp_servers.other]\ncommand = "x"\n`);
    const a = createTomlAdapter({ name: "codex", label: "Codex", configPath: cfg, key: "mcp_servers.kindx" });
    a.write({ force: false, dryRun: false, command: "kindx", args: ["mcp"] });
    const parsed: any = TOML.parse(readFileSync(cfg, "utf-8"));
    expect(parsed.model).toBe("gpt-5");
    expect(parsed.mcp_servers.other.command).toBe("x");
    expect(parsed.mcp_servers.kindx.command).toBe("kindx");
  });

  test("detect.alreadyWired true when entry exists", () => {
    const cfg = join(dir, "config.toml");
    writeFileSync(cfg, `[mcp_servers.kindx]\ncommand = "kindx"\nargs = ["mcp"]\n`);
    const a = createTomlAdapter({ name: "codex", label: "Codex", configPath: cfg, key: "mcp_servers.kindx" });
    expect(a.detect().alreadyWired).toBe(true);
  });
});
```

Run: `npx vitest run specs/init-toml-adapter.test.ts -v`
Expected: 3 failures (module does not exist).

- [ ] **Step 2: Implement `engine/init/toml-adapter.ts`**

```ts
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, copyFileSync } from "node:fs";
import { dirname } from "node:path";
import TOML from "@iarna/toml";
import type { Adapter, DetectResult, WriteResult } from "./types.js";

export interface TomlAdapterConfig {
  name: string;
  label: string;
  configPath: string;
  /** Dotted key path, e.g. "mcp_servers.kindx". */
  key: string;
}

function readToml(path: string): any {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, "utf-8");
  if (!raw.trim()) return {};
  return TOML.parse(raw);
}

function setDotted(obj: any, key: string, value: any): void {
  const parts = key.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur[parts[i]] == null || typeof cur[parts[i]] !== "object") cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

function getDotted(obj: any, key: string): any {
  return key.split(".").reduce((cur, k) => (cur == null ? undefined : cur[k]), obj);
}

function atomicWriteToml(path: string, value: any): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${Date.now()}.${process.pid}`;
  writeFileSync(tmp, TOML.stringify(value));
  renameSync(tmp, path);
}

export function createTomlAdapter(cfg: TomlAdapterConfig): Adapter {
  return {
    name: cfg.name,
    label: cfg.label,
    detect(): DetectResult {
      const exists = existsSync(cfg.configPath);
      let alreadyWired = false;
      if (exists) {
        try { alreadyWired = getDotted(readToml(cfg.configPath), cfg.key) != null; } catch { /* */ }
      }
      return { configPath: cfg.configPath, exists, alreadyWired };
    },
    write(opts): WriteResult {
      const detected = this.detect();
      if (detected.alreadyWired && !opts.force) {
        return { configPath: cfg.configPath, outcome: "skipped", reason: "already wired (use --force to overwrite)" };
      }
      const parsed = readToml(cfg.configPath);
      setDotted(parsed, cfg.key, { command: opts.command, args: opts.args });
      if (opts.dryRun) return { configPath: cfg.configPath, outcome: detected.exists ? "updated" : "created" };

      let backupPath: string | undefined;
      if (detected.exists) {
        backupPath = `${cfg.configPath}.kindx.bak.${Date.now()}`;
        copyFileSync(cfg.configPath, backupPath);
      }
      atomicWriteToml(cfg.configPath, parsed);
      return { configPath: cfg.configPath, outcome: detected.exists ? "updated" : "created", backupPath };
    },
  };
}
```

- [ ] **Step 3: Verify**

Run: `npx vitest run specs/init-toml-adapter.test.ts -v`
Expected: 3 PASS.

- [ ] **Step 4: Commit**

```bash
git add engine/init/toml-adapter.ts specs/init-toml-adapter.test.ts
git commit -m "feat(init): createTomlAdapter for Codex CLI config"
```

---

## Task 6: Register all client adapters

**Files:**
- Create: `engine/init/adapters.ts`

- [ ] **Step 1: Write the file**

```ts
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { createJsonAdapter } from "./json-adapter.js";
import { createTomlAdapter } from "./toml-adapter.js";
import type { Adapter } from "./types.js";

const HOME = homedir();
const isMac = platform() === "darwin";
const isWin = platform() === "win32";

function claudeDesktopPath(): string {
  if (isMac) return join(HOME, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  if (isWin) return join(process.env.APPDATA ?? join(HOME, "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
  return join(HOME, ".config", "Claude", "claude_desktop_config.json");
}

export const ALL_ADAPTERS: Adapter[] = [
  createJsonAdapter({
    name: "claude-code",
    label: "Claude Code",
    configPath: join(HOME, ".claude", "settings.json"),
    keyPath: ["mcpServers", "kindx"],
  }),
  createJsonAdapter({
    name: "claude-desktop",
    label: "Claude Desktop",
    configPath: claudeDesktopPath(),
    keyPath: ["mcpServers", "kindx"],
  }),
  createJsonAdapter({
    name: "cursor",
    label: "Cursor",
    configPath: join(HOME, ".cursor", "mcp.json"),
    keyPath: ["mcpServers", "kindx"],
    jsoncTolerant: true,
  }),
  createJsonAdapter({
    name: "continue",
    label: "Continue",
    configPath: join(HOME, ".continue", "config.json"),
    keyPath: ["mcpServers", "kindx"],
  }),
  createJsonAdapter({
    name: "opencode",
    label: "OpenCode",
    configPath: join(HOME, ".opencode", "config.json"),
    keyPath: ["mcp", "servers", "kindx"],
  }),
  createTomlAdapter({
    name: "codex",
    label: "Codex CLI",
    configPath: join(HOME, ".codex", "config.toml"),
    key: "mcp_servers.kindx",
  }),
  createJsonAdapter({
    name: "copilot",
    label: "Copilot CLI",
    configPath: join(HOME, ".copilot", "mcp.json"),
    keyPath: ["mcpServers", "kindx"],
  }),
  createJsonAdapter({
    name: "zed",
    label: "Zed",
    configPath: join(HOME, ".config", "zed", "settings.json"),
    keyPath: ["context_servers", "kindx"],
    jsoncTolerant: true,
  }),
];

export function adapterByName(name: string): Adapter | undefined {
  return ALL_ADAPTERS.find((a) => a.name === name);
}
```

- [ ] **Step 2: Commit**

```bash
git add engine/init/adapters.ts
git commit -m "feat(init): register the 8 supported MCP client adapters

Claude Code, Claude Desktop (mac/linux/windows paths), Cursor, Continue,
OpenCode, Codex CLI, Copilot CLI, Zed. Ollama has no native MCP — bridge
shim documented separately in capabilities/kindx/references/."
```

---

## Task 7: Render the project-file fenced block

**Files:**
- Create: `engine/init/render-project-block.ts`

- [ ] **Step 1: Write the file**

```ts
import { AUTO_INVOCATION_CONTRACT } from "../protocol.js";
// Phase A must export AUTO_INVOCATION_CONTRACT — if it's still file-local in
// protocol.ts, add an `export` to that constant.

export function renderProjectFenceBody(): string {
  return [
    "<!-- This block is managed by `kindx init` — edits inside the fence will be overwritten. -->",
    "",
    AUTO_INVOCATION_CONTRACT,
    "",
    "Tools available: `query`, `get`, `multi_get`, `status`, `memory_search`, `memory_put`.",
  ].join("\n");
}
```

- [ ] **Step 2: Ensure `AUTO_INVOCATION_CONTRACT` is exported from `engine/protocol.ts`**

Edit `engine/protocol.ts` and prepend `export ` to the `const AUTO_INVOCATION_CONTRACT = ...` declaration added in Phase A.

- [ ] **Step 3: Commit**

```bash
git add engine/init/render-project-block.ts engine/protocol.ts
git commit -m "feat(init): render-project-block reuses Phase A contract constant

Exports AUTO_INVOCATION_CONTRACT from engine/protocol.ts so the
fenced AGENTS.md/CLAUDE.md block mirrors what every MCP-aware
agent sees via initialize.instructions."
```

---

## Task 8: Orchestrator — `runInit(opts)`

**Files:**
- Create: `engine/init/index.ts`

- [ ] **Step 1: Write the file**

```ts
import { readFileSync, writeFileSync, existsSync, copyFileSync } from "node:fs";
import { resolve } from "node:path";
import { ALL_ADAPTERS, adapterByName } from "./adapters.js";
import { upsertFence } from "./fence.js";
import { renderProjectFenceBody } from "./render-project-block.js";
import type { Adapter, InitOptions, WriteResult } from "./types.js";

const PROJECT_FILE_PREFERENCE = ["AGENTS.md", "CLAUDE.md", ".cursorrules", "GEMINI.md"];
const FENCE_MARKER = "kindx:auto-invocation";

interface RunResult {
  clientResults: Array<WriteResult & { name: string; label: string }>;
  projectFile?: { path: string; outcome: "created" | "updated" | "skipped"; backupPath?: string };
}

function selectAdapters(clients: string[]): Adapter[] {
  if (clients.length === 0 || clients.includes("auto")) {
    return ALL_ADAPTERS.filter((a) => a.detect().exists);
  }
  if (clients.includes("all")) return ALL_ADAPTERS;
  const out: Adapter[] = [];
  for (const c of clients) {
    const a = adapterByName(c);
    if (a) out.push(a);
  }
  return out;
}

function pickProjectFile(projectPath: string): string {
  for (const name of PROJECT_FILE_PREFERENCE) {
    const candidate = resolve(projectPath, name);
    if (existsSync(candidate)) return candidate;
  }
  return resolve(projectPath, PROJECT_FILE_PREFERENCE[0]); // create AGENTS.md if none exist
}

function writeProjectFile(projectPath: string, opts: { force: boolean; dryRun: boolean }): RunResult["projectFile"] {
  const target = pickProjectFile(projectPath);
  const existed = existsSync(target);
  if (!existed && !opts.force) {
    return { path: target, outcome: "skipped" };
  }
  const before = existed ? readFileSync(target, "utf-8") : "";
  const after = upsertFence(before, FENCE_MARKER, renderProjectFenceBody(), 1);
  if (after === before) return { path: target, outcome: "skipped" };
  if (opts.dryRun) return { path: target, outcome: existed ? "updated" : "created" };

  let backupPath: string | undefined;
  if (existed) {
    backupPath = `${target}.kindx.bak.${Date.now()}`;
    copyFileSync(target, backupPath);
  }
  writeFileSync(target, after);
  return { path: target, outcome: existed ? "updated" : "created", backupPath };
}

export function runInit(opts: InitOptions): RunResult {
  const adapters = selectAdapters(opts.clients);
  const clientResults = adapters.map((a) => ({
    name: a.name,
    label: a.label,
    ...a.write({ force: opts.force, dryRun: opts.dryRun, command: "kindx", args: ["mcp"] }),
  }));
  const projectFile = opts.globalOnly
    ? undefined
    : writeProjectFile(opts.projectPath ?? process.cwd(), { force: opts.force, dryRun: opts.dryRun });
  return { clientResults, projectFile };
}
```

- [ ] **Step 2: Write integration test**

Create `specs/init-orchestrator.test.ts`:

```ts
import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

// We need to redirect HOME so adapters write into a tmpdir.
let originalHome: string | undefined;
let fakeHome: string;
let projectDir: string;

beforeEach(() => {
  originalHome = process.env.HOME;
  fakeHome = mkdtempSync(join(tmpdir(), "kindx-init-home-"));
  projectDir = mkdtempSync(join(tmpdir(), "kindx-init-proj-"));
  process.env.HOME = fakeHome;
});
afterEach(() => {
  process.env.HOME = originalHome;
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
});

describe("runInit orchestrator", () => {
  test("--client all wires every adapter and writes project file", async () => {
    // Re-import so adapters re-read HOME
    const { runInit } = await import("../engine/init/index.js?fresh=" + Date.now());
    const result = runInit({
      clients: ["all"], projectPath: projectDir, globalOnly: false, dryRun: false, force: true,
    });
    expect(result.clientResults.length).toBeGreaterThanOrEqual(8);
    for (const r of result.clientResults) {
      expect(existsSync(r.configPath)).toBe(true);
    }
    expect(result.projectFile?.outcome).toBe("created");
    const agents = readFileSync(join(projectDir, "AGENTS.md"), "utf-8");
    expect(agents).toContain("<!-- kindx:auto-invocation:start v=1 -->");
    expect(agents).toContain("auto-invocation contract");
  });

  test("--dry-run touches no disk", async () => {
    const { runInit } = await import("../engine/init/index.js?fresh=" + Date.now());
    runInit({ clients: ["all"], projectPath: projectDir, globalOnly: false, dryRun: true, force: true });
    expect(existsSync(join(fakeHome, ".claude", "settings.json"))).toBe(false);
    expect(existsSync(join(projectDir, "AGENTS.md"))).toBe(false);
  });

  test("re-running with same args produces no diff (idempotent)", async () => {
    writeFileSync(join(projectDir, "AGENTS.md"), "# Header\n");
    const { runInit } = await import("../engine/init/index.js?fresh=" + Date.now());
    runInit({ clients: ["claude-code"], projectPath: projectDir, globalOnly: false, dryRun: false, force: true });
    const once = readFileSync(join(projectDir, "AGENTS.md"), "utf-8");
    runInit({ clients: ["claude-code"], projectPath: projectDir, globalOnly: false, dryRun: false, force: true });
    const twice = readFileSync(join(projectDir, "AGENTS.md"), "utf-8");
    expect(twice).toBe(once);
  });

  test("--client auto only wires detected clients", async () => {
    // Seed only the Claude Code settings file
    mkdirSync(join(fakeHome, ".claude"), { recursive: true });
    writeFileSync(join(fakeHome, ".claude", "settings.json"), "{}");
    const { runInit } = await import("../engine/init/index.js?fresh=" + Date.now());
    const result = runInit({
      clients: ["auto"], projectPath: projectDir, globalOnly: false, dryRun: false, force: true,
    });
    const names = result.clientResults.map((r) => r.name);
    expect(names).toContain("claude-code");
    expect(names).not.toContain("cursor");
  });
});
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run specs/init-orchestrator.test.ts -v`
Expected: 4 PASS.

- [ ] **Step 4: Commit**

```bash
git add engine/init/index.ts specs/init-orchestrator.test.ts
git commit -m "feat(init): runInit orchestrator with auto/all client selection

Selects adapters (auto: detect-only, all: every adapter, named:
explicit list), writes each, then renders the fenced project block
into AGENTS.md/CLAUDE.md/.cursorrules. Idempotent across re-runs.
Backups + atomic writes. --dry-run shows outcomes without disk I/O."
```

---

## Task 9: Wire `case "init":` into the CLI dispatcher

**Files:**
- Modify: `engine/kindx.ts` — add `case "init":` near `case "mcp"` (~L4640)

- [ ] **Step 1: Add CLI flag registrations**

Find where the global flag spec is declared near the top of `kindx.ts` and add:

```ts
"client": { type: "string", multiple: true }, // --client claude-code --client cursor
"project": { type: "string" },                 // --project <path>
"global": { type: "boolean" },                 // --global (skip project file)
"dry-run": { type: "boolean" },                // --dry-run
"force": { type: "boolean" },                  // --force
```

- [ ] **Step 2: Add the dispatcher case**

Insert immediately before `case "mcp": {` in the switch statement (around line 4640):

```ts
case "init": {
  const { runInit } = await import("./init/index.js");
  const clients = (cli.values.client as string[] | undefined) ?? ["auto"];
  const result = runInit({
    clients,
    projectPath: (cli.values.project as string | undefined) ?? process.cwd(),
    globalOnly: Boolean(cli.values.global),
    dryRun: Boolean(cli.values["dry-run"]),
    force: Boolean(cli.values.force),
  });
  console.log("KINDX init summary");
  console.log("──────────────────────────────────────────────────");
  for (const r of result.clientResults) {
    const tag = r.outcome === "skipped" ? "skip" : r.outcome;
    console.log(`  [${tag.padEnd(7)}] ${r.label.padEnd(18)}  ${r.configPath}${r.reason ? "  — " + r.reason : ""}`);
  }
  if (result.projectFile) {
    console.log(`  [${result.projectFile.outcome.padEnd(7)}] Project AGENTS.md   ${result.projectFile.path}`);
  }
  process.exit(0);
}
```

- [ ] **Step 3: Smoke**

```bash
npm run build
node dist/kindx.js init --dry-run --client all --project /tmp
```
Expected: prints a summary table with `[created]` / `[updated]` / `[skip]` lines; no files written.

- [ ] **Step 4: Commit**

```bash
git add engine/kindx.ts
git commit -m "feat(cli): add 'kindx init' subcommand

Wires kindx into every detected (or explicitly named) MCP client
and drops a fenced auto-invocation block into project AGENTS.md/
CLAUDE.md/.cursorrules. Supports --client auto|all|<name>, --project,
--global, --dry-run, --force."
```

---

## Task 10: Docs — Ollama bridge guide + validation matrix template

**Files:**
- Create: `capabilities/kindx/references/ollama-bridge.md`
- Create: `docs/auto-invocation-validation.md`
- Modify: `capabilities/kindx/references/mcp-setup.md`

- [ ] **Step 1: Write the Ollama bridge guide**

`capabilities/kindx/references/ollama-bridge.md`:

```markdown
# KINDX + Ollama (bridge pattern)

Ollama does not speak MCP natively as of this writing. To use kindx auto-invocation with an Ollama-backed agent, run a small bridge that exposes kindx tools as Ollama functions.

## Quick start (manual)

1. Start kindx in HTTP mode: `kindx mcp --http --port 8181 --daemon`
2. Run an MCP→Ollama bridge (e.g. `mcp-ollama-bridge`, community projects). Point it at `http://localhost:8181/mcp`.
3. Configure your Ollama client to call the bridge's tool endpoint on every chat turn.

## Why no `kindx init --client ollama` yet

Ollama has no canonical MCP config file to write to. The bridge varies per setup. We'll add a first-class adapter when an Ollama-side standard emerges.
```

- [ ] **Step 2: Write the validation matrix template**

`docs/auto-invocation-validation.md`:

```markdown
# Auto-Invocation Validation Matrix

Refresh this file per release. For each client, run the scripted prompt below and record whether the agent auto-fires `query` without being asked to "search".

**Scripted prompt:** "What did I write about <topic that exists in your collections>?"

| Client | Version | Auto-fires `query`? | Notes |
|---|---|---|---|
| Claude Code | | | |
| Claude Desktop (macOS) | | | |
| Cursor | | | |
| Continue | | | |
| OpenCode | | | |
| Codex CLI | | | |
| Copilot CLI | | | |
| Zed | | | |
| Ollama (via bridge) | | | |

## How to add a row

1. Install kindx: `npm install -g @ambicuity/kindx`
2. Wire: `kindx init --client <name>`
3. Restart the client.
4. Run the scripted prompt without saying "search".
5. Record the outcome.
```

- [ ] **Step 3: Update mcp-setup.md to put `kindx init` first**

In `capabilities/kindx/references/mcp-setup.md`, replace the "Configure MCP Client" section heading with:

```markdown
## Configure MCP Client

**Recommended:** run `kindx init` once after install. It detects every supported MCP client on this machine and wires kindx in (and optionally appends a fenced auto-invocation block to your project's AGENTS.md/CLAUDE.md).

```bash
kindx init                    # auto-detect & wire all detected clients + current project
kindx init --client all       # wire every supported client
kindx init --client cursor    # wire just one
kindx init --dry-run          # preview without changes
```

If you prefer to wire manually, the per-client config snippets below still work.
```

(Keep the existing manual snippets below as fallback.)

- [ ] **Step 4: Commit**

```bash
git add capabilities/kindx/references/ollama-bridge.md capabilities/kindx/references/mcp-setup.md docs/auto-invocation-validation.md
git commit -m "docs: kindx init guide, Ollama bridge, validation matrix"
```

---

## Final verification

- [ ] **Step 1: Full suite**

```bash
npm test
```
Expected: green.

- [ ] **Step 2: End-to-end smoke against a real `~/.claude/settings.json`**

```bash
# Back up first!
cp ~/.claude/settings.json ~/.claude/settings.json.preinit
npm run build
node dist/kindx.js init --dry-run --client claude-code
node dist/kindx.js init --client claude-code
diff ~/.claude/settings.json.preinit ~/.claude/settings.json
```
Expected: diff shows `mcpServers.kindx` was added, nothing else changed.

Restart Claude Code, ask a question that should hit your notes without saying "search". Confirm auto-fire by watching the tool-use log.

- [ ] **Step 3: Open PR**

PR title: `feat(cli): 'kindx init' — auto-wire MCP server across clients`. Body links to the spec and to the validation matrix. Note the dependency on Phase A.

---

## Done conditions

- `kindx init --client all --dry-run` lists all 8 adapters.
- `kindx init --client claude-code` is idempotent across re-runs.
- Project AGENTS.md gains a single fenced kindx block; re-running doesn't duplicate it.
- `kindx init --force` overwrites + creates a `.kindx.bak.<ts>` backup.
- All adapter tests pass.
- Validation matrix template committed for future per-release record-keeping.
