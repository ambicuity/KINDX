// Public surface barrel for engine/repository.
// As clusters land, they add `export * from "./<file>.js"` here.
//
// During the migration window, engine/repository.ts also re-exports
// from this barrel via `export * from "./repository/index.js"`.
//
// Spec: docs/superpowers/specs/2026-05-20-kindx-strategic-refactor-program-design.md §5

export * from "./paths.js";
export * from "./llm-cache.js";
export * from "./docid.js";
export * from "./rerank-queue.js";
export * from "./chunking.js";
export * from "./fts.js";
export * from "./collections.js";
export * from "./context-annotations.js";
export * from "./content.js";
export * from "./indexing.js";
export * from "./vec.js";
export type * from "./types.js";
