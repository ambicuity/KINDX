# Contributing to KINDX — The KINDX Specification

Thank you for contributing to KINDX. This document is the authoritative contribution guide for the project. We treat it as a living specification — read it fully before writing a single line of code.

> **TL;DR Quick Start (3 steps):**
> 1. **Claim** an issue tagged [`good first issue`](https://github.com/ambicuity/KINDX/labels/good%20first%20issue) by commenting `/assign`
> 2. **Initialize** your local environment: `git clone` → `npm install` → `npm test` (all green)
> 3. **Ship** your change on a feature branch, then open a PR with `Fixes #<issue-number>` in the description
>
> Full specification below.

KINDX is an enterprise-grade, on-device Knowledge Infrastructure engine for AI agents. Every contribution — whether it addresses a defect, improves retrieval precision, extends protocol support, or advances documentation — directly strengthens the knowledge backbone available to autonomous AI systems.

---

## Table of Contents

1. [Ways to Contribute](#1-ways-to-contribute)
2. [The AI-Assisted Workflow](#2-the-ai-assisted-workflow)
3. [Local Development Setup](#3-local-development-setup)
4. [Full Contribution Lifecycle](#4-full-contribution-lifecycle)
5. [Project Architecture](#5-project-architecture)
6. [Branching and Commit Standards](#6-branching-and-commit-standards)
7. [Pull Request Checklist](#7-pull-request-checklist)
8. [Reporting Issues](#8-reporting-issues)
9. [Code Style](#9-code-style)
10. [Good First Issues](#10-good-first-issues)
11. [Bot Commands (Slash Commands)](#11-bot-commands-slash-commands)
12. [When Will My PR Be Merged](#12-when-will-my-pr-be-merged)
13. [Security and Signed Releases](#13-security-and-signed-releases)

---

## 1. Ways to Contribute

We organize work into clear contribution tiers:

- [`good first issue`](https://github.com/ambicuity/KINDX/labels/good%20first%20issue) — Small, scoped, and well-specified tasks. The recommended entry point for new contributors.
- [`help wanted`](https://github.com/ambicuity/KINDX/labels/help%20wanted) — Medium-complexity tasks with maintainer guidance available.
- [`architecture proposal`](https://github.com/ambicuity/KINDX/issues/new?template=architecture_proposal.yml) — Proposals for structural changes to the retrieval pipeline, data layer, or protocol. Always open a proposal before writing code for these.

**Non-code contributions:**
- **Defect reports** and **Feature Requests**: Use the [Issue Templates](https://github.com/ambicuity/KINDX/issues/new/choose).
- **Specification and Documentation**: Improve guides, fix technical inaccuracies, add agentic usage examples.

---

## 2. The AI-Assisted Workflow

KINDX is a solo-maintained project. We rely on **CodeRabbit** as our Lead Architect to scale review coverage and enforce specification compliance.

Follow this workflow precisely:

1. **Open an Issue**: Use the appropriate template from the [issue chooser](https://github.com/ambicuity/KINDX/issues/new/choose).
2. **Wait for Analysis**: CodeRabbit will scan the codebase and reply with a step-by-step Implementation Plan.
3. **Refine the Plan**: If the plan diverges from intent, reply with `@coderabbitai clarify <your question>`.
4. **Write the Code**: Implement the plan using your preferred editor or AI coding assistant.
5. **Open a PR**: Link the PR to the originating issue with `Fixes #123`.
6. **Auto-Title your PR**: Set the PR title to `@coderabbitai`. CodeRabbit will rename it to a valid Conventional Commit title.
7. **Specification Gate**: CodeRabbit cross-examines your implementation against its original plan before approval.

---

## 3. Local Development Setup

### Prerequisites

- Node.js **22+**
- Git
- macOS: `brew install sqlite` (for sqlite-vec extension support)

### Setup

```bash
# 1. Fork the repository on GitHub, then clone your fork
git clone https://github.com/<your-username>/KINDX.git
cd KINDX

# 2. Install dependencies
npm install

# 3. Link for local development
npm link

# 4. Verify the test suite is green
npm test
```

### Key Source Files

| File | Role | Editable |
|------|------|----------|
| `engine/kindx.ts` | CLI entry point (~3000 lines) | Yes |
| `engine/repository.ts` | Core data access and Contextual Retrieval | Yes |
| `engine/inference.ts` | LLM abstraction layer (embed, rerank, expand) | Yes |
| `engine/catalogs.ts` | YAML Knowledge Domain configuration | Yes |
| `engine/renderer.ts` | Output formatting (JSON, CSV, XML, MD) | Yes |
| `engine/protocol.ts` | MCP server implementation | Yes |
| `engine/runtime.ts` | SQLite compatibility and extension layer | Yes |
| `specs/` | Test suite (vitest) | Yes |
| `package.json` | Dependencies and build scripts | Yes |

---

## 4. Full Contribution Lifecycle

### Phase 1: Claiming the Issue

Comment on the issue with:

```
/assign
```

This assigns the issue to you and prevents duplicate effort. Do not begin implementation until assignment is confirmed.

### Phase 2: Git Hygiene and Local Setup

```bash
# Fork and clone
git clone https://github.com/<your-username>/KINDX.git
cd KINDX

# Register the upstream remote
git remote add upstream https://github.com/ambicuity/KINDX.git

# Create a dedicated feature branch
git checkout -b feat/add-domain-filter
```

Branch naming convention:

| Prefix | When to use |
|--------|-------------|
| `feat/` | New feature or capability |
| `fix/` | Defect correction |
| `docs/` | Documentation or specification changes only |
| `chore/` | Maintenance (dependency updates, CI config) |

### Phase 3: Development and Code Standards

```bash
# Verify the test suite is green before writing code
npm test

# Build to verify TypeScript compilation
npm run build
```

Stay strictly within the scope of the issue. Do **not** rename unrelated variables or make style changes in lines you did not author. Out-of-scope modifications are grounds for PR rejection.

### Phase 4: Conflict Prevention and Committing

```bash
# Sync and rebase onto upstream
git fetch upstream
git rebase upstream/main
```

Write atomic, logical commits following [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <short summary in imperative mood>

Types:
  feat     - new feature or capability
  fix      - defect correction
  docs     - documentation or specification changes
  test     - adding or correcting test coverage
  chore    - maintenance (deps, CI, tooling)
  refactor - code restructure that is neither fix nor feature
  perf     - measurable performance improvement
```

### Phase 5: Opening the Pull Request

1. Push your branch: `git push origin feat/add-domain-filter`
2. Open the PR against `main` in the upstream repository.
3. Fill out the PR description template in full.
4. Link the originating issue: `Fixes #123`

### Phase 6: Code Review and History Cleanup

After review rounds, clean up noisy WIP commits before final merge:

```bash
git rebase -i upstream/main
git push origin feat/add-domain-filter --force-with-lease
```

---

## 5. Project Architecture

```
KINDX/
+-- engine/
|   +-- kindx.ts            # CLI entry point
|   +-- repository.ts       # Core data access and Contextual Retrieval
|   +-- inference.ts        # LLM abstraction (embed, rerank, expand)
|   +-- catalogs.ts         # YAML Knowledge Domain configuration
|   +-- renderer.ts         # Structured output formatting (JSON, CSV, XML, MD)
|   +-- protocol.ts         # MCP server
|   +-- runtime.ts          # SQLite compatibility layer
|   +-- benchmarks.ts       # Reranker benchmarks
|   +-- preloader.ts        # Test preload setup
+-- specs/                  # Test suite (vitest)
+-- reference/              # Specification documentation
+-- tooling/                # Build and release scripts
+-- training/               # Model fine-tuning pipeline
+-- capabilities/           # Agent skill definitions
+-- media/                  # Static assets
+-- .github/                # CI/CD, issue templates, workflows
```

**Data flow:** Knowledge Domain config → Glob scan → Parse Knowledge Assets → Hash content → Store in SQLite (FTS5 + vector index)

---

## 6. Branching and Commit Standards

We use **GitHub Flow** (trunk-based development):
1. `main` is always in a deployable, green state.
2. All feature work happens in short-lived branches cut from `main`.
3. PRs are squash-merged to maintain a single atomic commit per contribution.

---

## 7. Pull Request Checklist

Confirm every item before opening a PR:

- [ ] I have commented `/assign` on the issue and have been officially assigned.
- [ ] I have registered `upstream` as a remote.
- [ ] I am working on a feature branch — not directly on `main`.
- [ ] I ran `git fetch upstream && git rebase upstream/main` before pushing.
- [ ] `npm run build` passes with zero errors.
- [ ] `npm test` passes with zero failures.
- [ ] My changes are scoped to the described problem — no unrelated modifications.
- [ ] Commit messages follow the Conventional Commits format.
- [ ] The PR is linked to the issue with `Fixes #<number>` in the description.
- [ ] The PR targets `main` in the **upstream** repository.
- [ ] I have updated relevant specification or documentation if applicable.

---

## 8. Reporting Issues

Use the structured issue templates:

- **[Bug Report](https://github.com/ambicuity/KINDX/issues/new?template=bug_report.yml)** — crashes, incorrect retrieval results, broken commands
- **[Feature Request](https://github.com/ambicuity/KINDX/issues/new?template=feature_request.yml)** — suggest a new capability or retrieval mode
- **[Architecture Proposal](https://github.com/ambicuity/KINDX/issues/new?template=architecture_proposal.yml)** — major structural changes to the pipeline or protocol

**Security vulnerabilities**: Email `contact@riteshrana.engineer` directly — **do not** open a public issue. See [SECURITY.md](./SECURITY.md).

---

## 9. Code Style

- **TypeScript**: Follow idiomatic TypeScript patterns. Strict mode is enforced. Explicit return types required on all exported functions.
- **Naming**: `camelCase` for variables and functions, `PascalCase` for types and interfaces.
- **Imports**: Use `.js` extension in relative imports (ESM requirement).
- **Comments**: Minimal and meaningful. Document non-obvious design decisions. No tutorial-style comments.
- **Tests**: Use vitest. Deterministic behavior. No live network calls in tests. No superficial assertions.

---

## 10. Good First Issues

New to KINDX? Start with:

- [`good first issue`](https://github.com/ambicuity/KINDX/labels/good%20first%20issue) — small, self-contained tasks with clear acceptance criteria
- [`help wanted`](https://github.com/ambicuity/KINDX/labels/help%20wanted) — medium-complexity tasks with maintainer guidance available
- [`documentation`](https://github.com/ambicuity/KINDX/labels/documentation) — specification and documentation improvements (no coding required)

---

## 11. Bot Commands (Slash Commands)

| Command | Effect |
|---------|--------|
| `/assign` or `.take` | Assigns the issue to you and marks it in-progress |
| `/working` | Signals active progress to the bot (resets the inactivity timer) |
| `/need help` | Pings the maintainer and adds a `help-needed` label |
| `/unassign` | Removes your assignment so another contributor can proceed |

### Issue Lifecycle

1. **Claim** — Comment `/assign` on any unassigned issue.
2. **Implement** — You have 7 days to open a PR. Comment `/working` if you need additional time.
3. **Blocked?** — Comment `/need help` and a maintainer will respond.
4. **Stepping away?** — Comment `/unassign` to release the issue gracefully.
5. **Inactivity** — After 7 days with no activity or `/working` signal, the bot will automatically unassign.

---

## 12. When Will My PR Be Merged

The maintainer (`@ambicuity`) merges PRs manually after full review.

### Merge Criteria — all of the following must be satisfied:

| Requirement | Required |
|------------|----------|
| All required CI checks are green | Yes |
| At least one maintainer approval (`@ambicuity`) | Yes |
| PR body contains `Fixes #N` / `Closes #N` | Yes |
| PR title follows Conventional Commits format | Yes |
| No merge conflicts with `main` | Yes |
| PR has been open >= 24 hours (except critical defects) | Yes |

### Hard Blockers — do NOT merge:

| Failing Check | Reason |
|---------------|--------|
| CI — Lint and Validate | Syntax errors or build failures break the tool for all users |
| Test Suite (vitest) | Failing tests indicate a known regression |
| CodeQL Security Scan | Security vulnerability in merged code |
| Trivy | Known dependency CVE at CRITICAL/HIGH severity |
| PR Title Check | Invalid commit message breaks the automated release pipeline |
| Linked Issue Enforcer | Every community PR must be tied to a tracked issue |
| Merge conflict | Cannot squash-merge a conflicted PR |

### Auto-Merge (Dependabot)

Dependabot patch and minor dependency updates are automatically approved and squash-merged once all CI checks pass. Major version bumps require explicit maintainer review.

---

## 13. Security and Signed Releases

KINDX enforces supply chain security standards. We use **Sigstore** (keyless OIDC signing) for all releases.

Every release is automatically packaged and cryptographically signed via the `release-please.yml` workflow. Contributors do not need to perform signing steps manually — the CI/CD pipeline handles the full signing and attestation workflow.

---

## Contributors

Every accepted contribution is recognized. When your PR is merged, a maintainer will add you to the [Contributors Hall of Fame](./CONTRIBUTORS.md).

---

*The KINDX Specification is maintained by [@ambicuity](https://github.com/ambicuity). Contributions that advance the quality, precision, and reach of on-device Knowledge Infrastructure are always welcome.*
