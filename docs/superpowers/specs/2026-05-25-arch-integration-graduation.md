# Arch Integration Graduation: experiments/ → engine/

**Date:** 2026-05-25  
**Status:** Proposed  
**Scope:** Move Arch integration from experimental staging to production engine path

---

## Background

The Arch integration was originally developed under `experiments/arch/` due to insufficient adoption data and uncertainty around the Python dependency requirement. Now that the integration surface is well-defined and the module boundaries are stable, we're graduating it to its proper location under `engine/integrations/arch/`.

---

## Integration Shape

### 1. File Placement

Move `experiments/arch/` → `engine/integrations/arch/`

This restores the original intended location and signals production readiness.

### 2. Modules

| Module | Responsibility |
|--------|---------------|
| `config.ts` | Configuration with env vars (`KINDX_ARCH_ENABLED`, `KINDX_ARCH_AUGMENT_ENABLED`, etc.) |
| `contracts.ts` | Type definitions (`ArchGraphJson`, `ArchNode`, `ArchLink`, `ArchHint`, `DistilledArchArtifact`) |
| `parser.ts` | Parses `graph.json` from Arch Python tool |
| `distill.ts` | Processes graph data into distilled artifacts |
| `augment.ts` | Selects relevant hints based on query overlap |
| `adapter.ts` | Main adapter orchestrating build + distill |
| `importer.ts` | Path resolution and manifest reading |
| `runner.ts` | Spawns Python process to run Arch pipeline |

### 3. Pipeline Wiring

Optional arch hint augmentation plugs into `engine/repository/retrieval/structured.ts` after RRF fusion + reranking. The augmentation step is gated behind `KINDX_ARCH_AUGMENT_ENABLED` and only fires when the integration is active.

### 4. CLI Integration

New subcommand: `kindx arch <status|build|import|refresh>`

- `status` — Show integration state and last build timestamp
- `build` — Run the Arch Python pipeline and produce artifacts
- `import` — Import artifacts from a pre-built location
- `refresh` — Re-import and re-distill without full rebuild

### 5. MCP Integration

New tools exposed via MCP:

- `arch_query` — Query distilled arch hints for a given search
- `arch_status` — Return integration status and metadata

Both tools are gated behind `KINDX_ENABLE_MAINTENANCE_TOOLS` to avoid cluttering default tool surfaces.

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `KINDX_ARCH_ENABLED` | `false` | Enable arch integration |
| `KINDX_ARCH_AUGMENT_ENABLED` | `false` | Enable query augmentation with arch hints |
| `KINDX_ARCH_AUTO_REFRESH_ON_UPDATE` | `false` | Auto-refresh artifacts on collection update |
| `KINDX_ARCH_PYTHON_BIN` | `python3` | Path to Python interpreter |
| `KINDX_ARCH_REPO_PATH` | `./tmp/arch` | Path to Arch repository |
| `KINDX_ARCH_ARTIFACT_DIR` | `~/.cache/kindx/arch` | Artifact storage directory |
| `KINDX_ARCH_COLLECTION` | `__arch` | Collection name for arch artifacts |
| `KINDX_ARCH_MIN_CONFIDENCE` | `INFERRED` | Minimum confidence level (`EXTRACTED`/`INFERRED`/`AMBIGUOUS`) |
| `KINDX_ARCH_MAX_HINTS` | `3` | Maximum hints per query |

---

## On-By-Default Decision

The integration remains **opt-in** (`KINDX_ARCH_ENABLED` defaults to `false`) for three reasons:

1. **Python dependency** — Requires the `arch` Python package, which not all environments have.
2. **Repository setup** — Requires a configured Arch repository at `KINDX_ARCH_REPO_PATH`.
3. **Adoption gap** — The original reason for moving to `experiments/` was lack of real-world usage data. We don't yet have enough signal to justify making this default-on.

Future versions may flip this default once adoption metrics justify it.

---

## Benchmark Plan

### New Track

`bench:arch` — Compares retrieval quality with and without arch hints enabled. Measures:

- Precision@10 and Recall@10 on a curated query set
- Latency overhead of the augmentation step
- Hint relevance scoring (manual annotation on a sample)

### Non-Regression

Existing tracks (`bench:quality`, `bench:regressions`) must continue to pass unchanged. The arch integration is additive and gated, so it cannot affect baseline behavior when disabled.

---

## Graduation Requirements

| Requirement | Status |
|-------------|--------|
| Spec describing integration shape | ✅ This document |
| Benchmark coverage (`bench:arch` track) | ✅ Planned |
| Single PR with all changes | ✅ Pending |

---

## Open Questions

1. Should `KINDX_ARCH_AUTO_REFRESH_ON_UPDATE` trigger on any collection change, or only on the source collection?
2. Is `INFERRED` the right default for `KINDX_ARCH_MIN_CONFIDENCE`, or should we be more conservative with `EXTRACTED`?
3. Do we need a `kindx arch doctor` diagnostic subcommand for troubleshooting setup issues?
