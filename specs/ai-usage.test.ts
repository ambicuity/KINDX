/**
 * specs/ai-usage.test.ts
 *
 * Unit tests for engine/ai-usage.ts - AI usage ledger.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { openDatabase } from "../engine/runtime.js";
import type { Database } from "../engine/runtime.js";
import {
  initializeAiUsageSchema,
  recordAiUsage,
  flushAiUsageQueue,
  calculateCostUsd,
  getAiUsageSummary,
  getAiUsageByOperation,
  cleanupAiUsage,
  type AiUsageEvent,
} from "../engine/ai-usage.js";

describe("ai-usage", () => {
  let db: Database;

  beforeEach(() => {
    db = openDatabase(":memory:");
    initializeAiUsageSchema(db);
  });

  afterEach(() => {
    flushAiUsageQueue();
    db.close();
  });

  describe("initializeAiUsageSchema", () => {
    test("creates ai_usage_ledger table", () => {
      const tables = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='ai_usage_ledger'"
      ).all();
      expect(tables).toHaveLength(1);
    });

    test("creates indexes", () => {
      const indexes = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='ai_usage_ledger'"
      ).all();
      const indexNames = indexes.map((i: any) => i.name);
      expect(indexNames).toContain("idx_ai_usage_created");
      expect(indexNames).toContain("idx_ai_usage_project");
      expect(indexNames).toContain("idx_ai_usage_operation");
      expect(indexNames).toContain("idx_ai_usage_model");
    });

    test("is idempotent", () => {
      expect(() => initializeAiUsageSchema(db)).not.toThrow();
    });
  });

  describe("calculateCostUsd", () => {
    test("returns 0 for local models", () => {
      expect(calculateCostUsd("llama-3", 1000, 500)).toBe(0.0);
      expect(calculateCostUsd("qwen-2.5", 1000, 500)).toBe(0.0);
      expect(calculateCostUsd("mistral-7b", 1000, 500)).toBe(0.0);
      expect(calculateCostUsd("phi-3", 1000, 500)).toBe(0.0);
    });

    test("returns 0 for embedding models", () => {
      expect(calculateCostUsd("nomic-embed-text", 1000, 0)).toBe(0.0);
    });

    test("returns null for unknown models", () => {
      expect(calculateCostUsd("unknown-model", 1000, 500)).toBeNull();
    });

    test("calculates cost for GPT-4o", () => {
      const cost = calculateCostUsd("gpt-4o", 1000000, 1000000);
      expect(cost).toBeGreaterThan(0);
    });

    test("applies cache discount", () => {
      const costNoCache = calculateCostUsd("gpt-4o", 1000000, 1000000, 0);
      const costWithCache = calculateCostUsd("gpt-4o", 1000000, 1000000, 500000);
      expect(costWithCache).toBeLessThan(costNoCache);
    });
  });

  describe("recordAiUsage", () => {
    test("records usage event to ledger", () => {
      const event: AiUsageEvent = {
        idempotency_key: "test-key-1",
        project_path: "/test",
        operation: "embed",
        provider: "llama_cpp",
        model: "nomic-embed-text",
        input_tokens: 100,
        output_tokens: 0,
        total_tokens: 100,
        cached_tokens: 0,
        cost_usd: 0,
        status: "success",
        error_code: null,
        request_context: "{}",
        duration_ms: 50,
        created_at: new Date().toISOString(),
      };

      recordAiUsage(db, event);
      flushAiUsageQueue();

      const rows = db.prepare("SELECT * FROM ai_usage_ledger").all();
      expect(rows).toHaveLength(1);
    });

    test("deduplicates by idempotency key", () => {
      const event: AiUsageEvent = {
        idempotency_key: "test-key-dup",
        project_path: "/test",
        operation: "embed",
        provider: "llama_cpp",
        model: "nomic-embed-text",
        input_tokens: 100,
        output_tokens: 0,
        total_tokens: 100,
        cached_tokens: 0,
        cost_usd: 0,
        status: "success",
        error_code: null,
        request_context: "{}",
        duration_ms: 50,
        created_at: new Date().toISOString(),
      };

      recordAiUsage(db, event);
      recordAiUsage(db, event);
      flushAiUsageQueue();

      const rows = db.prepare("SELECT * FROM ai_usage_ledger").all();
      expect(rows).toHaveLength(1);
    });
  });

  describe("getAiUsageSummary", () => {
    test("returns zero counts for empty ledger", () => {
      const summary = getAiUsageSummary(db);
      expect(summary.total_calls).toBe(0);
      expect(summary.total_tokens).toBe(0);
    });

    test("aggregates usage correctly", () => {
      const event: AiUsageEvent = {
        idempotency_key: "test-key-agg",
        project_path: "/test",
        operation: "embed",
        provider: "llama_cpp",
        model: "nomic-embed-text",
        input_tokens: 100,
        output_tokens: 50,
        total_tokens: 150,
        cached_tokens: 0,
        cost_usd: 0,
        status: "success",
        error_code: null,
        request_context: "{}",
        duration_ms: 50,
        created_at: new Date().toISOString(),
      };

      recordAiUsage(db, event);
      flushAiUsageQueue();

      const summary = getAiUsageSummary(db);
      expect(summary.total_calls).toBe(1);
      expect(summary.total_tokens).toBe(150);
    });
  });

  describe("getAiUsageByOperation", () => {
    test("returns empty array for empty ledger", () => {
      const ops = getAiUsageByOperation(db);
      expect(ops).toEqual([]);
    });

    test("groups by operation", () => {
      const events: AiUsageEvent[] = [
        {
          idempotency_key: "op-1",
          project_path: "/test",
          operation: "embed",
          provider: "llama_cpp",
          model: "nomic-embed-text",
          input_tokens: 100,
          output_tokens: 0,
          total_tokens: 100,
          cached_tokens: 0,
          cost_usd: 0,
          status: "success",
          error_code: null,
          request_context: "{}",
          duration_ms: 50,
          created_at: new Date().toISOString(),
        },
        {
          idempotency_key: "op-2",
          project_path: "/test",
          operation: "generate",
          provider: "remote_openai",
          model: "gpt-4o",
          input_tokens: 200,
          output_tokens: 100,
          total_tokens: 300,
          cached_tokens: 0,
          cost_usd: 0.01,
          status: "success",
          error_code: null,
          request_context: "{}",
          duration_ms: 500,
          created_at: new Date().toISOString(),
        },
      ];

      for (const event of events) {
        recordAiUsage(db, event);
      }
      flushAiUsageQueue();

      const ops = getAiUsageByOperation(db);
      expect(ops).toHaveLength(2);
      expect(ops.map(o => o.operation)).toContain("embed");
      expect(ops.map(o => o.operation)).toContain("generate");
    });
  });

  describe("cleanupAiUsage", () => {
    test("deletes old records", () => {
      const event: AiUsageEvent = {
        idempotency_key: "old-key",
        project_path: "/test",
        operation: "embed",
        provider: "llama_cpp",
        model: "nomic-embed-text",
        input_tokens: 100,
        output_tokens: 0,
        total_tokens: 100,
        cached_tokens: 0,
        cost_usd: 0,
        status: "success",
        error_code: null,
        request_context: "{}",
        duration_ms: 50,
        created_at: new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString(),
      };

      recordAiUsage(db, event);
      flushAiUsageQueue();

      const deleted = cleanupAiUsage(db, 90);
      expect(deleted).toBe(1);
    });

    test("keeps recent records", () => {
      const event: AiUsageEvent = {
        idempotency_key: "recent-key",
        project_path: "/test",
        operation: "embed",
        provider: "llama_cpp",
        model: "nomic-embed-text",
        input_tokens: 100,
        output_tokens: 0,
        total_tokens: 100,
        cached_tokens: 0,
        cost_usd: 0,
        status: "success",
        error_code: null,
        request_context: "{}",
        duration_ms: 50,
        created_at: new Date().toISOString(),
      };

      recordAiUsage(db, event);
      flushAiUsageQueue();

      const deleted = cleanupAiUsage(db, 90);
      expect(deleted).toBe(0);
    });
  });
});
