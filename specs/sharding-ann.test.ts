import { describe, it, expect } from "vitest";
import { buildHnswIndex, searchHnsw, persistHnswIndex } from "../engine/sharding.js";
import type { HnswIndex, HnswNode } from "../engine/sharding.js";

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

  it("should persist HNSW index to database", () => {
    const vectors = [
      new Float32Array([1, 0, 0]),
      new Float32Array([0, 1, 0]),
      new Float32Array([0, 0, 1]),
      new Float32Array([0.7, 0.7, 0]),
    ];

    const index = buildHnswIndex(vectors, 3, { M: 2, ef: 4 });
    const hashSeqs = ["doc1_0", "doc1_1", "doc1_2", "doc1_3"];

    // Mock database for testing persistence
    const mockDb = {
      exec: (sql: string) => {},
      prepare: (sql: string) => ({
        run: (...args: any[]) => {},
        get: (...args: any[]) => undefined,
        all: (...args: any[]) => [],
      }),
    };

    // Verify persistHnswIndex doesn't throw
    expect(() => persistHnswIndex(mockDb as any, index, hashSeqs)).not.toThrow();
  });

  it("should store correct node structure in database", () => {
    const vectors = [
      new Float32Array([1, 0, 0]),
      new Float32Array([0, 1, 0]),
      new Float32Array([0, 0, 1]),
    ];

    const index = buildHnswIndex(vectors, 3, { M: 2, ef: 4 });
    const hashSeqs = ["a_0", "b_0", "c_0"];

    const insertedNodes: Array<{ id: number; level: number; neighbor_ids: string; vector_id: string }> = [];
    const insertedEdges: Array<{ node_id: number; neighbor_id: number; level: number }> = [];

    const mockDb = {
      exec: (sql: string) => {},
      prepare: (sql: string) => ({
        run: (...args: any[]) => {
          if (sql.includes("ann_hnsw_nodes")) {
            insertedNodes.push({ id: args[0], level: args[1], neighbor_ids: args[2], vector_id: args[3] });
          } else if (sql.includes("ann_hnsw_edges")) {
            insertedEdges.push({ node_id: args[0], neighbor_id: args[1], level: args[2] });
          }
        },
      }),
    };

    persistHnswIndex(mockDb as any, index, hashSeqs);

    expect(insertedNodes).toHaveLength(3);
    expect(insertedNodes[0].vector_id).toBe("a_0");
    expect(insertedNodes[1].vector_id).toBe("b_0");
    expect(insertedNodes[2].vector_id).toBe("c_0");
    expect(insertedEdges.length).toBeGreaterThan(0);
  });

  it("should handle empty vectors in HNSW index", () => {
    const vectors: Float32Array[] = [];
    const index = buildHnswIndex(vectors, 3, { M: 2, ef: 4 });

    expect(index.nodes).toHaveLength(0);

    const query = new Float32Array([1, 0, 0]);
    const results = searchHnsw(index, query, 2);
    expect(results).toHaveLength(0);
  });
});
