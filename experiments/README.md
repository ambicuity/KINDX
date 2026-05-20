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
