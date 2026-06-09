/**
 * specs/metrics.test.ts
 *
 * Unit tests for engine/utils/metrics.ts - Metrics collection.
 */

import { describe, test, expect } from "vitest";

describe("metrics", () => {
  describe("incCounter", () => {
    test("increments counter by 1", async () => {
      const { incCounter, renderPrometheusMetrics } = await import("../engine/utils/metrics.js");
      
      incCounter("test_counter");
      const metrics = renderPrometheusMetrics();
      expect(metrics).toContain("test_counter");
    });

    test("increments counter by custom value", async () => {
      const { incCounter, renderPrometheusMetrics } = await import("../engine/utils/metrics.js");
      
      incCounter("test_counter_2", 5);
      const metrics = renderPrometheusMetrics();
      expect(metrics).toContain("test_counter_2");
    });
  });

  describe("observeHistogram", () => {
    test("records histogram observation", async () => {
      const { observeHistogram, renderPrometheusMetrics } = await import("../engine/utils/metrics.js");
      
      observeHistogram("test_histogram", 0.5, [0.1, 0.5, 1.0]);
      const metrics = renderPrometheusMetrics();
      expect(metrics).toContain("test_histogram");
    });
  });

  describe("renderPrometheusMetrics", () => {
    test("returns string output", async () => {
      const { renderPrometheusMetrics } = await import("../engine/utils/metrics.js");
      
      const metrics = renderPrometheusMetrics();
      expect(typeof metrics).toBe("string");
    });

    test("includes extra gauges", async () => {
      const { renderPrometheusMetrics } = await import("../engine/utils/metrics.js");
      
      const metrics = renderPrometheusMetrics([
        { name: "test_gauge", value: 42 },
      ]);
      expect(metrics).toContain("test_gauge");
    });
  });
});
