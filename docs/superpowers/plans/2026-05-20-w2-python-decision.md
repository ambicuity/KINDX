# W2 — Python Integration Decision Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Declare and ship Option A from spec §6 — keep `python/kindx-langchain` as a thin adapter, label its scope honestly, no engineering investment.

**Architecture:** Add `PYTHON.md` at repo root that records the decision and its rationale. Add a one-line banner to the Python package README. Update the root README's Python section to point at `PYTHON.md`. No code changes.

**Tech Stack:** Markdown only.

**Prerequisite:** None. This plan is independent of W1/W3/W4 and the baseline.

---

### Task 1: Branch

**Files:**
- None modified.

- [ ] **Step 1: Create branch from main**

Run: `git checkout main && git pull && git checkout -b docs/python-integration-decision`
Expected: new branch created.

---

### Task 2: Write `PYTHON.md`

**Files:**
- Create: `PYTHON.md`

- [ ] **Step 1: Create the file with the decision text**

Write to `PYTHON.md`:

```markdown
# Python Integration

**Status:** Thin adapter. Not a supported Python product tier.
**Decision date:** 2026-05-20
**Spec reference:** docs/superpowers/specs/2026-05-20-kindx-strategic-refactor-program-design.md §6

## What ships

`python/kindx-langchain/` is a single-file LangChain retriever wrapper around the KINDX HTTP API. It exists for convenience in Python notebooks and small scripts. It is not a stable API surface.

## What does not ship

- No sync/async client beyond what the wrapper exposes.
- No retry/backoff, streaming `/query/stream` support, or structured-query helpers in this package.
- No PyPI release cadence beyond unit-test passing.

## How to integrate from Python

For anything beyond toy use, call the KINDX HTTP API directly:

- `POST /query` for structured retrieval (see root README, HTTP Endpoints).
- `POST /query/stream` for streaming results.
- Use any HTTP client (`httpx`, `requests`); request and response shapes are documented in `@ambicuity/kindx-schemas`.

## Why we chose this shape

The cost of maintaining a supported Python tier (typed sync+async client, streaming, PyPI release process, examples for multiple frameworks) is several weeks of focused work and a permanent maintenance commitment. Demand has not been measured. Until that data exists, the honest framing is "thin adapter, call HTTP directly for production."

If demand emerges, this decision is reversible by following spec §6 Option B (separate spec required).

## Reversal criteria

This decision should be re-opened when any of the following is true:
- Sustained external usage of the `kindx-langchain` PyPI package above an agreed threshold.
- Concrete user requests for Python features beyond the wrapper's surface.
- A KINDX-internal need for a Python integration tier.
```

- [ ] **Step 2: Verify file exists and is non-empty**

Run: `wc -l PYTHON.md`
Expected: line count > 30.

---

### Task 3: Add banner to Python package README

**Files:**
- Modify: `python/kindx-langchain/README.md`

- [ ] **Step 1: Read current README**

Run: `cat python/kindx-langchain/README.md | head -5`

- [ ] **Step 2: Prepend a banner above whatever's there**

Edit `python/kindx-langchain/README.md` so it begins with:

```markdown
> **Status: thin adapter.** This package is a LangChain retriever wrapper around the KINDX HTTP API. It is not a full Python product. For production integrations call the HTTP API directly. See [PYTHON.md](../../PYTHON.md) at the repo root for the full decision.

---

```

…followed by the original content unchanged.

- [ ] **Step 3: Verify the banner is the first line**

Run: `head -1 python/kindx-langchain/README.md`
Expected: starts with `> **Status: thin adapter.**`.

---

### Task 4: Update root README to point at `PYTHON.md`

**Files:**
- Modify: `README.md` (the Python Integration section).

- [ ] **Step 1: Find the section**

Run: `grep -n "^## Python Integration" README.md`
Expected: line number printed (currently ~542).

- [ ] **Step 2: Replace the section body**

Replace the body of the `## Python Integration` section with:

```markdown
## Python Integration

`python/kindx-langchain` is a thin LangChain retriever wrapper around the KINDX HTTP API. It is not a supported Python product tier — see [PYTHON.md](./PYTHON.md) for the policy and reversal criteria. For production integrations from Python, call the HTTP API directly.

```bash
python3 -m unittest discover -s python/kindx-langchain/tests -v
```

The package requires Python `>=3.10`. Its optional `langchain` extra installs `langchain-core>=0.3.0`.
```

(Preserve the surrounding sections — only the Python Integration block changes.)

- [ ] **Step 3: Verify the section still ends cleanly**

Run: `grep -n "^## " README.md | head -20`
Expected: section headings still in original order; no duplicates, no broken structure.

---

### Task 5: Run Python tests to confirm nothing functional changed

**Files:**
- None modified.

- [ ] **Step 1: Run the existing Python test discovery**

Run: `npm run test:python`
Expected: tests pass exactly as before.

---

### Task 6: Commit

**Files:**
- New: `PYTHON.md`
- Modified: `python/kindx-langchain/README.md`, `README.md`

- [ ] **Step 1: Stage the changes**

```bash
git add PYTHON.md python/kindx-langchain/README.md README.md
git status
```

Expected: exactly three files staged.

- [ ] **Step 2: Commit**

```bash
git commit -m "$(cat <<'EOF'
docs: declare Python integration as thin-adapter (W2 Option A)

Adds PYTHON.md recording the spec §6 decision: python/kindx-langchain
is a thin LangChain retriever wrapper, not a supported Python product
tier. Adds banner to the package README and updates the root README's
Python section to point at PYTHON.md. No code changes.

Spec: docs/superpowers/specs/2026-05-20-kindx-strategic-refactor-program-design.md

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

Expected: one commit on `docs/python-integration-decision`.

---

### Task 7: Open PR

**Files:**
- None modified.

- [ ] **Step 1: Push**

Run: `git push -u origin docs/python-integration-decision`

- [ ] **Step 2: Open PR**

```bash
gh pr create --title "docs: declare Python integration as thin-adapter" --body "$(cat <<'EOF'
## Summary
- Adds \`PYTHON.md\` recording the W2 Option A decision from the refactor program spec
- Adds a clear "thin adapter" banner to \`python/kindx-langchain/README.md\`
- Updates the root README's Python section to reference PYTHON.md
- No code changes; \`npm run test:python\` still green

## Test plan
- [ ] CI green
- [ ] Reviewer confirms PYTHON.md captures the policy and reversal criteria clearly
- [ ] Reviewer spot-checks the banner is the first content line of the Python README

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: PR URL printed.
