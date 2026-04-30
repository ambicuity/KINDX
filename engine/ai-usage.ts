/**
 * ai-usage.ts — Immutable AI Model Usage Ledger
 *
 * Provides an append-only event ledger for tracking AI model token consumption
 * across all inference operations (embedding, generation, reranking, query expansion).
 *
 * Design principles:
 *   1. One immutable row per AI call — never updated, append-only.
 *   2. Synchronous writes via better-sqlite3 — no unawaited promise risk.
 *   3. Idempotency keys (UUID) with UNIQUE constraint — prevents duplicates on retry.
 *   4. Structured error logging — persistence failures are never silently swallowed.
 *   5. Read-time aggregation — no mutable counters; summaries computed from the ledger.
 */

import { randomUUID } from "node:crypto";
import type { Database } from "./runtime.js";

// =============================================================================
// Types
// =============================================================================

/** Token usage metadata returned by AI model responses. */
export type ModelUsage = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cached_tokens?: number;
};

/** Supported AI operations for usage tracking. */
export type AiOperation =
  | "embed"
  | "embed_batch"
  | "generate"
  | "rerank"
  | "expand_query";

/** Supported AI backend providers. */
export type AiProvider =
  | "llama_cpp"
  | "remote_openai"
  | "remote_ollama"
  | "unknown";

/** Execution status of an AI call. */
export type AiCallStatus = "success" | "error" | "timeout";

/** A single AI usage event to be recorded. */
export interface AiUsageEvent {
  idempotency_key: string;
  project_path: string;
  operation: AiOperation;
  provider: AiProvider;
  model: string;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cached_tokens: number;
  cost_usd: number | null;
  status: AiCallStatus;
  error_code: string | null;
  request_context: string;
  duration_ms: number;
  created_at: string;
}

/** Aggregated usage summary for a project or global scope. */
export interface AiUsageSummary {
  total_calls: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_tokens: number;
  error_count: number;
  total_duration_ms: number;
  models_used: number;
}

/** Per-operation breakdown row. */
export interface AiUsageByOperation {
  operation: string;
  call_count: number;
  total_tokens: number;
  total_duration_ms: number;
}

// =============================================================================
// Schema Initialization
// =============================================================================

/**
 * Initialize the ai_usage_ledger schema.
 * Idempotent — safe to call on every startup.
 */
export function initializeAiUsageSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ai_usage_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      idempotency_key TEXT NOT NULL UNIQUE,
      project_path TEXT NOT NULL DEFAULT '',
      operation TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      cached_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL,
      status TEXT NOT NULL DEFAULT 'success',
      error_code TEXT,
      request_context TEXT NOT NULL DEFAULT '{}',
      duration_ms INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    )
  `);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_ai_usage_created ON ai_usage_ledger(created_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_ai_usage_project ON ai_usage_ledger(project_path, created_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_ai_usage_operation ON ai_usage_ledger(operation, created_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_ai_usage_model ON ai_usage_ledger(model, created_at)`);
}

// =============================================================================
// Persistence — Synchronous Writes
// =============================================================================

// Prepared statement cache per database instance to avoid re-compilation overhead.
const _insertStmtCache = new WeakMap<Database, ReturnType<Database["prepare"]>>();

function getInsertStmt(db: Database): ReturnType<Database["prepare"]> {
  let stmt = _insertStmtCache.get(db);
  if (stmt) return stmt;

  stmt = db.prepare(`
    INSERT OR IGNORE INTO ai_usage_ledger
      (idempotency_key, project_path, operation, provider, model,
       input_tokens, output_tokens, total_tokens, cached_tokens,
       cost_usd, status, error_code, request_context, duration_ms, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  _insertStmtCache.set(db, stmt);
  return stmt;
}

const _usageQueue: Array<{ db: Database; event: AiUsageEvent }> = [];
let _flushTimeout: ReturnType<typeof setTimeout> | null = null;
const FLUSH_INTERVAL_MS = 1000;
const MAX_QUEUE_SIZE = 100;

function scheduleFlush() {
  if (!_flushTimeout) {
    _flushTimeout = setTimeout(flushAiUsageQueue, FLUSH_INTERVAL_MS);
    if (_flushTimeout.unref) _flushTimeout.unref();
  }
}

export function flushAiUsageQueue() {
  if (_flushTimeout) {
    clearTimeout(_flushTimeout);
    _flushTimeout = null;
  }
  if (_usageQueue.length === 0) return;

  const dbGroups = new Map<Database, AiUsageEvent[]>();
  for (const item of _usageQueue) {
    const group = dbGroups.get(item.db) || [];
    group.push(item.event);
    dbGroups.set(item.db, group);
  }
  
  _usageQueue.length = 0;

  for (const [db, events] of dbGroups) {
    try {
      const stmt = getInsertStmt(db);
      const transaction = db.transaction((evs: AiUsageEvent[]) => {
        for (const ev of evs) {
          stmt.run(
            ev.idempotency_key,
            ev.project_path,
            ev.operation,
            ev.provider,
            ev.model,
            ev.input_tokens,
            ev.output_tokens,
            ev.total_tokens,
            ev.cached_tokens,
            ev.cost_usd,
            ev.status,
            ev.error_code,
            ev.request_context,
            ev.duration_ms,
            ev.created_at,
          );
        }
      });
      transaction(events);
    } catch (err) {
      process.stderr.write(`[kindx:ai-usage] ERROR: Failed to batch record usage: ${err}\n`);
    }
  }
}

// Ensure flush on exit
process.on('exit', flushAiUsageQueue);
process.on('SIGINT', () => { flushAiUsageQueue(); process.exit(0); });
process.on('SIGTERM', () => { flushAiUsageQueue(); process.exit(0); });

export function calculateCostUsd(model: string, inputTokens: number, outputTokens: number, cachedTokens: number = 0): number | null {
  const modelLower = model.toLowerCase();
  
  // Local models cost nothing
  if (modelLower.includes('llama') || modelLower.includes('qwen') || modelLower.includes('mistral') || modelLower.includes('phi')) {
    return 0.0;
  }
  
  let inputPricePerM = 0;
  let cachedInputPricePerM = 0;
  let outputPricePerM = 0;

  // 1. Google Gemini Pricing (Tiered by sequence length <= 128k vs > 128k)
  if (modelLower.includes('gemini-1.5-pro')) {
    if (inputTokens <= 128000) {
      inputPricePerM = 1.25;
      cachedInputPricePerM = 0.3125;
      outputPricePerM = 5.00;
    } else {
      inputPricePerM = 2.50;
      cachedInputPricePerM = 0.625;
      outputPricePerM = 10.00;
    }
  } else if (modelLower.includes('gemini-1.5-flash')) {
    if (inputTokens <= 128000) {
      inputPricePerM = 0.075;
      cachedInputPricePerM = 0.0375;
      outputPricePerM = 0.30;
    } else {
      inputPricePerM = 0.15;
      cachedInputPricePerM = 0.075;
      outputPricePerM = 0.60;
    }
  } 
  // 2. Anthropic Claude Pricing (Deep discounts for Cache Reads)
  else if (modelLower.includes('claude-3-5-sonnet') || modelLower.includes('claude-3.5-sonnet')) {
    inputPricePerM = 3.00;
    cachedInputPricePerM = 0.30; // 90% discount on cache read
    outputPricePerM = 15.00;
  } else if (modelLower.includes('claude-3-5-haiku') || modelLower.includes('claude-3.5-haiku')) {
    inputPricePerM = 1.00;
    cachedInputPricePerM = 0.10;
    outputPricePerM = 5.00;
  } else if (modelLower.includes('claude-3-opus')) {
    inputPricePerM = 15.00;
    cachedInputPricePerM = 1.50;
    outputPricePerM = 75.00;
  }
  // 3. OpenAI Pricing (50% discount for Cache Reads)
  else if (modelLower.includes('gpt-4o-mini')) {
    inputPricePerM = 0.150;
    cachedInputPricePerM = 0.075;
    outputPricePerM = 0.600;
  } else if (modelLower.includes('gpt-4o')) {
    inputPricePerM = 2.50;
    cachedInputPricePerM = 1.25;
    outputPricePerM = 10.00;
  } else if (modelLower.includes('o1-preview')) {
    inputPricePerM = 15.00;
    cachedInputPricePerM = 7.50;
    outputPricePerM = 60.00;
  } else if (modelLower.includes('o1-mini')) {
    inputPricePerM = 3.00;
    cachedInputPricePerM = 1.50;
    outputPricePerM = 12.00;
  }
  // 4. Embeddings
  else if (modelLower.includes('nomic-embed')) {
    return 0.0;
  } else if (modelLower.includes('embed')) {
    inputPricePerM = 0.02;
    cachedInputPricePerM = 0.02;
  }
  
  if (inputPricePerM === 0 && outputPricePerM === 0) {
    return null; // Unknown model
  }
  
  // Base input tokens exclude the tokens that were successfully read from cache.
  // Note: Anthropic Cache Writes are billed at 1.25x base. To avoid a schema migration
  // for a single provider edge case, we bill them at Base rate.
  const freshInputTokens = Math.max(0, inputTokens - cachedTokens);
  
  return (freshInputTokens / 1000000) * inputPricePerM 
       + (cachedTokens / 1000000) * cachedInputPricePerM 
       + (outputTokens / 1000000) * outputPricePerM;
}

/**
 * Record a single AI usage event to the ledger (asynchronous queue).
 */
export function recordAiUsage(db: Database, event: AiUsageEvent): void {
  if (event.cost_usd === null) {
    event.cost_usd = calculateCostUsd(event.model, event.input_tokens, event.output_tokens, event.cached_tokens);
  }
  
  _usageQueue.push({ db, event });
  
  if (_usageQueue.length >= MAX_QUEUE_SIZE) {
    flushAiUsageQueue();
  } else {
    scheduleFlush();
  }
}

// =============================================================================
// High-Level Wrapper — withUsageTracking
// =============================================================================

/**
 * Execute an AI operation and automatically record its usage to the ledger.
 *
 * The returned result type must extend `{ usage?: ModelUsage }`. If the result
 * includes usage metadata, it is extracted and persisted. If absent, zeros are
 * recorded with a structured warning.
 *
 * On failure, the error is recorded as a usage event with status='error' and
 * then re-thrown so callers see the original error.
 */
export async function withUsageTracking<T extends { usage?: ModelUsage }>(
  db: Database,
  opts: {
    operation: AiOperation;
    model: string;
    provider: AiProvider;
    projectPath?: string;
    context?: Record<string, unknown>;
  },
  fn: () => Promise<T>,
): Promise<T> {
  const key = randomUUID();
  const start = Date.now();
  const projectPath = opts.projectPath ?? "";

  let result: T;
  try {
    result = await fn();
  } catch (err) {
    // Record the failed attempt
    recordAiUsage(db, {
      idempotency_key: key,
      project_path: projectPath,
      operation: opts.operation,
      provider: opts.provider,
      model: opts.model,
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      cached_tokens: 0,
      cost_usd: null,
      status: "error",
      error_code: err instanceof Error ? err.message.slice(0, 200) : "unknown",
      request_context: JSON.stringify(opts.context ?? {}),
      duration_ms: Date.now() - start,
      created_at: new Date().toISOString(),
    });
    throw err;
  }

  const usage = result.usage;
  recordAiUsage(db, {
    idempotency_key: key,
    project_path: projectPath,
    operation: opts.operation,
    provider: opts.provider,
    model: opts.model,
    input_tokens: usage?.prompt_tokens ?? 0,
    output_tokens: usage?.completion_tokens ?? 0,
    total_tokens: usage?.total_tokens ?? 0,
    cached_tokens: usage?.cached_tokens ?? 0,
    cost_usd: null,
    status: "success",
    error_code: null,
    request_context: JSON.stringify(opts.context ?? {}),
    duration_ms: Date.now() - start,
    created_at: new Date().toISOString(),
  });

  return result;
}

/**
 * Record a usage event for a void operation (e.g., fire-and-forget calls where
 * the result doesn't carry usage metadata but the caller has token counts).
 */
export function recordDirectUsage(
  db: Database,
  opts: {
    operation: AiOperation;
    model: string;
    provider: AiProvider;
    usage: ModelUsage;
    durationMs: number;
    projectPath?: string;
    status?: AiCallStatus;
    errorCode?: string | null;
    context?: Record<string, unknown>;
  },
): void {
  recordAiUsage(db, {
    idempotency_key: randomUUID(),
    project_path: opts.projectPath ?? "",
    operation: opts.operation,
    provider: opts.provider,
    model: opts.model,
    input_tokens: opts.usage.prompt_tokens,
    output_tokens: opts.usage.completion_tokens,
    total_tokens: opts.usage.total_tokens,
    cached_tokens: opts.usage.cached_tokens ?? 0,
    cost_usd: null,
    status: opts.status ?? "success",
    error_code: opts.errorCode ?? null,
    request_context: JSON.stringify(opts.context ?? {}),
    duration_ms: opts.durationMs,
    created_at: new Date().toISOString(),
  });
}

// =============================================================================
// Read-Time Aggregation Queries
// =============================================================================

/**
 * Get aggregated usage summary for a project, or globally if no project specified.
 */
export function getAiUsageSummary(
  db: Database,
  projectPath?: string,
): AiUsageSummary {
  const sql = projectPath
    ? `SELECT
         COUNT(*) as total_calls,
         COALESCE(SUM(input_tokens), 0) as total_input_tokens,
         COALESCE(SUM(output_tokens), 0) as total_output_tokens,
         COALESCE(SUM(total_tokens), 0) as total_tokens,
         COALESCE(SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END), 0) as error_count,
         COALESCE(SUM(duration_ms), 0) as total_duration_ms,
         COUNT(DISTINCT model) as models_used
       FROM ai_usage_ledger
       WHERE project_path = ? OR project_path GLOB ?`
    : `SELECT
         COUNT(*) as total_calls,
         COALESCE(SUM(input_tokens), 0) as total_input_tokens,
         COALESCE(SUM(output_tokens), 0) as total_output_tokens,
         COALESCE(SUM(total_tokens), 0) as total_tokens,
         COALESCE(SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END), 0) as error_count,
         COALESCE(SUM(duration_ms), 0) as total_duration_ms,
         COUNT(DISTINCT model) as models_used
       FROM ai_usage_ledger`;

  const row = projectPath
    ? db.prepare(sql).get(projectPath, `${projectPath}/*`)
    : db.prepare(sql).get();

  return row as AiUsageSummary;
}

/**
 * Get per-operation breakdown of usage.
 */
export function getAiUsageByOperation(
  db: Database,
  projectPath?: string,
): AiUsageByOperation[] {
  const whereClause = projectPath
    ? "WHERE project_path = ? OR project_path GLOB ?"
    : "";
  const params = projectPath ? [projectPath, `${projectPath}/*`] : [];

  return db
    .prepare(
      `SELECT
         operation,
         COUNT(*) as call_count,
         COALESCE(SUM(total_tokens), 0) as total_tokens,
         COALESCE(SUM(duration_ms), 0) as total_duration_ms
       FROM ai_usage_ledger ${whereClause}
       GROUP BY operation
       ORDER BY total_tokens DESC`,
    )
    .all(...params) as AiUsageByOperation[];
}

/**
 * Cleanup usage records older than retentionDays.
 * Returns the number of deleted rows.
 */
export function cleanupAiUsage(db: Database, retentionDays: number = 90): number {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - retentionDays);

  const result = db
    .prepare(`DELETE FROM ai_usage_ledger WHERE created_at < ?`)
    .run(cutoff.toISOString());

  return result.changes;
}
