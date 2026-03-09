# Contributing to KINDX

We'd love your help! KINDX is an on-device Knowledge Infrastructure engine for AI agents. Every contribution — whether it addresses a bug, improves retrieval precision, or advances documentation — directly strengthens the project. We appreciate your time and effort!

---

## 1. Local Development Setup

Let's get you up and running quickly.

### Prerequisites

- Node.js **22+**
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

We organize work into clear categories using issue labels:

- [`good first issue`](https://github.com/ambicuity/KINDX/labels/good%20first%20issue) — Small, scoped tasks perfect for your first contribution.
- [`help wanted`](https://github.com/ambicuity/KINDX/labels/help%20wanted) — Medium-complexity tasks. Don't hesitate to ask for guidance!
- **Architecture Proposals** — Thinking about structural changes to the core retrieval pipeline? We'd love to hear your ideas! Please [open an issue](https://github.com/ambicuity/KINDX/issues/new/choose) to discuss the approach before writing code to ensure we're aligned.

Feel free to comment `/assign` on any unassigned issue to let others know you're working on it.

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

We use **CodeRabbit**, an AI assistant, to help with initial code reviews. Think of it as an automated peer reviewer that helps catch quick issues or suggest improvements!

CodeRabbit might leave comments on your PR. You can converse directly with it by mentioning `@coderabbitai` if you want it to explain a suggestion or try a different approach. The AI is here to help, but human maintainers will be the ones making the final review and merge decisions.

---

## 5. Merging

We try to review and merge PRs as quickly as possible. Once:
1. All required CI checks are green
2. A maintainer approves the PR

We'll use squash-and-merge to keep the `main` history clean.

Dependabot updates for patch/minor versions might auto-merge when CI is green, to keep our dependencies fresh.

---

## 6. Reporting Issues & Security

If you find a bug or have a feature idea, please use our [Issue Templates](https://github.com/ambicuity/KINDX/issues/new/choose).

**Security vulnerabilities:** Please email `contact@riteshrana.engineer` directly rather than opening a public issue. See [SECURITY.md](./SECURITY.md) for details.

---

## Thank You!

When your PR is merged, we will happily add you to our [Contributors Hall of Fame](./CONTRIBUTORS.md). Thanks again for dedicating your time and energy to KINDX!
