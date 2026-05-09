/**
 * logger.ts
 *
 * Lightweight, zero-dependency structural logger for KINDX daemon operations.
 * MCP uses stdout for its transport mechanism, meaning all application logging MUST
 * stream securely to stderr to prevent corrupting the internal pipes.
 */

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
export type LogFormat = 'text' | 'json';

const LOG_LEVELS: Record<LogLevel, number> = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3
};

let currentLevel = (process.env.KINDX_LOG_LEVEL?.toUpperCase() as LogLevel) ?? 'INFO';
let currentLevelWeight = LOG_LEVELS[currentLevel] ?? LOG_LEVELS['INFO'];
let logFormat: LogFormat = (process.env.KINDX_LOG_JSON === '1' || process.env.KINDX_LOG_JSON === 'true')
  ? 'json'
  : 'text';

export function configureLogger(options: { level?: string; format?: string }): void {
  if (options.level) {
    const normalized = options.level.trim().toUpperCase();
    if (normalized in LOG_LEVELS) {
      currentLevel = normalized as LogLevel;
      currentLevelWeight = LOG_LEVELS[currentLevel];
    }
  }

  if (options.format) {
    const normalized = options.format.trim().toLowerCase();
    if (normalized === 'json' || normalized === 'text') {
      logFormat = normalized;
    }
  }
}

/**
 * Tier-2: strip newlines, carriage returns, and ANSI escape sequences from
 * a log message before emitting. Without sanitization, an attacker-controlled
 * value (file path, query string, header) embedded in a log line could
 * inject forged log entries or spoof control codes (`\n[ERROR] system
 * breached`). Applies to both `msg` and string values inside `meta`.
 */
function sanitizeLogValue(v: unknown): unknown {
  if (typeof v === "string") {
    return v
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "") // CSI escapes
      .replace(/\x1b\][^\x07]*\x07/g, "")      // OSC escapes
      .replace(/[\r\n]+/g, " ⏎ ");             // collapse newlines
  }
  return v;
}

export const logger = {
  log(level: LogLevel, msg: string, meta?: Record<string, unknown>) {
    if ((LOG_LEVELS[level] ?? LOG_LEVELS['INFO']) < currentLevelWeight) return;

    const safeMsg = sanitizeLogValue(msg) as string;
    let safeMeta: Record<string, unknown> | undefined;
    if (meta) {
      safeMeta = {};
      for (const [k, v] of Object.entries(meta)) {
        safeMeta[k] = sanitizeLogValue(v);
      }
    }

    if (logFormat === 'json') {
      const payload = {
        timestamp: new Date().toISOString(),
        level,
        msg: safeMsg,
        ...safeMeta,
      };
      process.stderr.write(JSON.stringify(payload) + '\n');
    } else {
      const metaStr = safeMeta && Object.keys(safeMeta).length > 0 ? ` ${JSON.stringify(safeMeta)}` : '';
      process.stderr.write(`[${new Date().toISOString()}] [${level}] ${safeMsg}${metaStr}\n`);
    }
  },

  debug(msg: string, meta?: Record<string, unknown>) { this.log('DEBUG', msg, meta); },
  info(msg: string, meta?: Record<string, unknown>) { this.log('INFO', msg, meta); },
  warn(msg: string, meta?: Record<string, unknown>) { this.log('WARN', msg, meta); },
  error(msg: string, meta?: Record<string, unknown>) { this.log('ERROR', msg, meta); }
};
