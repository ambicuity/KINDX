# Contributing to KINDX

First off -- thank you for taking the time to contribute.

> **TL;DR Quick Start (3 steps):**
> 1. **Find** an issue tagged [`good first issue`](https://github.com/ambicuity/KINDX/labels/good%20first%20issue) and comment `/assign`
> 2. **Setup** your local environment: `git clone` -> `npm install` -> `npm test` (all green)
> 3. **Ship** your change on a branch, then open a PR with `Fixes #<issue-number>` in the description
>
> Full details in the sections below.

KINDX is an on-device document search engine that helps developers and knowledge workers find information across their markdown files, meeting notes, and documentation. Every contribution -- whether it is fixing a bug, improving search quality, adding a feature, or improving docs -- directly helps users find what they need faster.

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

We organize work into clear tiers:

- [`good first issue`](https://github.com/ambicuity/KINDX/labels/good%20first%20issue) -- Small, scoped, and well-defined tasks. Great for your first PR.
- [`help wanted`](https://github.com/ambicuity/KINDX/labels/help%20wanted) -- Medium complexity tasks where maintainer support is available.
- [`architecture proposal`](https://github.com/ambicuity/KINDX/issues/new?template=architecture_proposal.yml) -- For proposing major structural changes. Discuss these before writing code.

**Non-coding contributions:**
- **Bug report** or **Feature request**: Use our [Issue Templates](https://github.com/ambicuity/KINDX/issues/new/choose).
- **Documentation**: Improve guides, fix typos, add examples.

---

## 2. The AI-Assisted Workflow

We are a solo-maintained repository, which means we rely on AI to help manage contributions. We use **CodeRabbit** as our Lead Architect.

To write code for this repository, follow this exact workflow:

1. **Open an Issue**: Use the appropriate template from the [issue chooser](https://github.com/ambicuity/KINDX/issues/new/choose).
2. **Wait for Analysis**: CodeRabbit will scan the codebase and reply with a step-by-step Implementation Plan.
3. **Refine the Plan**: If the plan looks wrong, reply with `@coderabbitai clarify <your question>`.
4. **Write the Code**: Follow the plan using your preferred editor or AI coding assistant.
5. **Open a PR**: You **must** link the PR to the issue (`Fixes #123`).
6. **Auto-Title your PR**: Set the title to `@coderabbitai`. CodeRabbit will rename it to a correct Conventional Commit title.
7. **The Gatekeeper**: CodeRabbit will cross-examine your code against its original plan.

---

## 3. Local Development Setup

### Prerequisites

- Node.js **22+**
- Git
- macOS: `brew install sqlite` (for sqlite-vec extension support)

### Setup

```bash
# 1. Fork the repo on GitHub, then clone YOUR fork
git clone https://github.com/<your-username>/KINDX.git
cd KINDX

# 2. Install dependencies
npm install

# 3. Link for local development
npm link

# 4. Run the test suite
npm test
```

### Key Local Files

| File | Role | Edit? |
|------|------|-------|
| `engine/kindx.ts` | CLI entry point (~3000 lines) | Yes |
| `engine/repository.ts` | Core data access and search | Yes |
| `engine/inference.ts` | LLM abstraction layer | Yes |
| `engine/catalogs.ts` | YAML collection configuration | Yes |
| `engine/renderer.ts` | Output formatting | Yes |
| `engine/protocol.ts` | MCP server | Yes |
| `engine/runtime.ts` | SQLite compatibility layer | Yes |
| `specs/` | Test suite (vitest) | Yes |
| `package.json` | Dependencies and scripts | Yes |

---

## 4. Full Contribution Lifecycle

### Phase 1: Claiming the Issue

Comment on the issue with the bot command:

```
/assign
```

This assigns the issue to you. Do not start work until you are assigned -- it prevents duplicate effort.

### Phase 2: Git Hygiene and Local Setup

```bash
# Fork and clone
git clone https://github.com/<your-username>/KINDX.git
cd KINDX

# Add the upstream remote
git remote add upstream https://github.com/ambicuity/KINDX.git

# Create a dedicated feature branch
git checkout -b feat/add-collection-filter
```

Branch naming convention:

| Prefix | When to use |
|--------|-------------|
| `feat/` | New feature |
| `fix/` | Bug fix |
| `docs/` | Documentation only |
| `chore/` | Maintenance (deps, CI config, etc.) |

### Phase 3: Development and Code Standards

```bash
# Confirm the test suite is green before writing code
npm test

# Build to verify TypeScript compiles
npm run build
```

Stay strictly within the scope of the issue. Do **not** rename unrelated variables or fix style issues in lines you did not author.

### Phase 4: Conflict Prevention and Committing

```bash
# Fetch and rebase onto upstream
git fetch upstream
git rebase upstream/main
```

Write atomic, logical commits following [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <short summary in imperative mood>

Types:
  feat     - new feature
  fix      - bug fix
  docs     - documentation only
  test     - adding missing tests
  chore    - maintenance (deps, CI config, etc.)
  refactor - code change that is neither a fix nor a feature
  perf     - performance improvement
```

### Phase 5: Opening the Pull Request

1. Push your branch to your fork: `git push origin feat/add-collection-filter`
2. Open the PR against `main` in the upstream repository.
3. Fill out the PR description template completely.
4. Link the issue: `Fixes #123`

### Phase 6: Code Review and History Cleanup

After review rounds, clean up noisy commits:

```bash
git rebase -i upstream/main
git push origin feat/add-collection-filter --force-with-lease
```

---

## 5. Project Architecture

```
KINDX/
+-- engine/
|   +-- kindx.ts            # CLI entry point
|   +-- repository.ts       # Core data access and retrieval
|   +-- inference.ts        # LLM abstraction (embed, rerank, expand)
|   +-- catalogs.ts         # YAML collection configuration
|   +-- renderer.ts         # Output formatting (JSON, CSV, XML, MD)
|   +-- protocol.ts         # MCP server
|   +-- runtime.ts          # SQLite compatibility layer
|   +-- benchmarks.ts       # Reranker benchmarks
|   +-- preloader.ts        # Test preload setup
+-- specs/                  # Test suite (vitest)
+-- reference/              # Documentation
+-- tooling/                # Build and release scripts
+-- training/               # Model fine-tuning pipeline
+-- capabilities/           # Agent skill definitions
+-- media/                  # Static assets
+-- .github/                # CI/CD, templates, workflows
```

**Data flow:** Collection YAML -> Glob scan -> Parse markdown -> Hash content -> Store in SQLite (FTS5 + vector index)

---

## 6. Branching and Commit Standards

We use **GitHub Flow** (trunk-based development):
1. `main` is always deployable and green.
2. All feature work happens in short-lived branches created from `main`.
3. PRs are squash-merged to maintain a single atomic commit per feature.

---

## 7. Pull Request Checklist

Before opening a PR, confirm every item below:

- [ ] I have commented `/assign` on the issue and have been officially assigned.
- [ ] I have added `upstream` as a remote.
- [ ] I am working on a feature branch -- not on `main`.
- [ ] I ran `git fetch upstream && git rebase upstream/main` before pushing.
- [ ] `npm run build` passes with no errors.
- [ ] `npm test` passes with no failures.
- [ ] My changes are scoped to the described problem -- no unrelated modifications.
- [ ] Commit messages follow the Conventional Commits format.
- [ ] The PR is linked to the issue with `Fixes #<number>` in the description.
- [ ] The PR is opened against `main` in the **upstream** repository.
- [ ] I have updated relevant documentation if applicable.

---

## 8. Reporting Issues

Use the structured issue templates:

- **[Bug Report](https://github.com/ambicuity/KINDX/issues/new?template=bug_report.yml)** -- crashes, incorrect search results, broken commands
- **[Feature Request](https://github.com/ambicuity/KINDX/issues/new?template=feature_request.yml)** -- suggest an improvement
- **[Architecture Proposal](https://github.com/ambicuity/KINDX/issues/new?template=architecture_proposal.yml)** -- major structural changes

**Security issues**: Please email `contact@riteshrana.engineer` -- **do not** open a public issue. See [SECURITY.md](./SECURITY.md).

---

## 9. Code Style

- **TypeScript**: Follow idiomatic TypeScript patterns. Use strict mode. Explicit return types on exported functions.
- **Naming**: camelCase for variables and functions, PascalCase for types and interfaces.
- **Imports**: Use `.js` extension in relative imports (ESM requirement).
- **Comments**: Minimal but meaningful. Document non-obvious decisions. No tutorial-style comments.
- **Tests**: Use vitest. Deterministic behavior. No live network calls in tests.

---

## 10. Good First Issues

New here? Look for issues tagged:

- [`good first issue`](https://github.com/ambicuity/KINDX/labels/good%20first%20issue) -- small, self-contained tasks
- [`help wanted`](https://github.com/ambicuity/KINDX/labels/help%20wanted) -- medium tasks where maintainer support is available
- [`documentation`](https://github.com/ambicuity/KINDX/labels/documentation) -- docs improvements (no coding required)

---

## 11. Bot Commands (Slash Commands)

| Command | What it does |
|---------|-------------|
| `/assign` or `.take` | Assigns the issue to you and marks it as in-progress |
| `/working` | Tells the bot you are still actively working (resets inactivity timer) |
| `/need help` | Pings the maintainer and adds a `help-needed` label |
| `/unassign` | Removes yourself from the issue so someone else can pick it up |

### Lifecycle

1. **Claim an issue** -- Comment `/assign` on any unassigned issue.
2. **Work on it** -- You have 7 days to open a PR. Comment `/working` if you need more time.
3. **Stuck?** -- Comment `/need help` and a maintainer will assist you.
4. **Life happens?** -- Comment `/unassign` to gracefully step away. No hard feelings.
5. **Went silent?** -- After 7 days with no response, the bot will gently unassign you.

---

## 12. When Will My PR Be Merged

The maintainer (`@ambicuity`) merges PRs manually after reviewing.

### Ready to Merge -- all of the following must be true:

| Check | Required? |
|-------|-----------|
| All required CI checks are green | Yes |
| At least one maintainer approval (`@ambicuity`) | Yes |
| PR body contains `Fixes #N` / `Closes #N` | Yes |
| PR title follows Conventional Commits format | Yes |
| No merge conflicts with `main` | Yes |
| PR has been open >= 24 hours (except trivial fixes) | Yes |

### Hard Blockers -- Do NOT merge:

| Failing Check | Why It Blocks |
|---------------|--------------|
| CI -- Lint and Validate | Syntax errors or broken builds will break the tool |
| Test Suite (vitest) | Failing tests = known regression |
| CodeQL Security Scan | Security vulnerability in merged code |
| Trivy | Known dependency CVE at CRITICAL/HIGH severity |
| PR Title Check | PR cannot be auto-merged without a clean commit message |
| Linked Issue Enforcer | Every community PR must be tied to a tracked issue |
| Merge conflict | Cannot squash-merge a conflicted PR |

### Auto-Merge (Dependabot)

Dependabot patch and minor updates are automatically approved and squash-merged once all CI checks pass Dependabot. Major version bumps require explicit maintainer review.

---

## 13. Security and Signed Releases

KINDX takes supply chain security seriously. We use **Sigstore** (keyless OIDC signing) for signed releases.

Every release is automatically packaged and cryptographically signed via the `release-please.yml` workflow. If you are just contributing code, you do not need to do anything -- the automation handles signing.

---

## Contributors

Every contribution is recognized. When your PR is merged, a maintainer will add you to our [Contributors Hall of Fame](./CONTRIBUTORS.md).

---

Thank you for helping build better tools for knowledge workers. Every contribution matters.
