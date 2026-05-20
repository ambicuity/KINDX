// Extracted from engine/repository.ts as part of W1 decomposition (C10).
// FTS5 query construction + validation helpers. Pure string transformations,
// no dependencies on storage or types.
// searchFTS itself remains in repository.ts until SearchResult/getDocid/getContextForFile
// are extracted in later clusters.
// Spec: docs/superpowers/specs/2026-05-20-kindx-strategic-refactor-program-design.md §5

export function sanitizeFTS5Term(term: string): string {
  // Preserve underscores so snake_case identifiers (e.g., my_function_name)
  // are treated as single terms rather than being split into separate words.
  return term.replace(/[^\p{L}\p{N}'_]/gu, '').toLowerCase();
}

/**
 * Parse lex query syntax into FTS5 query.
 *
 * Supports:
 * - Quoted phrases: "exact phrase" → "exact phrase" (exact match)
 * - Negation: -term or -"phrase" → uses FTS5 NOT operator
 * - Plain terms: term → "term"* (prefix match)
 */
export function buildFTS5Query(query: string): string | null {
  const positive: string[] = [];
  const negative: string[] = [];

  let i = 0;
  const s = query.trim();

  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i]!)) i++;
    if (i >= s.length) break;

    const negated = s[i] === '-';
    if (negated) i++;

    if (s[i] === '"') {
      const start = i + 1;
      i++;
      while (i < s.length && s[i] !== '"') i++;
      const phrase = s.slice(start, i).trim();
      i++;
      if (phrase.length > 0) {
        const sanitized = phrase.split(/\s+/).map(t => sanitizeFTS5Term(t)).filter(t => t).join(' ');
        if (sanitized) {
          const ftsPhrase = `"${sanitized}"`;
          if (negated) {
            negative.push(ftsPhrase);
          } else {
            positive.push(ftsPhrase);
          }
        }
      }
    } else {
      const start = i;
      while (i < s.length && !/[\s"]/.test(s[i]!)) i++;
      const term = s.slice(start, i);

      const sanitized = sanitizeFTS5Term(term);
      if (sanitized) {
        const ftsTerm = `"${sanitized}"*`;
        if (negated) {
          negative.push(ftsTerm);
        } else {
          positive.push(ftsTerm);
        }
      }
    }
  }

  if (positive.length === 0 && negative.length === 0) return null;
  if (positive.length === 0) return null;

  let result = positive.join(' AND ');
  for (const neg of negative) {
    result = `${result} NOT ${neg}`;
  }

  return result;
}

/**
 * Validate that a vec/hyde query doesn't use lex-only syntax.
 */
export function validateSemanticQuery(query: string): string | null {
  if (/-\w/.test(query) || /-"/.test(query)) {
    return 'Negation (-term) is not supported in vec/hyde queries. Use lex for exclusions.';
  }
  return null;
}

export function validateLexQuery(query: string): string | null {
  if (/[\r\n]/.test(query)) {
    return 'Lex queries must be a single line. Remove newline characters or split into separate lex: lines.';
  }
  const quoteCount = (query.match(/"/g) ?? []).length;
  if (quoteCount % 2 === 1) {
    return 'Lex query has an unmatched double quote ("). Add the closing quote or remove it.';
  }
  return null;
}
