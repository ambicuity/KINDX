/**
 * specs/ir-metrics.test.ts
 *
 * Unit tests for engine/ir-metrics.ts - Information Retrieval evaluation metrics.
 */

import { describe, test, expect } from "vitest";
import {
  firstRelevantRank,
  hitAtK,
  mrrAtK,
  dcgAtK,
  ndcgAtK,
  precisionAtK,
  recallAtK,
  averagePrecisionAtK,
  computeEvaluationReport,
  type RelevanceJudgments,
} from "../engine/ir-metrics.js";

describe("ir-metrics", () => {
  const relevance: RelevanceJudgments = {
    "doc-a.md": 3,
    "doc-b.md": 2,
    "doc-c.md": 1,
  };

  describe("firstRelevantRank", () => {
    test("returns rank of first relevant document", () => {
      const results = ["other.md", "doc-a.md", "doc-b.md"];
      expect(firstRelevantRank(results, relevance)).toBe(2);
    });

    test("returns null when no relevant document found", () => {
      const results = ["other.md", "another.md"];
      expect(firstRelevantRank(results, relevance)).toBeNull();
    });

    test("respects k parameter", () => {
      const results = ["other.md", "other2.md", "doc-a.md"];
      expect(firstRelevantRank(results, relevance, 2)).toBeNull();
    });

    test("handles case-insensitive matching", () => {
      const results = ["DOC-A.md"];
      expect(firstRelevantRank(results, relevance)).toBe(1);
    });
  });

  describe("hitAtK", () => {
    test("returns 1 when relevant document in top-k", () => {
      const results = ["doc-a.md", "other.md"];
      expect(hitAtK(results, relevance, 3)).toBe(1);
    });

    test("returns 0 when no relevant document in top-k", () => {
      const results = ["other.md", "another.md"];
      expect(hitAtK(results, relevance, 3)).toBe(0);
    });
  });

  describe("mrrAtK", () => {
    test("returns reciprocal rank of first relevant", () => {
      const results = ["other.md", "doc-a.md"];
      expect(mrrAtK(results, relevance, 5)).toBe(0.5);
    });

    test("returns 0 when no relevant in top-k", () => {
      const results = ["other.md", "another.md"];
      expect(mrrAtK(results, relevance, 5)).toBe(0);
    });

    test("returns 1 when first result is relevant", () => {
      const results = ["doc-a.md", "other.md"];
      expect(mrrAtK(results, relevance, 5)).toBe(1);
    });
  });

  describe("dcgAtK", () => {
    test("calculates DCG correctly", () => {
      const results = ["doc-a.md", "doc-b.md", "other.md"];
      const dcg = dcgAtK(results, relevance, 3);
      expect(dcg).toBeGreaterThan(0);
    });

    test("returns 0 for empty results", () => {
      expect(dcgAtK([], relevance, 3)).toBe(0);
    });
  });

  describe("ndcgAtK", () => {
    test("returns 1 for perfect ranking", () => {
      const results = ["doc-a.md", "doc-b.md", "doc-c.md"];
      const ndcg = ndcgAtK(results, relevance, 3);
      expect(ndcg).toBeCloseTo(1.0, 5);
    });

    test("returns 0 when no relevant documents", () => {
      const results = ["other.md", "another.md"];
      const emptyRelevance: RelevanceJudgments = {};
      expect(ndcgAtK(results, emptyRelevance, 3)).toBe(0);
    });

    test("returns value between 0 and 1", () => {
      const results = ["doc-b.md", "other.md", "doc-a.md"];
      const ndcg = ndcgAtK(results, relevance, 3);
      expect(ndcg).toBeGreaterThanOrEqual(0);
      expect(ndcg).toBeLessThanOrEqual(1);
    });
  });

  describe("precisionAtK", () => {
    test("calculates precision correctly", () => {
      const results = ["doc-a.md", "other.md", "doc-b.md"];
      expect(precisionAtK(results, relevance, 3)).toBeCloseTo(2 / 3, 5);
    });

    test("returns 0 for empty results", () => {
      expect(precisionAtK([], relevance, 3)).toBe(0);
    });

    test("returns 1 when all results relevant", () => {
      const results = ["doc-a.md", "doc-b.md"];
      expect(precisionAtK(results, relevance, 2)).toBe(1);
    });
  });

  describe("recallAtK", () => {
    test("calculates recall correctly", () => {
      const results = ["doc-a.md", "other.md", "doc-b.md"];
      expect(recallAtK(results, relevance, 3)).toBeCloseTo(2 / 3, 5);
    });

    test("returns 0 for empty results", () => {
      expect(recallAtK([], relevance, 3)).toBe(0);
    });

    test("returns 1 when all relevant found", () => {
      const results = ["doc-a.md", "doc-b.md", "doc-c.md"];
      expect(recallAtK(results, relevance, 3)).toBe(1);
    });
  });

  describe("averagePrecisionAtK", () => {
    test("calculates AP correctly", () => {
      const results = ["doc-a.md", "other.md", "doc-b.md"];
      const ap = averagePrecisionAtK(results, relevance, 3);
      expect(ap).toBeGreaterThan(0);
    });

    test("returns 0 for empty results", () => {
      expect(averagePrecisionAtK([], relevance, 3)).toBe(0);
    });

    test("returns 0 when no relevant documents", () => {
      const results = ["other.md", "another.md"];
      const emptyRelevance: RelevanceJudgments = {};
      expect(averagePrecisionAtK(results, emptyRelevance, 3)).toBe(0);
    });
  });

  describe("computeEvaluationReport", () => {
    test("computes aggregate metrics", () => {
      const queryResults: Array<{ results: string[]; relevance: Record<string, number> }> = [
        { results: ["doc-a.md", "other.md"], relevance: { "doc-a.md": 3 } },
        { results: ["other.md", "doc-b.md"], relevance: { "doc-b.md": 2 } },
      ];

      const report = computeEvaluationReport(queryResults);
      expect(report.queryCount).toBe(2);
      expect(report.hitAt3).toBeGreaterThan(0);
      expect(report.mrrAt5).toBeGreaterThan(0);
    });

    test("handles empty query results", () => {
      const report = computeEvaluationReport([]);
      expect(report.queryCount).toBe(0);
      expect(report.hitAt3).toBe(0);
    });
  });
});
