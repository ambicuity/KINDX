# Contributing to KINDX

We'd love your help! KINDX is an on-device Knowledge Infrastructure engine for AI agents. Every contribution — whether it addresses a bug, improves retrieval precision, or advances documentation — directly strengthens the project. We appreciate your time and effort!

---

## 1. Local Development Setup

Let's get you up and running quickly.

### Prerequisites

- Node.js **20+** (22 LTS recommended for local parity with CI)
- Git
- macOS: `brew install sqlite` (for `sqlite-vec` extension support)

### Setup Steps

```bash
# 1. Fork the repository on GitHub, then clone your fork
git clone https://github.com/<your-username>/KINDX.git
cd KINDX

# 2. Add the upstream remote
git remote add upstream https://github.com/ambicuity/KINDX.git

# 3. Install dependencies
npm install

# 4. Link for local development
npm link

# 5. Verify the test suite passes
npm test
```

### Key Source Files

If you're looking for where things live:

| File | Role |
|------|------|
| `engine/kindx.ts` | CLI entry point |
| `engine/repository.ts` | Core data access and Contextual Retrieval |
| `engine/inference.ts` | LLM abstraction layer (embed, rerank, expand) |
| `engine/catalogs.ts` | YAML collection configuration |
| `engine/renderer.ts` | Output formatting (JSON, CSV, XML, MD) |
| `engine/protocol.ts` | MCP server implementation |
| `engine/runtime.ts` | SQLite compatibility and extension layer |
| `specs/` | Test suite (vitest) |

---

## 2. Finding Something to Work On

We organize intake around contributor difficulty and professional issue types:

- [`good first issue`](https://github.com/ambicuity/KINDX/labels/good%20first%20issue) — Small, scoped tasks perfect for a first contribution.
- [`help wanted`](https://github.com/ambicuity/KINDX/labels/help%20wanted) — Contributor-ready work across our `Beginner`, `Intermediate`, and `Advanced` issue templates.
- **Bug, documentation, feature, performance, architecture, and epic templates** — Use the appropriate issue form when reporting a problem or proposing work.
- **Architecture Proposals** — Thinking about structural changes to the core retrieval pipeline? Please [open an issue](https://github.com/ambicuity/KINDX/issues/new/choose) before writing code so we can align on design first.

The contributor difficulty ladder is intentionally explicit:

- **Good First Issue** — A guided, low-risk change with a clear starting point and a small verification step.
- **Beginner Issue** — A task for contributors who can work more independently, read existing patterns, and make a small implementation decision.
- **Intermediate Issue** — A cross-file task that requires familiarity with KINDX's workflows and stronger technical judgment.
- **Advanced Issue** — High-context, higher-risk work that should be coordinated with a maintainer before coding begins.

Maintainers track more detailed `type/*`, `area/*`, `difficulty/*`, and `status/*` labels internally. See [.github/LABEL_TAXONOMY.md](./.github/LABEL_TAXONOMY.md) for the taxonomy that pairs with the redesigned templates.

If an issue is unassigned, feel free to comment `/assign` before you start. When you begin implementation, comment `/working` so the issue is marked as in progress. That helps us coordinate ownership, keep contributor-ready issues available, and avoid duplicate work.

### Useful Issue and Review Commands

- On issues:
  - `/assign` claims an unassigned issue for you
  - `/working` claims the issue for you if needed and marks it `status/in-progress`
  - `/unassign` removes you from the assignee list
  - `/done` removes you from the assignee list and clears `status/in-progress` when nobody else is assigned
  - `@coderabbitai plan` asks CodeRabbit to generate an implementation plan on the issue
- On pull requests:
  - `@coderabbitai review` requests an incremental review
  - `@coderabbitai full review` requests a full review from scratch
  - `@coderabbitai summary` refreshes the high-level PR summary

CodeRabbit issue enrichment and manual issue planning are explicitly enabled in [.coderabbit.yaml](./.coderabbit.yaml). GitHub coding agents can also be assigned directly from the issue sidebar when available for the repository.

---

## 3. Making Your Changes

Our development workflow follows standard GitHub Flow. Here is the recommended path for contributing:

### Branching

Create a dedicated feature branch for your work:

```bash
git checkout -b feat/add-domain-filter
```

Branch naming conventions are flexible, but typical prefixes like `feat/`, `fix/`, `docs/`, or `chore/` are appreciated!

### Writing Code

- Please try to keep your changes focused on the scope of the issue. Small, focused Pull Requests are much easier to review!
- Follow standard TypeScript conventions: strict mode is on, and explicit return types on exported functions are helpful.
- Before committing, verify things work locally:
  ```bash
  npm run build
  npm test
  ```

### Committing

We prefer atomic commits that describe exactly what changed. We loosely follow the [Conventional Commits](https://www.conventionalcommits.org/) format, which helps auto-generate release notes based on prefixes like `feat:`, `fix:`, or `docs:`.

### Opening a Pull Request

1. Push your branch: `git push origin your-branch-name`
2. Open the PR against `main` in the upstream repository.
3. Link the originating issue in your PR description (e.g., `Fixes #123`).

---

## 4. Pull Request Reviews and AI

We use **CodeRabbit** and **Gemini Code Assist** as advisory reviewers on pull requests. Think of them as automated peer reviewers that help catch quick issues, CI gaps, or maintainability concerns before human review.

- **CodeRabbit** is configured in `.coderabbit.yaml` and is tuned for KINDX's TypeScript engine, MCP surface, workflows, and training tooling.
- **Gemini Code Assist** is configured in `.gemini/config.yaml` and `.gemini/styleguide.md` so its feedback stays aligned with this repo's architecture and release flow.

These tools can comment and summarize, but human maintainers still make the final review and merge decisions.

CodeRabbit might leave comments on your PR. You can converse directly with it by mentioning `@coderabbitai` if you want it to explain a suggestion or try a different approach.

---

## 5. Merging

We try to review and merge PRs as quickly as possible. Once:
1. All required CI checks are green
2. A maintainer approves the PR

We'll use squash-and-merge to keep the `main` history clean.

Dependabot updates for patch/minor versions might auto-merge when CI is green, to keep our dependencies fresh.

---

## 6. Release Verification Note

KINDX publishes to npmjs. When validating a release, treat npmjs as the source of truth.

- Run `npm view @ambicuity/kindx version dist-tags --json` from this repo.
- If local output disagrees with release logs, check scoped registry config first:
  - `npm config get @ambicuity:registry`
  - It should resolve to `https://registry.npmjs.org/` in this repository context.

---

## 7. Reporting Issues & Security

If you find a bug or have a feature idea, please use our [Issue Templates](https://github.com/ambicuity/KINDX/issues/new/choose).

**Security vulnerabilities:** Please email `contact@riteshrana.engineer` directly rather than opening a public issue. See [SECURITY.md](./SECURITY.md) for details.

---

## Thank You!

When your PR is merged, we will happily add you to our [Contributors Hall of Fame](./CONTRIBUTORS.md). Thanks again for dedicating your time and energy to KINDX!

## Release Recovery: Publish From Existing Tag

If a GitHub release/tag exists but npm publish was skipped or failed, use the `Publish From Tag` workflow:

1. Open **Actions** -> **Publish From Tag** -> **Run workflow**
2. Set `tag` (for example `v1.1.0`)
3. Run once with `dry_run=true`, then run with `dry_run=false`

The workflow fails fast if that package version is already present on npm.
