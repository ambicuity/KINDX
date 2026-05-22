import { describe, it, expect } from "vitest";
import { buildHnswIndex, searchHnsw } from "../engine/sharding.js";

describe("HNSW Index", () => {
  it("should build HNSW index from vectors", () => {
    const vectors = [
      new Float32Array([1, 0, 0]),
      new Float32Array([0, 1, 0]),
      new Float32Array([0, 0, 1]),
      new Float32Array([0.7, 0.7, 0]),
    ];

    const index = buildHnswIndex(vectors, 3, { M: 2, ef: 4 });

    expect(index.nodes).toHaveLength(4);
    expect(index.entryPoint).toBeGreaterThanOrEqual(0);
  });

  it("should find nearest neighbors", () => {
    const vectors = [
      new Float32Array([1, 0, 0]),
      new Float32Array([0, 1, 0]),
      new Float32Array([0, 0, 1]),
      new Float32Array([0.7, 0.7, 0]),
    ];

    const index = buildHnswIndex(vectors, 3, { M: 2, ef: 4 });
    const query = new Float32Array([0.9, 0.1, 0]);
    const results = searchHnsw(index, query, 2);

    expect(results).toHaveLength(2);
    expect(results[0].id).toBe(0); // [1,0,0] is closest
  });
});
