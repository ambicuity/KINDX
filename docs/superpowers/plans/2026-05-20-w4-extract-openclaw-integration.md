# W4 — Extract `openclaw-integration` to Sibling Repo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the 1.2 GB `openclaw-integration/` sibling subtree from this repo, preserving its git history into a separate repository, and clean up references in `package.json` and the root README.

**Architecture:** Use `git filter-repo` (or `git subtree split` fallback) to produce a history-preserving sibling repo, push it, then delete the directory and its build/test wiring from this repo. Add a link from the root README.

**Tech Stack:** `git`, `git-filter-repo` (Python tool), `gh` CLI for repo creation, npm.

**Prerequisite:** Spec §10 open question answered — confirmed go-ahead from the `openclaw-integration/` upstream owner. Do NOT start until that is in writing.

---

### Task 1: Confirm prerequisite

**Files:**
- None.

- [ ] **Step 1: Confirm upstream owner has agreed in writing to the extraction**

Spec §10 lists this as the open question for W4. The plan should not start until the agreement is captured (e.g., GitHub issue, Slack thread). If not yet captured, STOP and ask the user.

- [ ] **Step 2: Confirm the destination repo name and org**

Suggested: `ambicuity/openclaw-kindx-integration` (or whatever the owner prefers).

Record the chosen full repo path here once decided:

```
DEST_REPO=ambicuity/openclaw-kindx-integration  # update if different
```

---

### Task 2: Install `git-filter-repo`

**Files:**
- None.

- [ ] **Step 1: Check whether `git-filter-repo` is installed**

Run: `git filter-repo --version 2>&1 | head -1`
Expected: either a version string or "command not found".

- [ ] **Step 2: Install if missing**

If missing:

```bash
pip3 install --user git-filter-repo
# OR on macOS with Homebrew:
brew install git-filter-repo
```

Verify: `git filter-repo --version`
Expected: version printed (any 2.x is fine).

---

### Task 3: Create a working clone for history extraction

**Files:**
- None in this repo. Work happens in `/tmp/kindx-clone-for-extraction`.

- [ ] **Step 1: Clone the current repo to a scratch location**

```bash
rm -rf /tmp/kindx-clone-for-extraction
git clone --no-local /Users/ritesh/Downloads/submission_folder/KINDX /tmp/kindx-clone-for-extraction
cd /tmp/kindx-clone-for-extraction
git checkout main
```

Expected: clone exists at `/tmp/kindx-clone-for-extraction` with full history.

- [ ] **Step 2: Confirm the directory exists in the clone**

Run: `ls /tmp/kindx-clone-for-extraction/openclaw-integration | head -5`
Expected: directory listing.

---

### Task 4: Filter history to just `openclaw-integration/`

**Files:**
- Rewrites history of `/tmp/kindx-clone-for-extraction` only.

- [ ] **Step 1: Run filter-repo**

```bash
cd /tmp/kindx-clone-for-extraction
git filter-repo --subdirectory-filter openclaw-integration
```

Expected: command rewrites history; the working tree now contains the contents of `openclaw-integration/` at the root.

- [ ] **Step 2: Verify the working tree**

Run: `ls /tmp/kindx-clone-for-extraction | head -10`
Expected: previously-nested files (e.g., `apps/`, `extensions/`, `Dockerfile`) are now at the root.

- [ ] **Step 3: Verify history is preserved**

Run: `git log --oneline --follow -- apps/ | head -5` (or any file you know existed)
Expected: commits listed; verify the chain includes commits from before the extraction.

- [ ] **Step 4: Verify three representative files have follow-able history**

Pick three files that existed in `openclaw-integration/` for some time. For each:

```bash
git log --follow --oneline <file> | head -5
```

Expected: each shows ≥ 2 historical commits.

---

### Task 5: Create destination repo and push

**Files:**
- Creates new remote repo.

- [ ] **Step 1: Create the empty destination repo on GitHub**

Run:

```bash
gh repo create "$DEST_REPO" --private --description "OpenClaw ↔ KINDX integration (extracted from KINDX repo on 2026-05-20)"
```

Or `--public` per the owner's preference.

Expected: `https://github.com/<DEST_REPO>` exists.

- [ ] **Step 2: Set the new remote and push**

```bash
cd /tmp/kindx-clone-for-extraction
git remote remove origin 2>/dev/null || true
git remote add origin "git@github.com:${DEST_REPO}.git"
git push -u origin main
```

Expected: push succeeds; the destination repo now contains the filtered history.

- [ ] **Step 3: Spot-check the destination repo via the web UI or `gh`**

Run: `gh repo view "$DEST_REPO" --web`
Expected: opens the repo; main branch shows the moved files.

---

### Task 6: Branch in the KINDX repo for removal

**Files:**
- None modified yet.

- [ ] **Step 1: Return to the KINDX repo and create a removal branch**

```bash
cd /Users/ritesh/Downloads/submission_folder/KINDX
git checkout main && git pull && git checkout -b chore/extract-openclaw-integration
```

Expected: new branch.

---

### Task 7: Remove the directory

**Files:**
- Delete: `openclaw-integration/` (1.2 GB).

- [ ] **Step 1: Confirm directory size before deletion**

Run: `du -sh openclaw-integration/`
Expected: ~1.2G (matches §8.1 of the spec).

- [ ] **Step 2: Remove the directory**

Run: `git rm -r openclaw-integration/`
Expected: many files staged for deletion (this will take a moment).

- [ ] **Step 3: Verify removal**

Run: `ls openclaw-integration 2>&1`
Expected: `ls: openclaw-integration: No such file or directory`.

---

### Task 8: Remove the integration test wiring from `package.json`

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Find the test:openclaw-integration script**

Run: `grep -n "openclaw-integration" package.json`
Expected: one line for `test:openclaw-integration`.

- [ ] **Step 2: Remove the script**

Edit `package.json` and delete the `"test:openclaw-integration"` script entry. The exact line to remove is:

```
"test:openclaw-integration": "pnpm --dir openclaw-integration exec vitest run --config vitest.unit.config.ts src/memory/kindx-manager.test.ts",
```

- [ ] **Step 3: Check whether `test:all` references it**

Run: `grep -n "test:openclaw\|openclaw" package.json`
Expected: no remaining references. (The current `test:all` does NOT reference it — verify.)

- [ ] **Step 4: Validate `package.json` is still valid JSON**

Run: `node -e "JSON.parse(require('fs').readFileSync('package.json','utf8')); console.log('ok')"`
Expected: `ok`.

---

### Task 9: Add reference in root README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Find an appropriate section**

The README currently has a "Project Structure" block referencing `openclaw-integration/`. Run:

Run: `grep -n "openclaw-integration" README.md`
Expected: one or two matches.

- [ ] **Step 2: Remove the reference from "Project Structure"**

Delete the line:

```
├── openclaw-integration/      # separate integration subtree
```

from the Project Structure block.

- [ ] **Step 3: Add an Integrations section**

If a `## Integrations` section already exists, add the bullet there. Otherwise add this section after `## Architecture` and before `## Prerequisites`:

```markdown
## Integrations

- **OpenClaw** — KINDX integration code lives in a separate repository: [openclaw-kindx-integration](https://github.com/ambicuity/openclaw-kindx-integration). It was extracted from this repo on 2026-05-20 to keep KINDX focused. The integration consumes KINDX's HTTP and MCP APIs as a peer; nothing in this repo depends on it.
```

(Update the URL if `DEST_REPO` differs.)

- [ ] **Step 4: Verify the README still renders cleanly**

Run: `head -200 README.md | tail -100`
Expected: sections in logical order, no orphaned references.

---

### Task 10: Run the full test suite

**Files:**
- None modified.

- [ ] **Step 1: Build**

Run: `npm run build`
Expected: success.

- [ ] **Step 2: Run root tests**

Run: `npm test`
Expected: all pass; no test depends on `openclaw-integration/`.

- [ ] **Step 3: Run package tests**

Run: `npm run test:packages`
Expected: pass.

- [ ] **Step 4: Run python tests**

Run: `npm run test:python`
Expected: pass.

- [ ] **Step 5: Confirm test:all script still works without the removed reference**

Run: `npm run test:all`
Expected: success — `test:openclaw-integration` no longer runs.

---

### Task 11: Verify `.git` reduction (deferred but acknowledged)

**Files:**
- None modified.

- [ ] **Step 1: Note current `.git` size**

Run: `du -sh .git`

- [ ] **Step 2: Document in the PR description**

The `.git` directory will not shrink until objects are garbage-collected. After merge, a separate maintenance task (`git gc --aggressive --prune=now`) by a maintainer will reclaim space. Do not run this destructively here.

Record both numbers in the PR description (current and baseline from `tooling/artifacts/baseline-git-size.txt`).

---

### Task 12: Commit and open PR

**Files:**
- Many deletions + 2 modifications.

- [ ] **Step 1: Stage**

```bash
git status
git add -A
```

Expected: a large number of deletions plus 2 modifications (`package.json`, `README.md`).

- [ ] **Step 2: Commit**

```bash
git commit -m "$(cat <<'EOF'
chore: extract openclaw-integration to sibling repo

Removes the 1.2 GB openclaw-integration/ subtree. Full git history
was preserved via git filter-repo and pushed to a sibling repo
(see PR description for URL). Removes test:openclaw-integration
from package.json and updates README.

Spec: docs/superpowers/specs/2026-05-20-kindx-strategic-refactor-program-design.md §8

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 3: Push**

Run: `git push -u origin chore/extract-openclaw-integration`

- [ ] **Step 4: Open PR**

```bash
gh pr create --title "chore: extract openclaw-integration to sibling repo" --body "$(cat <<'EOF'
## Summary
- Removes the 1.2 GB \`openclaw-integration/\` subtree from this repo
- Preserves full git history via \`git filter-repo --subdirectory-filter\` into a sibling repo
- Sibling repo: https://github.com/ambicuity/openclaw-kindx-integration (update if different)
- Removes \`test:openclaw-integration\` script from \`package.json\`
- Updates README: removes the directory from Project Structure; adds an Integrations section linking to the sibling repo

## Why
Spec §8: the directory is a vendored fork, not an integration. Every clone paid 1.2 GB; CI couples KINDX's release to OpenClaw's. Extraction unblocks future contributors and reduces clone time.

## Verification
- \`npm run build\` ✅
- \`npm test\` ✅
- \`npm run test:packages\` ✅
- \`npm run test:python\` ✅
- \`npm run test:all\` ✅ (no longer runs the removed integration target)
- History preservation: verified \`git log --follow\` on three representative files in the sibling repo

## Post-merge
A maintainer should run \`git gc --aggressive --prune=now\` on the canonical remote to reclaim object storage. Current \`.git\` size: see PR diff line in \`tooling/artifacts/baseline-git-size.txt\`.

## Test plan
- [ ] CI green
- [ ] Sibling repo accessible
- [ ] Reviewer spot-checks one historical file in the sibling repo shows pre-extraction commits

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: PR URL printed.

---

### Task 13: Coordinate the downstream change with OpenClaw

**Files:**
- None in this repo.

- [ ] **Step 1: Open a tracking issue in the sibling repo**

```bash
gh issue create -R "$DEST_REPO" --title "Bootstrap: replace KINDX-vendored copy with HTTP/MCP integration" --body "$(cat <<'EOF'
This repo was extracted from KINDX on 2026-05-20 with full history.

Going forward, this repo consumes KINDX as a peer via the HTTP and MCP APIs (\`@ambicuity/kindx-client\`), not by being co-vendored.

Next steps owned here, not in KINDX:
- [ ] Update build/CI to depend on the published KINDX package
- [ ] Replace any in-tree imports of internal KINDX modules with the client surface
- [ ] Document local-dev workflow against a KINDX HTTP server
EOF
)"
```

Expected: issue created in the sibling repo.

---

### Done Criteria (matches spec §8.5)

- `openclaw-integration/` directory removed from this repo.
- Sibling repo exists with preserved history; `git log --follow` works for ≥ 3 files.
- `npm run test:openclaw-integration` script and dependencies removed from root `package.json`.
- `npm run test:all` no longer references it.
- Root README links to the sibling repo under an Integrations section.
- `du -sh .git` reduction will follow on remote `gc`; documented in PR.
