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
};

// Terminal cursor control
export const cursor = {
  hide() { process.stderr.write('\x1b[?25l'); },
  show() { process.stderr.write('\x1b[?25h'); },
};

// Ensure cursor is restored on exit
process.on('SIGINT', () => { cursor.show(); process.exit(130); });
process.on('SIGTERM', () => { cursor.show(); process.exit(143); });

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

export function renderProgressBar(percent: number, width: number = 30): string {
  const filled = Math.round((percent / 100) * width);
  const empty = width - filled;
  const bar = "█".repeat(filled) + "░".repeat(empty);
  return bar;
}
