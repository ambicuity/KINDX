/**
 * cli/progress.ts — multi-phase progress reporter for the KINDX CLI.
 *
 * A single `ProgressReporter` interface, four paint modes:
 *   - pretty-tty : animated spinners that collapse into "✓ <label> (Nms)" lines
 *   - pretty-log : persistent log lines with right-aligned timing (for pipes/CI)
 *   - ndjson     : one JSON event per call, written to stderr (for structured output)
 *   - silent     : drops everything except errors (--quiet / KINDX_PROGRESS=off)
 *
 * The mode is chosen by `resolveOutputMode()` so command handlers never branch
 * on TTY state themselves. The reporter owns its writes to stderr; stdout is
 * reserved for the actual command payload.
 *
 * Threading model: at most ONE phase is "active" at a time (the kindx pipeline
 * is sequential). Detail lines (e.g. the expanded-query tree) are buffered and
 * flushed on `end()`. Calling `start()` while another phase is active implicitly
 * ends the previous phase with a synthetic "✓" — this matches the legacy
 * behavior where one stderr write closed the prior line.
 */

import { paletteFor, glyphsFor } from "./output.js";
import type { ProgressMode } from "./output.js";

export { pickProgressMode } from "./output.js";
export type { ProgressMode } from "./output.js";

export interface ProgressEvent {
  event: "phase-start" | "phase-end" | "warn" | "error";
  name: string;
  label?: string;
  durationMs?: number;
  detail?: unknown;
  code?: string;
  message?: string;
}

export interface ProgressReporter {
  /** Begin a new phase. Implicitly closes any active phase. */
  start(name: string, label: string): void;
  /**
   * Attach indented detail lines to the current (or most-recent) phase.
   * In pretty-tty mode these flush when the phase ends.
   */
  detail(lines: readonly string[]): void;
  /** Mark the active phase complete. `extra` is included in ndjson events. */
  end(name: string, extra?: { durationMs?: number; detail?: unknown }): void;
  /** Emit a structured warning. Visible in pretty modes; carried in ndjson too. */
  warn(code: string, message: string, detail?: unknown): void;
  /** Emit a structured error. Same surfaces as warn(). */
  error(code: string, message: string, detail?: unknown): void;
  /** Force-stop animation and clean up cursor state. Safe to call multiple times. */
  done(): void;
}

interface ReporterDeps {
  mode: ProgressMode;
  color: boolean;
  glyphs?: ReturnType<typeof glyphsFor>;
  stderr?: NodeJS.WritableStream;
  /** Override the spinner frame interval (ms). Tests set this to 0. */
  intervalMs?: number;
  /** Clock injection point for tests. */
  now?: () => number;
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const ASCII_SPINNER_FRAMES = ["-", "\\", "|", "/"];

function formatMs(ms: number | undefined): string {
  if (ms === undefined) return "";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Build a paint-mode reporter. Callers select the mode via `resolveOutputMode()`.
 */
export function createProgressReporter(deps: ReporterDeps): ProgressReporter {
  const stderr = deps.stderr ?? process.stderr;
  switch (deps.mode) {
    case "silent": return silentReporter(stderr, deps.color);
    case "ndjson": return ndjsonReporter(stderr, deps.now ?? Date.now);
    case "pretty-tty": return prettyTtyReporter(stderr, deps);
    case "pretty-log":
    default: return prettyLogReporter(stderr, deps);
  }
}

// ─── silent ──────────────────────────────────────────────────────────────────

function silentReporter(stderr: NodeJS.WritableStream, color: boolean): ProgressReporter {
  const palette = paletteFor(color);
  return {
    start() {},
    detail() {},
    end() {},
    warn() {},
    error(code, message) {
      stderr.write(`${palette.red("error")}: ${code}: ${message}\n`);
    },
    done() {},
  };
}

// ─── ndjson ──────────────────────────────────────────────────────────────────

function ndjsonReporter(stderr: NodeJS.WritableStream, now: () => number): ProgressReporter {
  const phaseStart = new Map<string, number>();
  const write = (ev: ProgressEvent) => stderr.write(JSON.stringify(ev) + "\n");
  return {
    start(name, label) {
      phaseStart.set(name, now());
      write({ event: "phase-start", name, label });
    },
    detail(lines) {
      // Detail in ndjson is folded into the next phase-end event, but it's
      // also useful as a standalone signal — emit it as a side-channel event
      // tagged onto the most-recent phase.
      if (lines.length === 0) return;
      const last = [...phaseStart.keys()].pop();
      write({ event: "phase-start", name: last ?? "detail", label: "detail", detail: lines });
    },
    end(name, extra) {
      const startedAt = phaseStart.get(name);
      const durationMs = extra?.durationMs ?? (startedAt !== undefined ? now() - startedAt : undefined);
      phaseStart.delete(name);
      write({ event: "phase-end", name, durationMs, detail: extra?.detail });
    },
    warn(code, message, detail) {
      write({ event: "warn", name: code, code, message, detail });
    },
    error(code, message, detail) {
      write({ event: "error", name: code, code, message, detail });
    },
    done() {},
  };
}

// ─── pretty-log (non-TTY) ────────────────────────────────────────────────────

function prettyLogReporter(stderr: NodeJS.WritableStream, deps: ReporterDeps): ProgressReporter {
  const palette = paletteFor(deps.color);
  const glyphs = deps.glyphs ?? glyphsFor();
  const now = deps.now ?? Date.now;
  const phaseStart = new Map<string, number>();
  let lastStartedName: string | null = null;
  let lastStartedLabel: string | null = null;
  let detailBuffer: string[] = [];

  const flushDetail = () => {
    for (const line of detailBuffer) {
      stderr.write(`  ${palette.dim(line)}\n`);
    }
    detailBuffer = [];
  };

  return {
    start(name, label) {
      flushDetail();
      stderr.write(`${palette.dim("▸")} ${palette.dim(label + "…")}\n`);
      phaseStart.set(name, now());
      lastStartedName = name;
      lastStartedLabel = label;
    },
    detail(lines) {
      detailBuffer.push(...lines);
    },
    end(name, extra) {
      flushDetail();
      const startedAt = phaseStart.get(name);
      const durationMs = extra?.durationMs ?? (startedAt !== undefined ? now() - startedAt : undefined);
      phaseStart.delete(name);
      const ms = formatMs(durationMs);
      const tail = ms ? ` ${palette.dim(`(${ms})`)}` : "";
      const label = name === lastStartedName && lastStartedLabel ? lastStartedLabel : name;
      stderr.write(`  ${palette.green(glyphs.ok)} ${label}${tail}\n`);
      if (name === lastStartedName) {
        lastStartedName = null;
        lastStartedLabel = null;
      }
    },
    warn(code, message) {
      stderr.write(`${palette.yellow(glyphs.warn)} ${palette.yellow(`warn[${code}]`)}: ${message}\n`);
    },
    error(code, message) {
      stderr.write(`${palette.red(glyphs.err)} ${palette.red(`error[${code}]`)}: ${message}\n`);
    },
    done() {
      flushDetail();
    },
  };
}

// ─── pretty-tty ──────────────────────────────────────────────────────────────

function prettyTtyReporter(stderr: NodeJS.WritableStream, deps: ReporterDeps): ProgressReporter {
  const palette = paletteFor(deps.color);
  const glyphs = deps.glyphs ?? glyphsFor();
  const now = deps.now ?? Date.now;
  const intervalMs = deps.intervalMs ?? 80;
  const utf8 = glyphs.ok === "✓";
  const frames = utf8 ? SPINNER_FRAMES : ASCII_SPINNER_FRAMES;

  interface ActivePhase { name: string; label: string; startedAt: number; }
  let active: ActivePhase | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let frameIndex = 0;
  let detailBuffer: string[] = [];
  let cursorHidden = false;

  const hideCursor = () => {
    if (!cursorHidden) {
      stderr.write("\x1b[?25l");
      cursorHidden = true;
    }
  };
  const showCursor = () => {
    if (cursorHidden) {
      stderr.write("\x1b[?25h");
      cursorHidden = false;
    }
  };
  const clearLine = () => stderr.write("\r\x1b[K");

  const renderFrame = () => {
    if (!active) return;
    clearLine();
    const frame = frames[frameIndex % frames.length];
    stderr.write(`${palette.cyan(frame ?? "")} ${palette.dim(active.label + "…")}`);
  };

  const startAnimation = () => {
    if (timer || intervalMs === 0) return;
    timer = setInterval(() => {
      frameIndex = (frameIndex + 1) % frames.length;
      renderFrame();
    }, intervalMs);
    // Don't block process exit on the spinner timer.
    if (typeof (timer as { unref?: () => void }).unref === "function") {
      (timer as { unref: () => void }).unref();
    }
  };
  const stopAnimation = () => {
    if (timer) { clearInterval(timer); timer = null; }
  };

  const closeActive = (name: string | null, durationMs?: number) => {
    if (!active) return;
    if (name && active.name !== name) {
      // Mismatched end — close whatever's active with a synthetic ✓.
    }
    stopAnimation();
    clearLine();
    const ms = formatMs(durationMs ?? now() - active.startedAt);
    const tail = ms ? ` ${palette.dim(`(${ms})`)}` : "";
    stderr.write(`${palette.green(glyphs.ok)} ${active.label}${tail}\n`);
    if (detailBuffer.length > 0) {
      for (const line of detailBuffer) {
        stderr.write(`  ${palette.dim(line)}\n`);
      }
      detailBuffer = [];
    }
    active = null;
  };

  return {
    start(name, label) {
      if (active) closeActive(active.name);
      active = { name, label, startedAt: now() };
      frameIndex = 0;
      hideCursor();
      renderFrame();
      startAnimation();
    },
    detail(lines) {
      detailBuffer.push(...lines);
    },
    end(name, extra) {
      closeActive(name, extra?.durationMs);
      if (!active) showCursor();
    },
    warn(code, message) {
      // Pause active spinner, print the warning above it, restore the spinner.
      const hadActive = active;
      if (active) { stopAnimation(); clearLine(); }
      stderr.write(`${palette.yellow(glyphs.warn)} ${palette.yellow(`warn[${code}]`)}: ${message}\n`);
      if (hadActive) {
        renderFrame();
        startAnimation();
      }
    },
    error(code, message) {
      const hadActive = active;
      if (active) { stopAnimation(); clearLine(); }
      stderr.write(`${palette.red(glyphs.err)} ${palette.red(`error[${code}]`)}: ${message}\n`);
      if (hadActive) {
        renderFrame();
        startAnimation();
      }
    },
    done() {
      if (active) closeActive(active.name);
      stopAnimation();
      showCursor();
    },
  };
}

