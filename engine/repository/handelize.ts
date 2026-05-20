// Extracted from engine/repository.ts as part of W1 decomposition (C3).
// Filename "handelization": convert a route/file path into a token-friendly
// slug while preserving folder structure and extension. Also small helpers
// for emoji-to-hex conversion and docid derivation from a content hash.
// Spec: docs/superpowers/specs/2026-05-20-kindx-strategic-refactor-program-design.md §5

/**
 * Extract short docid from a full hash (first 6 characters).
 */
export function getDocid(hash: string): string {
  return hash.slice(0, 6);
}

/** Replace emoji/symbol codepoints with their hex representation (e.g. 🐘 → 1f418) */
function emojiToHex(str: string): string {
  return str.replace(/(?:\p{So}\p{Mn}?|\p{Sk})+/gu, (run) => {
    // Split the run into individual emoji and convert each to hex, dash-separated
    return [...run].filter(c => /\p{So}|\p{Sk}/u.test(c))
      .map(c => c.codePointAt(0)!.toString(16)).join('-');
  });
}

/**
 * Handelize a filename to be more token-friendly.
 * - Convert triple underscore `___` to `/` (folder separator)
 * - Convert to lowercase
 * - Replace sequences of non-word chars (except /) with single dash
 * - Remove leading/trailing dashes from path segments
 * - Preserve folder structure (a/b/c/d.md stays structured)
 * - Preserve file extension
 */
export function handelize(path: string): string {
  if (!path || path.trim() === '') {
    throw new Error('handelize: path cannot be empty');
  }

  // Allow route-style "$" filenames while still rejecting paths with no usable content.
  // Emoji (\p{So}) counts as valid content — they get converted to hex codepoints below.
  const segments = path.split('/').filter(Boolean);
  const lastSegment = segments[segments.length - 1] || '';
  const filenameWithoutExt = lastSegment.replace(/\.[^.]+$/, '');
  const hasValidContent = /[\p{L}\p{N}\p{So}\p{Sk}$]/u.test(filenameWithoutExt);
  if (!hasValidContent) {
    throw new Error(`handelize: path "${path}" has no valid filename content`);
  }

  const result = path
    .replace(/___/g, '/')       // Triple underscore becomes folder separator
    .toLowerCase()
    .split('/')
    .map((segment, idx, arr) => {
      const isLastSegment = idx === arr.length - 1;

      // Convert emoji to hex codepoints before cleaning
      segment = emojiToHex(segment);

      if (isLastSegment) {
        // For the filename (last segment), preserve the extension
        const extMatch = segment.match(/(\.[a-z0-9]+)$/i);
        const ext = extMatch ? extMatch[1] : '';
        const nameWithoutExt = ext ? segment.slice(0, -ext.length) : segment;

        const cleanedName = nameWithoutExt
          .replace(/[^\p{L}\p{N}$]+/gu, '-')  // Keep route marker "$", dash-separate other chars
          .replace(/^-+|-+$/g, ''); // Remove leading/trailing dashes

        return cleanedName + ext;
      } else {
        // For directories, just clean normally
        return segment
          .replace(/[^\p{L}\p{N}$]+/gu, '-')
          .replace(/^-+|-+$/g, '');
      }
    })
    .filter(Boolean)
    .join('/');

  if (!result) {
    throw new Error(`handelize: path "${path}" resulted in empty string after processing`);
  }

  return result;
}
