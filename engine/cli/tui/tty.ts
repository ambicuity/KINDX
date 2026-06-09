/**
 * cli/tui/tty.ts — low-level terminal control for KINDX's lightweight TUI.
 *
 * Wraps Node's tty module in a small, testable surface:
 *   - `enterAltScreen()` switches to the alternate screen buffer (so the
 *     user's scrollback is preserved when they exit).
 *   - `enableRawMode()` puts stdin in cbreak so we can read single keys.
 *   - `installCleanup()` registers exit/SIGINT/SIGTERM/uncaughtException
 *     handlers that always restore cooked mode + cursor + main screen.
 *
 * Every escape sequence used here works on macOS Terminal/iTerm, Linux
 * xterm-likes, and Windows 10+/ConPTY. Resize is delivered via SIGWINCH.
 */

import { emitKeypressEvents } from "node:readline";

export interface TtyCaps {
  width: number;
  height: number;
  color: boolean;
  unicode: boolean;
}

const ESC = "\x1b";
const ALT_ON  = `${ESC}[?1049h`;
const ALT_OFF = `${ESC}[?1049l`;
const CURSOR_HIDE = `${ESC}[?25l`;
const CURSOR_SHOW = `${ESC}[?25h`;
const CLEAR_SCREEN = `${ESC}[2J${ESC}[H`;

export function tryReadCaps(env: NodeJS.ProcessEnv = process.env): TtyCaps {
  const cols = (process.stdout && (process.stdout as { columns?: number }).columns) ?? 80;
  const rows = (process.stdout && (process.stdout as { rows?: number }).rows) ?? 24;
  const locale = (env.LC_ALL || env.LC_CTYPE || env.LANG || "").toUpperCase();
  const unicode = locale.includes("UTF-8") || locale.includes("UTF8") || env.KINDX_FORCE_UTF8 === "1";
  const color = !env.NO_COLOR && Boolean(process.stdout?.isTTY);
  return { width: cols, height: rows, color, unicode };
}

export function moveTo(row: number, col: number): string {
  // Terminal rows/cols are 1-based.
  return `${ESC}[${row};${col}H`;
}

export function clearLine(): string {
  return `${ESC}[2K\r`;
}

export function writeOut(s: string): void {
  process.stdout.write(s);
}

export function enterAltScreen(): void {
  writeOut(ALT_ON + CURSOR_HIDE + CLEAR_SCREEN);
}

export function exitAltScreen(): void {
  writeOut(CURSOR_SHOW + ALT_OFF);
}

/**
 * Switch stdin to raw mode and route keypresses through readline's parser.
 * Returns a cleanup function that restores cooked mode. Safe to call when
 * stdin is not a TTY (no-op).
 */
export function enableRawMode(): () => void {
  if (!process.stdin.isTTY || typeof (process.stdin as { setRawMode?: (b: boolean) => void }).setRawMode !== "function") {
    return () => {};
  }
  (process.stdin as { setRawMode: (b: boolean) => void }).setRawMode(true);
  process.stdin.resume();
  emitKeypressEvents(process.stdin);
  return () => {
    try { (process.stdin as { setRawMode: (b: boolean) => void }).setRawMode(false); } catch { /* ignore */ }
    process.stdin.pause();
  };
}

/**
 * Install crash/exit handlers that always restore the terminal. The returned
 * disposer removes them — call it on a clean shutdown so the host process
 * is left as we found it.
 */
export function installCleanup(restore: () => void): () => void {
  let fired = false;
  const run = () => {
    if (fired) return;
    fired = true;
    try { restore(); } catch { /* ignore */ }
  };
  const onExit = () => run();
  const onSig = (signal: NodeJS.Signals) => { run(); process.exit(signal === "SIGINT" ? 130 : 143); };
  const onErr = (err: unknown) => { run(); process.stderr.write(`\nTUI error: ${(err as Error)?.stack || err}\n`); process.exit(1); };

  process.on("exit", onExit);
  process.on("SIGINT", onSig);
  process.on("SIGTERM", onSig);
  process.on("uncaughtException", onErr);
  process.on("unhandledRejection", onErr);

  return () => {
    process.off("exit", onExit);
    process.off("SIGINT", onSig);
    process.off("SIGTERM", onSig);
    process.off("uncaughtException", onErr);
    process.off("unhandledRejection", onErr);
  };
}

/**
 * Subscribe to terminal resize events. Returns an unsubscribe fn.
 */
export function onResize(fn: (caps: TtyCaps) => void): () => void {
  const handler = () => fn(tryReadCaps());
  process.stdout.on("resize", handler);
  return () => { process.stdout.off("resize", handler); };
}
