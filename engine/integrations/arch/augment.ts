import { existsSync, readFileSync } from "node:fs";
import type { ArchHint } from "./contracts.js";

export type SelectedArchHint = {
  title: string;
  kind: ArchHint["kind"];
  body: string;
  sourceFiles: string[];
  confidence?: string;
};

function tokenize(input: string): string[] {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 3);
}

function overlapScore(queryTokens: string[], hint: ArchHint): number {
  const haystack = `${hint.title ?? ""} ${hint.body ?? ""} ${(hint.scoreSignals ?? []).join(" ")}`.toLowerCase();
  let score = 0;
  for (const token of queryTokens) {
    if (haystack.includes(token)) score += 1;
  }
  if (hint.kind === "god_node") score += 0.2;
  if (hint.kind === "surprising_edge") score += 0.15;
  return score;
}

export function selectArchHints(
  query: string,
  hintsPath: string,
  maxHints: number,
): SelectedArchHint[] {
  if (!existsSync(hintsPath)) return [];

  let hints: ArchHint[];
  try {
    hints = JSON.parse(readFileSync(hintsPath, "utf-8")) as ArchHint[];
  } catch {
    return [];
  }

  if (!Array.isArray(hints) || hints.length === 0) return [];
  const tokens = tokenize(query);
  if (tokens.length === 0) return [];

  return hints
    .map((hint) => ({ hint, score: overlapScore(tokens, hint) }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxHints)
    .map(({ hint }) => ({
      title: hint.title,
      kind: hint.kind,
      body: hint.body,
      sourceFiles: hint.sourceFiles,
      confidence: hint.confidence,
    }));
}
