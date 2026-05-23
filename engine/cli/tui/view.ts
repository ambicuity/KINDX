/**
 * cli/tui/view.ts — pure renderer for the TUI's full-screen views. Given a
 * `TuiState` and terminal capabilities, produces the string to write to the
 * alternate screen buffer. No I/O happens here.
 */

import { paletteFor, glyphsFor } from "../output.js";
import type { TuiState } from "./state.js";
import type { TtyCaps } from "./tty.js";

const KEY_HINT_LINE = "/ search   ↑↓ move   ⏎ open   m mode   c col   r refresh   ? help   q quit";
const KEY_HINT_LINE_ASCII = "/ search   up/down move   enter open   m mode   c col   r refresh   ? help   q quit";

export function render(state: TuiState, caps: TtyCaps): string {
  switch (state.view) {
    case "details": return renderDetails(state, caps);
    case "help":    return renderHelp(state, caps);
    case "status":
    case "memory":  return renderOverlay(state, caps, state.view);
    case "search":
    default:        return renderSearch(state, caps);
  }
}

function pad(s: string, w: number): string {
  if (s.length >= w) return s.slice(0, w);
  return s + " ".repeat(w - s.length);
}

function renderSearch(state: TuiState, caps: TtyCaps): string {
  const palette = paletteFor(caps.color);
  const glyphs = glyphsFor();
  const width = caps.width;
  const compact = width < 80;

  const out: string[] = [];

  // Header row: > query                            [mode: hybrid] [col: <name>]
  const cursor = palette.cyan("> ");
  const queryStr = state.query.length > 0 ? state.query : palette.dim("(type to search)");
  const chips: string[] = [];
  if (!compact) {
    chips.push(palette.dim(`[mode: ${state.mode}]`));
    chips.push(palette.dim(`[col: ${state.collection ?? "any"}]`));
  }
  const head = cursor + queryStr;
  // Right-align chips when there's room.
  const chipsStr = chips.join(" ");
  const pad1 = Math.max(1, width - visibleLen(head) - visibleLen(chipsStr));
  out.push(head + " ".repeat(pad1) + chipsStr);

  // Divider
  out.push(palette.dim("─".repeat(width)));

  // Results region
  const reservedRows = 3; // header + divider + status bar
  const listRows = Math.max(3, caps.height - reservedRows);
  const hits = state.hits.slice(0, listRows);
  if (state.loading) {
    out.push("  " + palette.dim("searching…"));
  } else if (hits.length === 0) {
    out.push("  " + palette.dim(state.query ? "no results" : "type a query and press enter"));
  } else {
    for (let i = 0; i < hits.length; i++) {
      const row = hits[i];
      const sel = i === state.cursor;
      const arrow = sel ? palette.cyan(glyphs.hint) : " ";
      const score = palette.bold((row.score * 100).toFixed(0).padStart(3) + "%");
      const path = palette.cyan(`kindx://${row.displayPath}`);
      const title = row.title ? `  ${palette.dim("· " + row.title)}` : "";
      const line = ` ${arrow} ${pad(String(row.rank), 2)}  ${score}  ${path}${title}`;
      out.push(sel ? bgInverse(line, palette) : line);
    }
  }

  // Pad to fill the screen so the status bar sticks to the bottom.
  while (out.length < caps.height - 1) out.push("");

  // Status / message
  // Unicode caps drive glyph choice (consistent with diagnostics renderer);
  // compact mode just collapses chips above, not the hint line.
  const hint = caps.unicode ? KEY_HINT_LINE : KEY_HINT_LINE_ASCII;
  out.push(palette.dim(state.message ? `${pad(state.message, Math.max(0, width - hint.length - 2))}  ${hint}` : hint));

  return out.join("\n");
}

function renderDetails(state: TuiState, caps: TtyCaps): string {
  const palette = paletteFor(caps.color);
  const row = state.hits[state.cursor];
  if (!row) return renderSearch(state, caps);
  const out: string[] = [];
  out.push(palette.bold(`kindx://${row.displayPath}`));
  if (row.title) out.push(palette.dim(row.title));
  out.push("");
  out.push(palette.dim("score ") + ((row.score * 100).toFixed(0) + "%"));
  out.push("");
  if (row.snippet) {
    for (const line of row.snippet.split("\n")) out.push(line);
  }
  while (out.length < caps.height - 1) out.push("");
  out.push(palette.dim("Esc / q  back     o  open     c  copy path     g  get     e  explain"));
  return out.join("\n");
}

function renderHelp(_state: TuiState, caps: TtyCaps): string {
  const palette = paletteFor(caps.color);
  const out: string[] = [];
  out.push(palette.bold("KINDX TUI — keyboard"));
  out.push("");
  const rows: [string, string][] = [
    ["/", "focus search input"],
    ["Enter", "open selected result"],
    ["↑ / k", "move selection up"],
    ["↓ / j", "move selection down"],
    ["m", "cycle search mode (hybrid → lex → vec → hyde)"],
    ["c", "filter by collection"],
    ["r", "refresh / re-run query"],
    ["e", "explain selected result"],
    ["?", "this help overlay"],
    ["Esc", "back / cancel"],
    ["q", "quit"],
  ];
  for (const [k, v] of rows) {
    out.push(`  ${palette.cyan(k.padEnd(8))} ${v}`);
  }
  while (out.length < caps.height - 1) out.push("");
  out.push(palette.dim("Press any key to dismiss"));
  return out.join("\n");
}

function renderOverlay(state: TuiState, caps: TtyCaps, label: string): string {
  const palette = paletteFor(caps.color);
  const out: string[] = [];
  out.push(palette.bold(`KINDX ${label}`));
  out.push(palette.dim("(stub view — wired up incrementally)"));
  while (out.length < caps.height - 1) out.push("");
  out.push(palette.dim("Esc / q  back"));
  return out.join("\n");
}

function visibleLen(s: string): number {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, "").length;
}

function bgInverse(line: string, palette: ReturnType<typeof paletteFor>): string {
  // Use bold cyan rather than literal background inversion to keep output
  // readable on monochrome / low-contrast terminals.
  return palette.bold(line);
}
