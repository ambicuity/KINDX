# Pre-Program Baseline Capture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture frozen benchmark, LOC, and function-listing baselines under `tooling/artifacts/` so subsequent workstreams (W1–W4) can prove non-regression against fixed numbers.

**Architecture:** A single PR on a fresh branch that runs three benchmark scripts, snapshots LOC and the `engine/repository.ts` function listing, and commits the artifacts. No engine code changes.

**Tech Stack:** Node 20+, npm, existing `tsx`-based bench scripts (`tooling/benchmarks/section6_bench.ts`, `tooling/benchmark_release_regressions.ts`, `tooling/benchmark_warm_daemon.ts`), `wc`, `grep`.

**Note:** The `npm run bench:quality`, `bench:latency`, `bench:regressions` scripts in `package.json` reference `tooling/benchmarks/runner.ts`, which does not exist in the repo (verified 2026-05-20 via `git log --all --oneline -- tooling/benchmarks/runner.ts` returning empty). This plan uses the scripts that actually work and have producing artifacts: `bench:section6` (quality, judgment-based hit@K), `tooling/benchmark_release_regressions.ts` (regression detector), `tooling/benchmark_warm_daemon.ts` (warm latency). Fixing the missing runner is out of scope for this program.

---

### Task 1: Create the baseline branch

**Files:**
- None modified yet.

- [ ] **Step 1: Confirm you're at repo root and on a clean tree**

Run: `git status`
Expected: `nothing to commit, working tree clean` (or only known in-progress changes that are unrelated; if so, stash them).

- [ ] **Step 2: Create and switch to the baseline branch**

Run: `git checkout main && git pull && git checkout -b chore/pre-refactor-baseline`
Expected: switched to a new branch tracking nothing yet.

---

### Task 2: Ensure artifacts directory exists

**Files:**
- Create (if missing): `tooling/artifacts/.gitkeep`

- [ ] **Step 1: Check whether the directory exists**

Run: `ls tooling/artifacts/ 2>/dev/null || echo MISSING`
Expected: either a directory listing or `MISSING`.

- [ ] **Step 2: If missing, create it**

Run: `mkdir -p tooling/artifacts && touch tooling/artifacts/.gitkeep`
Expected: no output.

- [ ] **Step 3: Stage and commit only if .gitkeep was added**

```bash
if [ -f tooling/artifacts/.gitkeep ]; then
  git add tooling/artifacts/.gitkeep
  git commit -m "chore: ensure tooling/artifacts directory exists"
fi
```

Expected: a commit if the file was newly added; otherwise nothing.

---

### Task 3: Build before benchmarks

**Files:**
- None modified.

- [ ] **Step 1: Build the CLI**

Run: `npm run build`
Expected: success, `dist/kindx.js` exists and is executable.

- [ ] **Step 2: Verify dist artifact**

Run: `ls -l dist/kindx.js`
Expected: file exists with execute bit (`-rwxr-xr-x`).

---

### Task 4: Capture quality benchmark baseline

**Files:**
- Create: `tooling/artifacts/baseline-quality.log` and possibly `tooling/artifacts/baseline-quality-section6.json`

- [ ] **Step 1: Run the section6 quality benchmark**

Run: `npm run bench:section6 2>&1 | tee tooling/artifacts/baseline-quality.log`
Expected: bench completes; tail of log shows hit@3, hit@5, MRR by difficulty per BENCHMARKS.md §6.

- [ ] **Step 2: Locate any JSON artifact written by the run**

The section6 bench writes its own JSON output (see `tooling/benchmarks/section6-results.schema.json`). Find the most recent one:

```bash
LATEST=$(ls -t tooling/artifacts/*section6*.json 2>/dev/null | head -1)
if [ -n "$LATEST" ] && [ "$LATEST" != "tooling/artifacts/baseline-quality-section6.json" ]; then
  cp "$LATEST" tooling/artifacts/baseline-quality-section6.json
fi
```

If no JSON was written, the log itself is the baseline (see Step 3 below).

- [ ] **Step 3: Verify the log and/or JSON is non-empty**

Run: `wc -c tooling/artifacts/baseline-quality.log tooling/artifacts/baseline-quality-section6.json 2>/dev/null`
Expected: at least the log byte count > 0.

---

### Task 5: Capture regressions benchmark baseline

**Files:**
- Create: `tooling/artifacts/baseline-regressions.log`

- [ ] **Step 1: Run the release-regressions benchmark (standalone)**

Run: `tsx tooling/benchmark_release_regressions.ts 2>&1 | tee tooling/artifacts/baseline-regressions.log`
Expected: bench completes; tail shows pass/fail summary.

- [ ] **Step 2: Locate any JSON artifact**

```bash
LATEST=$(ls -t tooling/artifacts/*regression*.json 2>/dev/null | head -1)
if [ -n "$LATEST" ] && [ "$LATEST" != "tooling/artifacts/baseline-regressions.json" ]; then
  cp "$LATEST" tooling/artifacts/baseline-regressions.json
fi
```

- [ ] **Step 3: Verify**

Run: `wc -c tooling/artifacts/baseline-regressions.* 2>/dev/null`
Expected: at least the log byte count > 0.

---

### Task 6: Capture latency benchmark baseline

**Files:**
- Create: `tooling/artifacts/baseline-latency.log`

- [ ] **Step 1: Run the warm-daemon latency benchmark (standalone)**

Run: `tsx tooling/benchmark_warm_daemon.ts 2>&1 | tee tooling/artifacts/baseline-latency.log`
Expected: bench reports warm-daemon p50/p95/p99 numbers and writes `tooling/artifacts/warm-daemon-benchmark.json` (which already exists from a previous run; this one overwrites with the current baseline).

- [ ] **Step 2: Preserve the JSON artifact as a versioned baseline**

```bash
cp tooling/artifacts/warm-daemon-benchmark.json tooling/artifacts/baseline-latency-warm-daemon.json
```

- [ ] **Step 3: Verify**

Run: `wc -c tooling/artifacts/baseline-latency.* tooling/artifacts/baseline-latency-warm-daemon.json 2>/dev/null`
Expected: byte count > 0 for at least the log.

---

### Task 7: Snapshot engine LOC

**Files:**
- Create: `tooling/artifacts/baseline-loc.txt`

- [ ] **Step 1: Capture LOC for top-level engine files**

Run: `wc -l engine/*.ts | sort -nr > tooling/artifacts/baseline-loc.txt`
Expected: file lists every `.ts` in `engine/` with line counts, biggest first.

- [ ] **Step 2: Verify `repository.ts` shows ~5000 lines at the top**

Run: `head -3 tooling/artifacts/baseline-loc.txt`
Expected: `repository.ts` appears in the top three.

---

### Task 8: Snapshot the repository.ts public function listing

**Files:**
- Create: `tooling/artifacts/baseline-repository-functions.txt`

- [ ] **Step 1: Extract every exported symbol and top-level function**

Run:

```bash
grep -nE "^(export |class |function |async function )" engine/repository.ts \
  > tooling/artifacts/baseline-repository-functions.txt
```

Expected: file has ~80–100 lines.

- [ ] **Step 2: Verify count**

Run: `wc -l tooling/artifacts/baseline-repository-functions.txt`
Expected: line count between 80 and 120.

---

### Task 9: Snapshot `.git` size for W4 comparison

**Files:**
- Create: `tooling/artifacts/baseline-git-size.txt`

- [ ] **Step 1: Capture `.git` directory size**

Run: `du -sh .git > tooling/artifacts/baseline-git-size.txt`
Expected: file contains a single line like `1.4G  .git` (exact size depends on environment).

---

### Task 10: Commit all baselines as a single artifact set

**Files:**
- Modify: stage everything under `tooling/artifacts/baseline-*`.

- [ ] **Step 1: Stage baselines**

```bash
git add tooling/artifacts/baseline-quality.* \
        tooling/artifacts/baseline-quality-section6.json \
        tooling/artifacts/baseline-regressions.* \
        tooling/artifacts/baseline-latency.* \
        tooling/artifacts/baseline-latency-warm-daemon.json \
        tooling/artifacts/baseline-loc.txt \
        tooling/artifacts/baseline-repository-functions.txt \
        tooling/artifacts/baseline-git-size.txt 2>/dev/null
git add tooling/artifacts/baseline-*
```

- [ ] **Step 2: Confirm only baseline artifacts are staged**

Run: `git status`
Expected: only `tooling/artifacts/baseline-*` files staged; no engine changes.

- [ ] **Step 3: Commit**

```bash
git commit -m "$(cat <<'EOF'
chore: capture pre-refactor baseline

Frozen artifacts for W1–W4 non-regression comparison:
- bench:quality, bench:regressions, bench:latency outputs
- engine/*.ts line counts
- engine/repository.ts public function listing
- .git directory size (for W4 comparison)

Write-once. Do not overwrite during the refactor program.
EOF
)"
```

Expected: one commit.

---

### Task 11: Open PR

**Files:**
- None modified.

- [ ] **Step 1: Push branch**

Run: `git push -u origin chore/pre-refactor-baseline`
Expected: branch is pushed.

- [ ] **Step 2: Open PR**

Run:

```bash
gh pr create --title "chore: capture pre-refactor baseline" --body "$(cat <<'EOF'
## Summary
- Captures benchmark, LOC, and function-listing baselines under \`tooling/artifacts/\`
- Required by spec §4 (docs/superpowers/specs/2026-05-20-kindx-strategic-refactor-program-design.md)
- Write-once artifacts; do not overwrite during the refactor program

## Test plan
- [ ] CI green (only artifact files changed; no engine touched)
- [ ] Reviewer spot-checks one baseline file is non-empty

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: PR URL printed; merge once green.
