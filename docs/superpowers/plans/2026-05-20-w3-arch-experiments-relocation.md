# W3 — Arch Sidecar Relocation to `experiments/` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Execute spec §7 Option B — relocate `engine/integrations/arch/` to `experiments/arch/`, remove all `KINDX_ARCH_*` references from `engine/`, remove the `arch_query` and `arch_status` MCP tools, remove `arch:*` npm scripts, and clean up the README. Default if no adoption data justifies Option A.

**Architecture:** Mechanical relocation with surgical removals from `engine/kindx.ts` and `engine/protocol.ts`. The `experiments/` directory becomes a documented holding pen for code not built or tested by default. All four Arch test files in `specs/` are deleted (they covered the now-removed integration).

**Tech Stack:** TypeScript, Vitest, npm.

**Prerequisite:** §10 open question answered — no internal adoption data justifies Option A. Confirm before starting.

---

### Task 1: Confirm prerequisite and branch

**Files:**
- None.

- [ ] **Step 1: Confirm Option B was chosen**

Per spec §7.3: Option B is the default unless internal telemetry shows Arch hints measurably improve recall. If no such data exists, proceed. Otherwise switch to Option A and write a different plan.

- [ ] **Step 2: Create branch**

```bash
git checkout main && git pull && git checkout -b chore/arch-to-experiments
```

Expected: new branch.

---

### Task 2: Create the `experiments/` directory with policy

**Files:**
- Create: `experiments/README.md`

- [ ] **Step 1: Create the directory and README**

```bash
mkdir -p experiments
```

Write to `experiments/README.md`:

```markdown
# Experiments

Code in this directory is **not** part of the supported KINDX engine.

## Policy

- Not built by `npm run build`.
- Not tested by `npm test` or `npm run test:all`.
- Not included in the published npm package.
- Not referenced from `engine/` — there must be no import path crossing `engine/ → experiments/`.
- Allowed to break. Allowed to be removed without deprecation notice.

## Why this exists

Some integrations or features are useful to keep in the tree (so contributors can find them, history is preserved, partial work isn't lost) but not yet — or no longer — load-bearing. `experiments/` is the holding pen between "in engine" and "deleted entirely."

## How to graduate something out

To move code from `experiments/X` into the supported engine:

1. Write a spec describing the integration shape and on-by-default plan.
2. Add benchmark coverage proving non-regression and value (per BENCHMARKS.md).
3. Land the move and the supporting code in one PR.

To delete: just delete it. No deprecation cycle is required for `experiments/` code.

## Current contents

- `arch/` — sidecar that augmented retrieval with Arch artifacts. Relocated from `engine/integrations/arch/` on 2026-05-20 (spec §7 Option B). May be revived if adoption data appears.
```

- [ ] **Step 2: Verify**

Run: `cat experiments/README.md | head -5`
Expected: starts with `# Experiments`.

---

### Task 3: Move the Arch code to `experiments/arch/`

**Files:**
- Move: `engine/integrations/arch/` → `experiments/arch/`

- [ ] **Step 1: Move with `git mv` to preserve history**

```bash
git mv engine/integrations/arch experiments/arch
```

Expected: 8 files moved (`adapter.ts`, `augment.ts`, `config.ts`, `contracts.ts`, `distill.ts`, `importer.ts`, `parser.ts`, `runner.ts`).

- [ ] **Step 2: Verify**

Run: `ls experiments/arch/ && ls engine/integrations/ 2>&1`
Expected: 8 `.ts` files in `experiments/arch/`. `engine/integrations/` may now be empty.

- [ ] **Step 3: If `engine/integrations/` is empty, remove it**

```bash
[ -z "$(ls -A engine/integrations/ 2>/dev/null)" ] && rmdir engine/integrations
```

Expected: directory removed if empty.

---

### Task 4: Remove Arch references from `engine/kindx.ts`

**Files:**
- Modify: `engine/kindx.ts`

- [ ] **Step 1: Find all Arch references**

Run: `grep -n -i "arch" engine/kindx.ts`
Expected: per spec §7 evidence, references concentrate around lines 865–915 (helpers `ensureArchCollectionIndexed`, `runArchBuildOrRefresh`, `runArchImport`) plus the CLI command registration for `kindx arch <subcommand>`.

- [ ] **Step 2: Remove the helper functions**

Delete the following functions from `engine/kindx.ts`:
- `ensureArchCollectionIndexed` (starts ~line 865)
- `runArchBuildOrRefresh` (starts ~line 880)
- `runArchImport` (starts ~line 901)
- Any additional Arch helpers in the same region.

- [ ] **Step 3: Remove the CLI subcommand**

Find the CLI command handler that wires `kindx arch <status|build|import|refresh>`:

Run: `grep -n "\"arch\"\\|'arch'" engine/kindx.ts`

Remove the case-branch or registration block that handles the `arch` subcommand and its `status`/`build`/`import`/`refresh` sub-subcommands. Remove the associated help text.

- [ ] **Step 4: Build to find leftover references**

Run: `npm run build`
Expected: clean build. If errors, they identify missed deletions — remove the offending imports/references and re-run.

---

### Task 5: Remove Arch tools and references from `engine/protocol.ts`

**Files:**
- Modify: `engine/protocol.ts`

- [ ] **Step 1: Find Arch references**

Run: `grep -n "arch_query\|arch_status\|Arch\|integrations/arch" engine/protocol.ts`
Expected: matches around lines 147 (`"arch_query"` in some list), 724–725 (`"arch_status"`, `"arch_query"`), 1430+ (tool registration for `arch_status`), and the maintenance-tool gate near `KINDX_ENABLE_MAINTENANCE_TOOLS`.

- [ ] **Step 2: Remove the tool registrations**

Delete:
- The `arch_query` tool registration and its handler.
- The `arch_status` tool registration and its handler.
- Any imports of `getArchConfig`, `getArchStatus`, `buildAndDistillArch`, `resolveArchPaths`, `readDistilledManifest`, or anything else from `./integrations/arch/*` (these imports were dynamic via `await import(...)` but may be statically referenced too).
- The entries `"arch_status"` / `"arch_query"` in any whitelist/blocklist arrays.

- [ ] **Step 3: Remove from maintenance-tools list**

The README mentions: *Additional maintenance tools are registered only when `KINDX_ENABLE_MAINTENANCE_TOOLS` is set: status, arch_status, …*. Find and remove the arch entries from that registration list.

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: clean build.

---

### Task 6: Remove Arch env vars from any startup config code

**Files:**
- Modify (search-wide): any file referencing `KINDX_ARCH_`.

- [ ] **Step 1: Find leftover references**

Run: `grep -rn "KINDX_ARCH" engine/ tooling/ 2>/dev/null`
Expected: ideally nothing; if any remain, they must be removed.

- [ ] **Step 2: Remove or relocate any tool/utility that reads `KINDX_ARCH_*`**

If the only reads were inside `experiments/arch/` (post-move), no engine changes are needed. If a reader exists in `engine/` (e.g., in `engine/kindx.ts` help text or `tooling/`), delete that reader.

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: clean.

---

### Task 7: Remove Arch npm scripts and any `--enforce` wiring

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Remove `arch:*` scripts**

In `package.json`, delete:

```
"arch:status": "tsx engine/kindx.ts arch status",
"arch:refresh": "tsx engine/kindx.ts arch refresh",
```

- [ ] **Step 2: Validate JSON**

Run: `node -e "JSON.parse(require('fs').readFileSync('package.json','utf8')); console.log('ok')"`
Expected: `ok`.

---

### Task 8: Delete Arch spec tests

**Files:**
- Delete: `specs/arch-adapter.test.ts`, `specs/arch-augmentation.test.ts`, `specs/arch-cli.test.ts`, `specs/arch-importer.test.ts`

- [ ] **Step 1: Confirm these test files target only the relocated integration**

Run: `head -20 specs/arch-*.test.ts | grep -E "from|import" | head -20`
Expected: imports come from `engine/integrations/arch/*` (now relocated). They are not testing engine code that remains.

- [ ] **Step 2: Delete them**

```bash
git rm specs/arch-adapter.test.ts specs/arch-augmentation.test.ts specs/arch-cli.test.ts specs/arch-importer.test.ts
```

Expected: 4 files staged for deletion.

- [ ] **Step 3: Check `specs/structured-search.test.ts` for residual coupling**

Run: `grep -n -i "arch" specs/structured-search.test.ts`
Expected: if matches exist, decide per match whether to delete the test or remove the Arch-specific assertions. The non-Arch coverage MUST remain.

---

### Task 9: Update README to remove all `KINDX_ARCH_*` env var rows

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Find references**

Run: `grep -n "KINDX_ARCH\|arch_query\|arch_status\|integrations/arch\|Arch sidecar\|arch <" README.md`
Expected: rows in the env vars table (per README current text, ~lines 420–428), an MCP tools row, scripts table entries (`arch:status`, `arch:refresh`, `arch status`, `arch build`, `arch refresh`).

- [ ] **Step 2: Remove the env-var rows**

Delete every row whose first column starts with `KINDX_ARCH_`.

- [ ] **Step 3: Remove the CLI command row**

Delete the row `| `kindx arch <status|build|import|refresh>` | Run optional Arch sidecar integration commands. |` from the CLI commands table.

- [ ] **Step 4: Remove the npm scripts rows**

Delete `arch:status` and `arch:refresh` rows from the Available Scripts table.

- [ ] **Step 5: Remove the MCP tool row**

Delete `arch_query` from the MCP tools table.

- [ ] **Step 6: Update the maintenance tools sentence**

Replace text like:

> Additional maintenance tools are registered only when `KINDX_ENABLE_MAINTENANCE_TOOLS` is set: `status`, `arch_status`, `memory_stats`, `memory_history`, `memory_mark_accessed`, `memory_delete`, and `memory_bulk`.

with:

> Additional maintenance tools are registered only when `KINDX_ENABLE_MAINTENANCE_TOOLS` is set: `status`, `memory_stats`, `memory_history`, `memory_mark_accessed`, `memory_delete`, and `memory_bulk`.

- [ ] **Step 7: Verify nothing Arch-related remains**

Run: `grep -ni "arch" README.md | grep -v -i "architecture"`
Expected: no matches. (The word "architecture" is legitimately used and should remain.)

---

### Task 10: Add `CHANGELOG.md` entry

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Find the unreleased section**

Run: `head -30 CHANGELOG.md`

- [ ] **Step 2: Add an entry under the unreleased section**

Under the most recent `## [Unreleased]` (or create one if absent), add:

```markdown
### Changed
- Relocated Arch sidecar integration from `engine/integrations/arch/` to `experiments/arch/`. Removed `KINDX_ARCH_*` environment variables, the `arch` CLI subcommand, the `arch_query` and `arch_status` MCP tools, and the `arch:status` / `arch:refresh` npm scripts. The code remains in the tree under `experiments/` and may be revived if adoption data appears. See spec §7 Option B.
```

---

### Task 11: Run the full test surface

**Files:**
- None modified.

- [ ] **Step 1: Build**

Run: `npm run build`
Expected: success.

- [ ] **Step 2: Run root tests**

Run: `npm test`
Expected: all pass. The four deleted Arch test files no longer run; remaining 55 tests pass unchanged.

- [ ] **Step 3: Run package tests**

Run: `npm run test:packages`
Expected: pass.

- [ ] **Step 4: Run python tests**

Run: `npm run test:python`
Expected: pass.

- [ ] **Step 5: Run quality benchmark to confirm no retrieval regression**

Run: `npm run bench:quality`
Expected: pass. Compare against `tooling/artifacts/baseline-quality.*` from the baseline plan; numbers should be unchanged (Arch was opt-in and off by default in the baseline run, so no quality delta is expected).

---

### Task 12: Commit and open PR

**Files:**
- Many small modifications across `engine/`, `package.json`, `README.md`, `CHANGELOG.md`; 8 file moves; 4 deletions.

- [ ] **Step 1: Stage**

```bash
git status
git add -A
```

- [ ] **Step 2: Commit**

```bash
git commit -m "$(cat <<'EOF'
chore: relocate Arch sidecar to experiments/

Per spec §7 Option B: no on-by-default usage of the Arch integration,
so it moves to experiments/. Removes KINDX_ARCH_* env vars, the arch
CLI subcommand, arch_query and arch_status MCP tools, arch:* npm
scripts, and four Arch-only test files. Code remains in experiments/
with preserved history and may be revived if adoption data appears.

Spec: docs/superpowers/specs/2026-05-20-kindx-strategic-refactor-program-design.md

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 3: Push**

Run: `git push -u origin chore/arch-to-experiments`

- [ ] **Step 4: Open PR**

```bash
gh pr create --title "chore: relocate Arch sidecar to experiments/" --body "$(cat <<'EOF'
## Summary
- Moves \`engine/integrations/arch/\` to \`experiments/arch/\` (8 files, git history preserved)
- Adds \`experiments/README.md\` documenting the directory's policy
- Removes \`KINDX_ARCH_*\` env vars from README and any engine readers
- Removes \`arch\` CLI subcommand and helpers from \`engine/kindx.ts\`
- Removes \`arch_query\` and \`arch_status\` MCP tools from \`engine/protocol.ts\`
- Removes \`arch:status\` / \`arch:refresh\` npm scripts from \`package.json\`
- Removes 4 Arch-only test files from \`specs/\`
- Adds CHANGELOG entry

## Why
Spec §7 Option B: the integration ships with every flag default off. Optionality with no on-by-default path is dead weight that grows the test matrix and documentation surface. If adoption data appears later, we can graduate it back per \`experiments/README.md\`.

## Verification
- \`npm run build\` ✅
- \`npm test\` ✅
- \`npm run test:packages\` ✅
- \`npm run test:python\` ✅
- \`npm run bench:quality\` matches baseline (Arch was off in baseline)

## Test plan
- [ ] CI green
- [ ] Reviewer confirms \`grep -ni "arch" README.md | grep -v -i "architecture"\` is empty
- [ ] Reviewer confirms no engine code imports from \`experiments/arch/\`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

### Done Criteria (matches spec §7.4)

- Decision recorded in commit message and CHANGELOG.
- `engine/integrations/arch/` no longer exists; `experiments/arch/` does, with `git log --follow` working.
- `KINDX_ARCH_*` removed from README, `engine/`, and any tooling readers.
- `arch:status` and `arch:refresh` removed from `package.json`.
- `arch_query` and `arch_status` MCP tools removed from `engine/protocol.ts`.
- `npm test`, `npm run test:packages`, `npm run test:python`, `npm run bench:quality` all pass.
