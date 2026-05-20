// Public surface barrel for engine/repository.
// As clusters land, they add `export * from "./<file>.js"` here.
//
// During the migration window, engine/repository.ts also re-exports
// from this barrel via `export * from "./repository/index.js"`.
//
// Spec: docs/superpowers/specs/2026-05-20-kindx-strategic-refactor-program-design.md §5

export * from "./paths.js";
