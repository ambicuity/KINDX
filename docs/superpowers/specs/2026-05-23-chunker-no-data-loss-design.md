# Chunker — eliminate silent data loss on token overshoot

**Status:** approved
**Author:** Claude (audit-driven)
**Date:** 2026-05-23
**Scope:** `engine/repository/chunking.ts`

## Problem

Ingestion is silently dropping document content. During a 5342-document
ingest run, the operator observed hundreds of warnings of the form:

```
KINDX Warning: sub-chunk at pos=977 (tokens≈961) exceeds maxTokens=900,
skipping to prevent model overflow.
```

Every such warning corresponds to a region of a document that was
**chunked, measured, found over the token budget, and then discarded** —
never embedded, never indexed, never searchable. The user has no way to
know which content is missing from the index without diffing.

The overshoots in the observed run are tightly clustered just above the
limit (901–1136 tokens against a `maxTokens=900` ceiling — 0.1%–26% over),
which rules out runaway documents. It is a systematic miscalibration in
the re-chunk pass.

## Root cause

`chunkDocumentByTokens` (`engine/repository/chunking.ts`) plans chunks by
character budget, then validates with the real tokenizer. When a planned
chunk overshoots, it re-chunks using an **average** chars-per-token derived
from the whole oversized chunk:

```ts
const actualCharsPerToken = chunk.text.length / tokensLength;        // average
const safeMaxChars = Math.floor(maxTokens * actualCharsPerToken * 0.95); // only 5% headroom
```

Token density is not uniform inside a document. A chunk whose front is
prose (~4 chars/tok) but whose tail contains dense code, a wide table, or
CJK text (~2 chars/tok) has a chunk-mean that hides the worst-case region.
The 5% margin gets eaten and the sub-chunk overshoots by a few percent.

The current code then takes the worst possible action:

```ts
} else {
  process.stderr.write(`KINDX Warning: sub-chunk at pos=... skipping ...\n`);
}
```

The sub-chunk is dropped. The contract `"every byte of every input
document is represented in at least one indexed chunk"` is violated.

## Goals

1. **No silent data loss.** Every byte of input must end up in some
   emitted chunk's text, with that chunk's measured token count `≤ maxTokens`.
2. **Bounded termination.** The fix must converge in at most a small,
   bounded number of tokenizer calls per overshoot, regardless of input.
3. **No regression to chunk quality on the happy path.** Documents that
   chunk cleanly today must continue to chunk cleanly, with the same
   smart-break behavior.
4. **No silent loss of tokenizer errors either.** If the tokenizer
   throws, behavior must remain conservative (over-chunk, not over-emit).

## Non-goals

- Token-perfect cutting (detokenize-based offset mapping). The tokenizer
  interface returns opaque tokens with no char-offset map. Future work.
- Break-point quality inside the force-split path. The fallback may cut
  mid-sentence; correctness (no data loss) takes priority. Future work.
- Re-tuning the avg chars-per-token constant. The fix must work whether
  that constant is 2.5 or 4.0.

## Design

Two changes to `chunkDocumentByTokens` in
`engine/repository/chunking.ts`, both surgical:

### 1. Widen the re-chunk planning headroom

Change the safety margin in the re-chunk planning step from `0.95` to
`0.85`. This absorbs typical local density variation up-front, so most
sub-chunks fit on the first re-chunk attempt.

```ts
// before
const safeMaxChars = Math.floor(maxTokens * actualCharsPerToken * 0.95);
// after
const safeMaxChars = Math.floor(maxTokens * actualCharsPerToken * 0.85);
```

Cost: a small increase in chunk count for documents that go through the
re-chunk path (rare overall — only chunks that already exceeded the
budget once). Benefit: most overshoots disappear without entering the
force-split path.

### 2. Replace the "skip" branch with a bounded force-split

When a sub-chunk still exceeds `maxTokens` after re-chunking, the new
behavior is:

- Compute a local chars-per-token from the actual measured overshoot.
- Walk the sub-chunk text forward in slices of `safeChars =
  floor(maxTokens × localCharsPerToken × 0.85)`.
- Tokenize each slice. If `≤ maxTokens`, emit it. If still over, shrink
  `safeChars` by the observed overshoot ratio (× `maxTokens/pieceTokens
  × 0.9`) and retry the same window — do not advance the cursor.
- Bound the inner retry loop with a `MAX_SHRINK_ITERS = 8` guard so a
  pathological tokenizer cannot hang ingestion. If after that many
  retries the slice still does not fit, halve `safeChars` and continue.
  This is guaranteed to converge: at `safeChars = 1` a single character
  produces at most a handful of tokens for any practical tokenizer, well
  under `maxTokens`.

Each emitted slice gets `pos = chunk.pos + subChunk.pos + cursor` so
positions remain consistent with the existing contract.

The previous warning text remains but is **demoted to a debug-level
note** ("force-split applied") because the data is no longer being lost.
Operators should see a count, not a flood.

### Why a char-loop, not a token-loop

Token-precise cutting would require the tokenizer to expose a token →
char-offset map (or call `detokenize` per prefix). The current interface
returns `readonly any[]` with no offsets. Adding offset support is a
larger refactor and risks coupling chunker to specific backends. The
char-loop with proportional shrink converges in 1–2 iterations on real
documents, so token-perfection is not worth the surgery for this fix.

## Contract change

Before:

> `chunkDocumentByTokens(content)` returns chunks whose `tokens ≤
> maxTokens`. Some input bytes may be silently absent from the output.

After:

> `chunkDocumentByTokens(content)` returns chunks whose `tokens ≤
> maxTokens` **and** whose concatenated `text` (accounting for overlap)
> covers every byte of the input.

## Test plan

Add two regression tests to `specs/store.test.ts`:

1. **Force-split emits all content.** Construct a synthetic input where
   the tokenizer reports densities forcing the re-chunk pass to overshoot,
   and assert that the union of `(pos, pos + text.length)` intervals over
   the returned chunks covers `[0, content.length)`.
2. **Force-split never emits an oversize chunk.** Same input, assert
   every returned chunk's `tokens ≤ maxTokens`.

Existing tests in the `Token-based Chunking` and `Smart Chunking
Integration` blocks must continue to pass.

## Migration / rollout

No database schema change. No public API change. The function's return
shape is unchanged: `{ text, pos, tokens }[]`. Operators who previously
saw the warning will simply stop seeing it after the re-index; their
index will be **more** complete than before.

A reindex is recommended for any vault that produced the warning, but
is not required for correctness of new ingests.

## Risks

- **Slightly more chunks per document** on the rare re-chunk path. Acceptable.
- **Force-split chunks may end mid-sentence**, hurting retrieval recall on
  the boundary. Acceptable — boundary loss is strictly less harmful than
  whole-section loss. Improved break-point handling inside the force-split
  is tracked as future work.
- **Tokenizer cost** of the inner retry loop. Bounded to
  `MAX_SHRINK_ITERS = 8` per emitted slice; in practice 1–2 retries
  suffice. Negligible against the cost of an embedding pass.
