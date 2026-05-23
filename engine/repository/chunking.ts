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
      const actualCharsPerToken = Math.max(1, chunk.text.length / tokensLength);
      const safeMaxChars = Math.floor(maxTokens * actualCharsPerToken * 0.95);

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
          process.stderr.write(
            `KINDX Warning: sub-chunk at pos=${chunk.pos + subChunk.pos} (tokens≈${subTokensLength}) exceeds maxTokens=${maxTokens}, skipping to prevent model overflow.\n`
          );
        }
      }
    }
  }

  return results;
}
