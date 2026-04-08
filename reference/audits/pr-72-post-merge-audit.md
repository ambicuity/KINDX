# Post-Merge Audit Decision Record: PR #72 (Issue #49)

Date: 2026-03-26 (local audit run)
Repository: `ambicuity/KINDX`
PR: https://github.com/ambicuity/KINDX/pull/72
Linked issue: https://github.com/ambicuity/KINDX/issues/49
Out-of-scope issue check: https://github.com/ambicuity/KINDX/issues/29

## Scope and objective
This audit validates merged PR #72 as a post-merge review event against issue #49 acceptance criteria, AI reviewer feedback relevance, and merge-time CI/review state.

## What changed in PR #72
Merged diff (single file): `specs/smoke-install.sh`

- Changed Bun preload path:
  - from `./engine/test-preload.ts` (missing file)
  - to `./engine/preloader.ts` (real file)
- Added `set -o pipefail` to the Bun test command pipeline so failures in `bun test` are not masked by `tail`.

Patch excerpt:

```diff
- "export PATH=$BUN_BIN:\$PATH; cd /opt/kindx && bun test --preload ./engine/test-preload.ts --timeout 30000 specs/store.test.ts 2>&1 | tail -10"
+ "set -o pipefail; export PATH=$BUN_BIN:\$PATH; cd /opt/kindx && bun test --preload ./engine/preloader.ts --timeout 30000 specs/store.test.ts 2>&1 | tail -10"
```

## Linkage and closure integrity
Evidence:
- `gh pr view 72 --json closingIssuesReferences,...` shows PR #72 closes issue #49.
- `gh issue view 49 --json state,closedAt,...` shows issue #49 is `CLOSED` at `2026-03-26T19:56:38Z`.
- `gh issue view 29 --json state,url` shows issue #29 remains `OPEN`.

Conclusion:
- PR/issue linkage is correct for #49.
- Issue #29 is unrelated to this merged PR and is correctly excluded.

## AI reviewer triage
### Gemini Code Assist
- Finding: pipeline exit code masking due to `bun test ... | tail -10` without `pipefail`.
- Relevance: `actionable/relevant`.
- Validation: reproduced locally.

### Copilot PR Reviewer
- Finding: same pipeline masking risk; suggested `pipefail` or `PIPESTATUS` handling.
- Relevance: `actionable/relevant`.
- Validation: reproduced locally.

### CodeRabbit
- Outcome: approved PR and reported no merge-blocking code issues after update.
- Relevance: `informational/no-op` for additional code changes in this PR state.

## Local execution evidence
### Failure propagation repro
Command shape used in audit:
- without `set -o pipefail`:
  - `bun test --preload ./engine/preloader.ts --timeout 30000 specs/store-does-not-exist.test.ts 2>&1 | tail -10`
  - observed shell result: `PIPE_EXIT:0`
- with `set -o pipefail`:
  - same command with `set -o pipefail` prefix
  - observed shell result: `PIPEFAIL_EXIT:1`

Interpretation:
- AI finding is real and reproducible on local execution.
- Merged fix in PR #72 addresses this failure-propagation risk.

### Targeted impacted tests
- `npx vitest run --reporter=verbose specs/store.test.ts`
- Result: pass (`1` file, `198` tests passed)

## CI and review state at merge
From `gh pr view 72 --json statusCheckRollup,reviewDecision,reviews,mergedAt`:

Successful checks at merge window include:
- `Node 22 Build, Test, and Pack` (CI)
- `Analyze (javascript-typescript)` (CodeQL analysis workflow)
- `CodeQL` status
- `Require Linked Issue`
- `Validate Conventional Commit Title`
- `Label PR by Size`
- `CodeRabbit` status context (`SUCCESS`)

Non-required/skipped in context:
- `Auto-Merge Dependabot PRs` skipped (expected for non-Dependabot PR)

Review status:
- PR review decision: `APPROVED`
- AI reviews present from Gemini, Copilot, and CodeRabbit
- GraphQL review threads: `2` threads, both `isOutdated: true` and `isResolved: false` (not outstanding blockers after code change)

## Acceptance criteria mapping (Issue #49)
1. `specs/smoke-install.sh` no longer references missing preload file.
- Status: PASS
- Evidence: PR diff removed `./engine/test-preload.ts`.

2. Preload helper path used by Bun smoke test matches real repo file.
- Status: PASS
- Evidence: script now references `./engine/preloader.ts`; file exists at `engine/preloader.ts`.

3. Chosen preload filename is consistent with repo references.
- Status: PASS
- Evidence: switched to existing canonical preloader file.

4. Additional robustness from AI findings verified.
- Status: PASS
- Evidence: local repro confirms `pipefail` change is behaviorally correct.

## Final verdict
PASS

PR #72 correctly resolves issue #49, AI actionable findings were relevant and validated on real local execution, and merge-time CI/review state was green with no remaining merge-blocking issues.
