// Extracted from engine/repository.ts as part of W1 decomposition (C6).
// Document chunking — character-based and token-based. Depends on chunker.js
// utilities and inference.js for tokenization.
// Spec: docs/superpowers/specs/2026-05-20-kindx-strategic-refactor-program-design.md §5

import {
  CHUNK_SIZE_TOKENS,
  CHUNK_OVERLAP_TOKENS,
  CHUNK_SIZE_CHARS,
  CHUNK_OVERLAP_CHARS,
  CHUNK_WINDOW_TOKENS,
  CHUNK_WINDOW_CHARS,
  scanBreakPoints,
  findCodeFences,
  findBestCutoff,
} from "../chunker.js";
import { getDefaultLLM } from "../inference.js";

export function chunkDocument(
  content: string,
  maxChars: number = CHUNK_SIZE_CHARS,
  overlapChars: number = CHUNK_OVERLAP_CHARS,
  windowChars: number = CHUNK_WINDOW_CHARS
): { text: string; pos: number }[] {
  if (content.length <= maxChars) {
    return [{ text: content, pos: 0 }];
  }

  const breakPoints = scanBreakPoints(content);
  const codeFences = findCodeFences(content);

  const chunks: { text: string; pos: number }[] = [];
  let charPos = 0;

  while (charPos < content.length) {
    const targetEndPos = Math.min(charPos + maxChars, content.length);

    let endPos = targetEndPos;

    if (endPos < content.length) {
      const bestCutoff = findBestCutoff(
        breakPoints,
        targetEndPos,
        windowChars,
        0.7,
        codeFences
      );

      if (bestCutoff > charPos && bestCutoff <= targetEndPos) {
        endPos = bestCutoff;
      }
    }

    if (endPos <= charPos) {
      endPos = Math.min(charPos + maxChars, content.length);
    }

    chunks.push({ text: content.slice(charPos, endPos), pos: charPos });

    if (endPos >= content.length) {
      break;
    }
    charPos = endPos - overlapChars;
    const lastChunkPos = chunks.at(-1)!.pos;
    if (charPos <= lastChunkPos) {
      charPos = endPos;
    }
  }

  return chunks;
}

// Empirical avg chars/token for the models we ship. Used in two places:
//  (1) initial char-budget when planning chunks
//  (2) token-count fallback when llm.tokenize is unavailable
// Using the same constant in both places avoids the silent drift where the
// planner used 3.0 and the fallback used 3.5 — meaning a chunk that planned
// to fit X tokens could be reported as overflow by the validator and
// recursively re-chunked for no real reason.
const AVG_CHARS_PER_TOKEN = 3.5;
// Pessimistic ratio used only when tokenize() throws. Treats every two
// characters as a token so we err on the side of over-chunking instead of
// silently feeding the model an oversize batch.
const TOKEN_FALLBACK_ON_ERROR = 2;

function estimateTokensFromChars(chars: number, errored: boolean): number {
  return Math.ceil(chars / (errored ? TOKEN_FALLBACK_ON_ERROR : AVG_CHARS_PER_TOKEN));
}

/**
 * Chunk a document by actual token count using the LLM tokenizer.
 */
export async function chunkDocumentByTokens(
  content: string,
  maxTokens: number = CHUNK_SIZE_TOKENS,
  overlapTokens: number = CHUNK_OVERLAP_TOKENS,
  windowTokens: number = CHUNK_WINDOW_TOKENS
): Promise<{ text: string; pos: number; tokens: number }[]> {
  const llm = getDefaultLLM();

  const maxChars = Math.floor(maxTokens * AVG_CHARS_PER_TOKEN);
  const overlapChars = Math.floor(overlapTokens * AVG_CHARS_PER_TOKEN);
  const windowChars = Math.floor(windowTokens * AVG_CHARS_PER_TOKEN);

  let charChunks = chunkDocument(content, maxChars, overlapChars, windowChars);

  const results: { text: string; pos: number; tokens: number }[] = [];

  for (const chunk of charChunks) {
    let tokensLength: number;
    try {
      if (llm.tokenize) {
        tokensLength = (await llm.tokenize(chunk.text)).length;
      } else {
        tokensLength = estimateTokensFromChars(chunk.text.length, false);
      }
    } catch (tokenizeErr) {
      process.stderr.write(
        `KINDX Warning: tokenize() failed for chunk at pos=${chunk.pos} (len=${chunk.text.length}), skipping. ${tokenizeErr}\n`
      );
      tokensLength = estimateTokensFromChars(chunk.text.length, true);
    }

    if (tokensLength <= maxTokens) {
      results.push({ text: chunk.text, pos: chunk.pos, tokens: tokensLength });
    } else {
      // First-pass safety margin tightened from 0.95 to 0.85. The previous
      // 5% headroom was eaten by intra-chunk token-density variation (a
      // chunk whose average is 3.5 chars/tok can still contain a tail at
      // 2.5 chars/tok), causing systematic sub-chunk overshoots that were
      // then silently dropped. See spec:
      //   docs/superpowers/specs/2026-05-23-chunker-no-data-loss-design.md
      const actualCharsPerToken = Math.max(1, chunk.text.length / tokensLength);
      const safeMaxChars = Math.floor(maxTokens * actualCharsPerToken * 0.85);

      const subChunks = chunkDocument(
        chunk.text,
        safeMaxChars,
        Math.floor(overlapChars * actualCharsPerToken / 2),
        Math.floor(windowChars * actualCharsPerToken / 2)
      );

      for (const subChunk of subChunks) {
        let subTokensLength: number;
        try {
          if (llm.tokenize) {
            subTokensLength = (await llm.tokenize(subChunk.text)).length;
          } else {
            subTokensLength = estimateTokensFromChars(subChunk.text.length, false);
          }
        } catch {
          subTokensLength = estimateTokensFromChars(subChunk.text.length, true);
        }

        if (subTokensLength <= maxTokens) {
          results.push({
            text: subChunk.text,
            pos: chunk.pos + subChunk.pos,
            tokens: subTokensLength,
          });
        } else {
          // Force-split fallback: never drop content. Walk forward through
          // the sub-chunk in token-density-aware slices until every byte is
          // covered. Each emitted slice is guaranteed ≤ maxTokens because
          // we re-tokenize and shrink the window proportionally when over.
          const localCharsPerToken = Math.max(
            1,
            subChunk.text.length / subTokensLength
          );
          let safeChars = Math.max(
            1,
            Math.floor(maxTokens * localCharsPerToken * 0.85)
          );
          let cursor = 0;
          let emitted = 0;
          const MAX_SHRINK_ITERS = 8;

          while (cursor < subChunk.text.length) {
            let shrinkIter = 0;
            let accepted = false;

            while (shrinkIter < MAX_SHRINK_ITERS && !accepted) {
              const end = Math.min(cursor + safeChars, subChunk.text.length);
              const slice = subChunk.text.slice(cursor, end);

              let pieceTokens: number;
              try {
                if (llm.tokenize) {
                  pieceTokens = (await llm.tokenize(slice)).length;
                } else {
                  pieceTokens = estimateTokensFromChars(slice.length, false);
                }
              } catch {
                pieceTokens = estimateTokensFromChars(slice.length, true);
              }

              if (pieceTokens <= maxTokens) {
                results.push({
                  text: slice,
                  pos: chunk.pos + subChunk.pos + cursor,
                  tokens: pieceTokens,
                });
                cursor = end;
                emitted++;
                accepted = true;
              } else {
                // Proportional shrink: target maxTokens with 10% headroom,
                // based on observed token density of this exact slice.
                const ratio = (maxTokens / pieceTokens) * 0.9;
                const next = Math.max(1, Math.floor(safeChars * ratio));
                // Force progress: ensure the window actually shrinks.
                safeChars = next < safeChars ? next : Math.max(1, Math.floor(safeChars / 2));
                shrinkIter++;
              }
            }

            if (!accepted) {
              // Guard: refuse to advance with an oversize slice. Halve and
              // continue from the same cursor. Guaranteed to terminate:
              // at safeChars = 1 a single character produces O(1) tokens
              // for any practical tokenizer, well under maxTokens.
              safeChars = Math.max(1, Math.floor(safeChars / 2));
              if (safeChars === 1 && cursor + 1 < subChunk.text.length) {
                // Pathological tokenizer: emit a single-char slice and step.
                // Cannot exceed maxTokens for any sane tokenizer.
                const slice = subChunk.text.slice(cursor, cursor + 1);
                let pieceTokens: number;
                try {
                  pieceTokens = llm.tokenize
                    ? (await llm.tokenize(slice)).length
                    : 1;
                } catch {
                  pieceTokens = 1;
                }
                if (pieceTokens <= maxTokens) {
                  results.push({
                    text: slice,
                    pos: chunk.pos + subChunk.pos + cursor,
                    tokens: pieceTokens,
                  });
                  cursor += 1;
                  emitted++;
                } else {
                  // Truly unreachable for any normal tokenizer. Bail out
                  // loudly rather than silently lose data.
                  throw new Error(
                    `KINDX chunker: tokenizer reports ${pieceTokens} tokens for a single character at pos=${chunk.pos + subChunk.pos + cursor}; cannot force-split further.`
                  );
                }
              }
            }
          }

          process.stderr.write(
            `KINDX Note: force-split applied at pos=${chunk.pos + subChunk.pos} (orig tokens≈${subTokensLength}, emitted ${emitted} slices ≤ ${maxTokens}).\n`
          );
        }
      }
    }
  }

  return results;
}
