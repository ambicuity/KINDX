// Terminal colors (respects NO_COLOR env)
const useColor = !process.env.NO_COLOR && process.stdout.isTTY;
export const c = {
  reset: useColor ? "\x1b[0m" : "",
  dim: useColor ? "\x1b[2m" : "",
  bold: useColor ? "\x1b[1m" : "",
  cyan: useColor ? "\x1b[36m" : "",
  yellow: useColor ? "\x1b[33m" : "",
  green: useColor ? "\x1b[32m" : "",
  magenta: useColor ? "\x1b[35m" : "",
  blue: useColor ? "\x1b[34m" : "",
  red: useColor ? "\x1b[31m" : "",
};

// Terminal cursor control
export const cursor = {
  hide() { process.stderr.write('\x1b[?25l'); },
  show() { process.stderr.write('\x1b[?25h'); },
  clearLine() { process.stderr.write('\r\x1b[K'); },
};

// Ensure cursor is restored on exit
let _signalsRegistered = false;
export function registerCursorCleanup(): void {
  if (typeof process === "undefined" || _signalsRegistered) return;
  const isCli = process.title === "node" && !process.env.VITEST && !process.env.NODE_ENV?.includes("test");
  if (!isCli) return;
  _signalsRegistered = true;
  process.on('SIGINT', () => { cursor.show(); process.exit(130); });
  process.on('SIGTERM', () => { cursor.show(); process.exit(143); });
}
registerCursorCleanup();

// Terminal progress bar using OSC 9;4 escape sequence (TTY only)
const isTTY = process.stderr.isTTY;
export const progress = {
  set(percent: number) {
    if (isTTY) process.stderr.write(`\x1b]9;4;1;${Math.round(percent)}\x07`);
  },
  clear() {
    if (isTTY) process.stderr.write(`\x1b]9;4;0\x07`);
  },
  indeterminate() {
    if (isTTY) process.stderr.write(`\x1b]9;4;3\x07`);
  },
  error() {
    if (isTTY) process.stderr.write(`\x1b]9;4;2\x07`);
  },
};

// Zero-dependency rich terminal spinner
export class Spinner {
  text: string;
  frames: string[] = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  frameIndex: number = 0;
  interval: number = 80;
  timer: NodeJS.Timeout | null = null;
  isTTY: boolean = process.stderr.isTTY;

  constructor(text: string) {
    this.text = text;
  }

  start(text?: string) {
    if (text) this.text = text;
    if (!this.isTTY) {
      process.stderr.write(`${this.text}...\n`);
      return this;
    }
    cursor.hide();
    this.timer = setInterval(() => {
      this.render();
      this.frameIndex = (this.frameIndex + 1) % this.frames.length;
    }, this.interval);
    this.render();
    return this;
  }

  render() {
    cursor.clearLine();
    process.stderr.write(`${c.cyan}${this.frames[this.frameIndex]}${c.reset} ${this.text}`);
  }

  stop(symbol: string, text?: string) {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.isTTY) {
      cursor.clearLine();
      process.stderr.write(`${symbol} ${text || this.text}\n`);
    } else if (text) {
      process.stderr.write(`${text}\n`);
    }
    cursor.show();
    return this;
  }

  succeed(text?: string) { return this.stop(`${c.green}✔${c.reset}`, text); }
  fail(text?: string) { return this.stop(`${c.red}✖${c.reset}`, text); }
  info(text?: string) { return this.stop(`${c.blue}ℹ${c.reset}`, text); }
  warn(text?: string) { return this.stop(`${c.yellow}⚠${c.reset}`, text); }
}

export function spinner(text: string) {
  return new Spinner(text);
}

// Format seconds into human-readable ETA
export function formatETA(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

export function formatTimeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

// Upgraded rich progress bar
export function renderProgressBar(percent: number, width: number = 30, options?: { etaSeconds?: number, prefix?: string, suffix?: string }): string {
  const p = Math.max(0, Math.min(100, percent));
  const filled = Math.round((p / 100) * width);
  const empty = width - filled;
  
  // Use block elements for a solid continuous bar
  const bar = `${c.cyan}${"█".repeat(filled)}${c.dim}${"▒".repeat(empty)}${c.reset}`;
  
  let result = bar;
  if (options?.prefix) result = `${options.prefix} ${result}`;
  
  const pctStr = `${c.bold}${p.toFixed(1)}%${c.reset}`;
  result = `${result} ${pctStr}`;
  
  if (options?.etaSeconds !== undefined && options.etaSeconds >= 0) {
    result += ` ${c.dim}ETA: ${formatETA(options.etaSeconds)}${c.reset}`;
  }
  if (options?.suffix) result += ` ${options.suffix}`;
  
  return result;
}
