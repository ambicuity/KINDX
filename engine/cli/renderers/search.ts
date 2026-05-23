/**
 * cli/renderers/search.ts — pretty renderers for search results.
 *
 * Four layouts are supported:
 *   - snippets: the legacy default — kindx://path:N #docid / Title / Score / @@ diff
 *   - cards: stacked result cards with rank, title/path, scores, snippet
 *   - table: one row per result, fixed-width columns
 *   - lines: one line per result (fzf-style), score + path + title
 *
 * The renderer is a pure function: it consumes an array of result rows plus
 * an options bag and returns a string. ANSI escapes are emitted only when
 * `palette` is the color-enabled one — callers using plain output pass the
 * monochrome palette and the output is automatically ANSI-free.
 */

import { paletteFor, hyperlink, fileUrl } from "../output.js";

export interface SearchRenderRow {
  rank: number;
  docid?: string;
  displayPath: string;
  /**
   * Absolute filesystem path. When provided in the `snippets` layout the
   * URI line is wrapped in an OSC 8 hyperlink to `file://<absolutePath>#L<matchedLine>`.
   */
  absolutePath?: string;
  title?: string;
  context?: string | null;
  score: number;
  snippet?: string;
  /**
   * 1-indexed line number where the snippet body begins. Drives the
   * `lines X–Y` header and the line-number gutter in the snippets layout.
   * When absent, the gutter and the friendly header are suppressed.
   */
  bodyStartLine?: number;
  /** Total lines in the source document; needed for `(A before, B after)` counts. */
  totalLines?: number;
  matchedLine?: number;
  collection?: string;
  retrievalMode?: "hybrid" | "lex" | "vec" | "hyde" | "search" | "vsearch";
  rerankScore?: number;
  /**
   * Pre-formatted lines to print after the Score line (snippets layout).
   * Used to surface --explain output without coupling the renderer to the
   * `HybridQueryExplain` shape.
   */
  explainLines?: string[];
}

export interface SearchRenderOptions {
  /** Layout to use; defaults to snippets (legacy default). */
  layout?: "snippets" | "cards" | "table" | "lines";
  color: boolean;
  /** Show extra metadata block (collection, retrieval mode, etc.). */
  showMetadata?: boolean;
  /** Always show rank index even in lines layout. */
  showRank?: boolean;
  /** When true, render scores with explicit percentage. */
  showScores?: boolean;
  /** Query, used for "next-step" hints at the bottom and snippet highlighting. */
  query?: string;
  /** When false, suppresses the "Next:" hint footer. */
  showHints?: boolean;
}

const HINTS = (palette: ReturnType<typeof paletteFor>, q?: string): string => {
  const hint = palette.dim;
  const cmd = palette.cyan;
  const lines: string[] = [];
  lines.push(`${hint("Next:")} ${cmd("kindx get <path>")}  ${hint("· open document")}`);
  if (q) lines.push(`       ${cmd(`kindx query --explain "${q}"`)}  ${hint("· show retrieval trace")}`);
  return lines.join("\n");
};

function formatScore(score: number, color: boolean): string {
  const pct = (score * 100).toFixed(0).padStart(3);
  if (!color) return `${pct}%`;
  const palette = paletteFor(true);
  if (score >= 0.7) return palette.green(`${pct}%`);
  if (score >= 0.4) return palette.yellow(`${pct}%`);
  return palette.dim(`${pct}%`);
}

function renderCards(rows: SearchRenderRow[], opts: SearchRenderOptions): string {
  const palette = paletteFor(opts.color);
  const out: string[] = [];
  for (const row of rows) {
    const rank = palette.dim(`#${row.rank}`);
    const path = palette.cyan(`kindx://${row.displayPath}`);
    const docid = row.docid ? ` ${palette.dim(`#${row.docid}`)}` : "";
    const lineSuffix = row.matchedLine ? palette.dim(`:${row.matchedLine}`) : "";
    out.push(`${rank}  ${path}${lineSuffix}${docid}`);

    if (row.title) out.push(`    ${palette.bold(row.title)}`);
    if (row.context) out.push(`    ${palette.dim(`context: ${row.context}`)}`);

    const score = formatScore(row.score, opts.color);
    const scoreLine: string[] = [`score ${palette.bold(score)}`];
    if (opts.showMetadata && row.collection) scoreLine.push(palette.dim(`col: ${row.collection}`));
    if (opts.showMetadata && row.retrievalMode) scoreLine.push(palette.dim(`mode: ${row.retrievalMode}`));
    if (opts.showScores && row.rerankScore !== undefined) {
      scoreLine.push(palette.dim(`rerank: ${row.rerankScore.toFixed(3)}`));
    }
    out.push(`    ${scoreLine.join("   ")}`);

    if (row.snippet) {
      const snippet = row.snippet
        .split("\n")
        .map((l) => `    ${palette.dim("│ ")}${l}`)
        .join("\n");
      out.push(snippet);
    }
    out.push("");
  }

  if (opts.showHints !== false && rows.length > 0) {
    out.push(HINTS(palette, opts.query));
  }
  return out.join("\n");
}

function renderTable(rows: SearchRenderRow[], opts: SearchRenderOptions): string {
  const palette = paletteFor(opts.color);
  // Visual width (sans ANSI) since our palette helpers are inline-wrapped.
  // Path is the variable-width column; rank/score/collection are fixed.
  const rankW = 4;
  const scoreW = 6;
  const colW = 14;
  const header = [
    palette.dim("#".padEnd(rankW)),
    palette.dim("score".padEnd(scoreW)),
    palette.dim("col".padEnd(colW)),
    palette.dim("path / title"),
  ].join("  ");

  const lines: string[] = [header];
  for (const row of rows) {
    const rank = `${row.rank}`.padEnd(rankW);
    const scoreText = `${(row.score * 100).toFixed(0)}%`.padEnd(scoreW);
    const score = formatScore(row.score, opts.color).padEnd(scoreW + (opts.color ? 9 : 0));
    const col = (row.collection || "—").slice(0, colW).padEnd(colW);
    const path = palette.cyan(`kindx://${row.displayPath}`);
    const title = row.title ? `  ${palette.dim(row.title)}` : "";
    lines.push(`${rank}  ${opts.color ? score : scoreText}  ${col}  ${path}${title}`);
  }

  if (opts.showHints !== false && rows.length > 0) {
    lines.push("");
    lines.push(HINTS(palette, opts.query));
  }
  return lines.join("\n");
}

function renderSnippets(rows: SearchRenderRow[], opts: SearchRenderOptions): string {
  const palette = paletteFor(opts.color);
  const blocks: string[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row) continue;
    const lines: string[] = [];

    // Line 1: kindx:// URI + optional :line + optional #docid.
    // When color is on and an absolutePath is available, the URI portion
    // is wrapped in OSC 8 so modern terminals make it cmd+click-openable.
    const path = `kindx://${row.displayPath}`;
    const lineSuffix = row.matchedLine !== undefined ? `:${row.matchedLine}` : "";
    const docidStr = row.docid ? ` ${palette.dim(`#${row.docid}`)}` : "";
    const cyanPath = palette.cyan(path);
    const linked = row.absolutePath
      ? hyperlink(cyanPath, fileUrl(row.absolutePath, { line: row.matchedLine }), opts.color)
      : cyanPath;
    lines.push(`${linked}${palette.dim(lineSuffix)}${docidStr}`);

    // Optional Title / Context
    if (row.title) lines.push(`${palette.bold(`Title: ${row.title}`)}`);
    if (row.context) lines.push(`${palette.dim(`Context: ${row.context}`)}`);

    // Score line
    const score = formatScore(row.score, opts.color);
    lines.push(`Score: ${palette.bold(score)}`);

    // Optional pre-formatted explain block (caller already dims it).
    if (row.explainLines && row.explainLines.length > 0) {
      for (const l of row.explainLines) lines.push(palette.dim(l));
    }

    // Blank line, then friendly header + gutter-rendered body (or, if
    // the caller didn't supply bodyStartLine, fall back to the legacy
    // pre-formatted snippet to stay compatible with older call sites).
    lines.push("");
    if (row.snippet !== undefined) {
      if (row.bodyStartLine !== undefined) {
        const bodyLines = row.snippet.split("\n");
        const header = formatSnippetHeader(row.bodyStartLine, bodyLines.length, row.totalLines, opts.color);
        lines.push(header);
        lines.push(renderGutter(bodyLines, row.bodyStartLine, palette));
      } else {
        // Legacy path: snippet already has `@@ ... @@` header + body baked in.
        lines.push(row.snippet);
      }
    }

    blocks.push(lines.join("\n"));
  }
  // Double blank between results, matching legacy output.
  return blocks.join("\n\n\n");
}

/**
 * Build the human-readable snippet context header.
 *
 * `lines 12–42 (10 before, 18 after)`  ← when totalLines is known
 * `lines 12–42`                         ← when before/after counts are unknown
 */
function formatSnippetHeader(
  bodyStartLine: number,
  bodyLineCount: number,
  totalLines: number | undefined,
  color: boolean,
): string {
  const palette = paletteFor(color);
  const endLine = bodyStartLine + bodyLineCount - 1;
  let header = `lines ${bodyStartLine}–${endLine}`;
  if (totalLines !== undefined && totalLines > 0) {
    const before = bodyStartLine - 1;
    const after = Math.max(0, totalLines - endLine);
    header += ` (${before} before, ${after} after)`;
  }
  return palette.dim(header);
}

/**
 * Prefix each snippet line with `<n> | `. The gutter width auto-fits the
 * largest line number in the block so column alignment stays clean.
 */
function renderGutter(
  bodyLines: string[],
  startLine: number,
  palette: ReturnType<typeof paletteFor>,
): string {
  const maxLine = startLine + bodyLines.length - 1;
  const gutterW = String(maxLine).length;
  return bodyLines.map((line, i) => {
    const num = String(startLine + i).padStart(gutterW);
    return `${palette.dim(`${num} │`)} ${line}`;
  }).join("\n");
}

function renderLines(rows: SearchRenderRow[], opts: SearchRenderOptions): string {
  const palette = paletteFor(opts.color);
  const lines = rows.map((row) => {
    const rank = palette.dim(`${row.rank}`.padStart(2));
    const score = formatScore(row.score, opts.color);
    const path = palette.cyan(`kindx://${row.displayPath}`);
    const title = row.title ? ` ${palette.dim(`· ${row.title}`)}` : "";
    return `  ${rank}  ${score}  ${path}${title}`;
  });
  if (opts.showHints !== false && rows.length > 0) {
    lines.push("");
    lines.push(HINTS(palette, opts.query));
  }
  return lines.join("\n");
}

/**
 * Top-level renderer dispatch.
 */
export function renderSearchResults(
  rows: SearchRenderRow[],
  opts: SearchRenderOptions,
): string {
  if (rows.length === 0) {
    const palette = paletteFor(opts.color);
    return palette.dim("No results.");
  }
  switch (opts.layout || "snippets") {
    case "cards": return renderCards(rows, opts);
    case "table": return renderTable(rows, opts);
    case "lines": return renderLines(rows, opts);
    case "snippets":
    default:
      return renderSnippets(rows, opts);
  }
}

/**
 * Mask any matched-term highlighting. Used when stripping color for tests.
 */
export function highlightSnippet(
  snippet: string,
  query: string,
  color: boolean,
): string {
  if (!color || !query) return snippet;
  const palette = paletteFor(true);
  const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length >= 3);
  let result = snippet;
  for (const term of terms) {
    const safe = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(`(${safe})`, "gi");
    result = result.replace(regex, (m) => palette.bold(palette.yellow(m)));
  }
  return result;
}
