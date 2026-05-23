/**
 * cli/renderers/memory.ts — pretty rendering for `kindx memory` output.
 *
 * Memory entries surface scope, id, key, value preview, similarity/hit-rate
 * score, and timestamps when available. The renderer truncates long values
 * to keep the list scannable; full values are reachable via `--json`.
 */

import { paletteFor } from "../output.js";

export interface MemoryRow {
  id: number;
  key: string;
  value: string;
  similarity?: number | null;
  hitRate?: number | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  lastAccessedAt?: string | null;
  tags?: string[];
  source?: string | null;
}

export interface MemorySearchHeader {
  scope: string;
  mode: "semantic" | "text";
  query: string;
  totalResults: number;
}

const MAX_PREVIEW = 80;

function preview(value: string): string {
  const single = value.replace(/\s+/g, " ").trim();
  return single.length > MAX_PREVIEW ? single.slice(0, MAX_PREVIEW - 1) + "…" : single;
}

function formatScore(row: MemoryRow): string {
  if (row.similarity != null) return `sim=${row.similarity.toFixed(3)}`;
  if (row.hitRate != null) return `hit=${row.hitRate.toFixed(3)}`;
  return "";
}

function formatTimes(row: MemoryRow, palette: ReturnType<typeof paletteFor>): string {
  const parts: string[] = [];
  if (row.updatedAt) parts.push(palette.dim(`updated ${row.updatedAt}`));
  else if (row.createdAt) parts.push(palette.dim(`created ${row.createdAt}`));
  if (row.lastAccessedAt) parts.push(palette.dim(`last accessed ${row.lastAccessedAt}`));
  return parts.join("  ");
}

export function renderMemorySearch(
  header: MemorySearchHeader,
  rows: MemoryRow[],
  opts: { color: boolean },
): string {
  const palette = paletteFor(opts.color);
  const out: string[] = [];
  out.push(palette.bold(`Memory ${header.mode} search`) + palette.dim(`  scope=${header.scope}  results=${rows.length}`));
  if (rows.length === 0) {
    out.push(palette.dim("  No memories matched."));
    return out.join("\n");
  }
  for (const row of rows) {
    const score = formatScore(row);
    const scoreStr = score ? `  ${palette.dim(score)}` : "";
    out.push(`  ${palette.cyan(`#${row.id}`)}  ${palette.bold(row.key)}${scoreStr}`);
    out.push(`    ${preview(row.value)}`);
    if (row.tags && row.tags.length > 0) {
      out.push(`    ${palette.dim("tags: " + row.tags.join(", "))}`);
    }
    const times = formatTimes(row, palette);
    if (times) out.push(`    ${times}`);
  }
  return out.join("\n");
}

export function renderMemoryEntry(
  row: MemoryRow,
  opts: { color: boolean; scope: string; action?: string },
): string {
  const palette = paletteFor(opts.color);
  const out: string[] = [];
  const action = opts.action ?? "Stored";
  out.push(`${palette.green("✓")} ${action} memory in scope '${opts.scope}'`);
  out.push(`  ${palette.dim("id:")}    ${row.id}`);
  out.push(`  ${palette.dim("key:")}   ${row.key}`);
  out.push(`  ${palette.dim("value:")} ${preview(row.value)}`);
  if (row.tags && row.tags.length > 0) {
    out.push(`  ${palette.dim("tags:")}  ${row.tags.join(", ")}`);
  }
  const times = formatTimes(row, palette);
  if (times) out.push(`  ${times}`);
  return out.join("\n");
}
