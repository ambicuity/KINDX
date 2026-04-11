# KINDX Multi-Tenancy Design Specification

## Overview
As KINDX scales from individual engineer utility to enterprise autonomous agent infrastructure, isolation guarantees become paramount. A multi-agent framework orchestrating parallel development streams must ensure that an agent operating in "Tenant A" (e.g., Project X) has zero mathematical probability of retrieving semantic or lexical context from "Tenant B" (e.g., Project Y).

This document outlines the architectural approach for enforcing strict multi-tenancy in KINDX at the engine layer, specifically focusing on collection-level logical isolation and file-level physical isolation.

## Current Architecture Limitations
Currently, KINDX heavily relies on a single, global SQLite database located by default at `~/.config/kindx/index.sqlite`. 
While the `documents` table has a `collection` column, and the `documents_fts` virtual table tracks the collection path implicitly via the `filepath` prefix (`collection_name/path`), all data resides in the same physical file and the same memory space during execution.

## Proposed Multi-Tenancy Architectures

### Tier 1: Logical Isolation (Row-Level Strict Boundary)
For environments where agents are trusted but contexts simply need segregation to prevent hallucination cross-contamination.

**Implementation**:
1. **Mandatory Query Scoping**: The search engine (`repository.ts`) must enforce the `collectionName` parameter on every `searchFTS` and `searchVec` invocation at the SQL level.
2. **Schema Update**:
   - `documents_fts`: Introduce unindexed metadata columns if using newer SQLite FTS5 features, or prepend the collection name reliably to the FTS fields for precise row-filtering. Fast collection lookups in FTS5 can be achieved by writing the collection explicitly as a tokenized column and filtering via `collection:tenant_id`.
   - `vectors_vec` (`sqlite-vec`): The current schema (`hash_seq TEXT PRIMARY KEY`) is agnostic to collections. The index connects `documents.hash` -> `content_vectors` -> `vectors_vec`. To isolate vector search, we must filter candidate vectors *before* the k-NN search, or push the collection filter into the `sqlite-vec` custom query planner. 
   - *Challenge*: `sqlite-vec` distance metrics are notoriously difficult to pre-filter quickly in early versions.

### Tier 2: Physical Isolation (Database-per-Tenant)
For enterprise zero-trust environments where agents may belong to different security classifications or distinct external clients.

**Implementation**:
1. **Dynamic Database Routing**: Instead of relying on a singleton `~/.config/kindx/index.sqlite`, instantiate `Store` with explicit path variables derived from the tenant context:
   `/var/kindx/tenants/{tenant_id}/index.sqlite`
2. **Process Segregation**: When `kindx watch` or `kindx serve` is invoked, it accepts a `--tenant-dir` argument. The entire virtual index, YAML configuration, and SQLite WAL are fully sandboxed.
3. **Encryption at Rest**: Leverage `SQLCipher` plugin for SQLite. The KINDX engine will require a `KINDX_ENCRYPTION_KEY` environment variable. At instantiation, the database executes `PRAGMA key = '...';` ensuring that a rogue agent escaping its container boundaries cannot read another tenant's `.sqlite` file from disk.

## Phased Rollout Plan

**Phase A (Immediate - Logical Isolation Polish)**
- Standardize the CLI `collection` flag to represent logical tenant workspaces.
- Ensure all MCP (Model Context Protocol) tools strictly require and enforce collection boundaries during query expansion and retrieval.

**Phase B (Enterprise Drop - Physical Isolation)**
- Implement the `--workspace` / `--tenant-dir` CLI root override pointing to isolated SQLite files.
- Document the build configuration required to statically link `SQLCipher` alongside `sqlite-vec`.

## Summary
For the immediate go-to-market motion, KINDX will promote **Physical Isolation via Workspace Overrides** as its primary multi-tenancy story. True multi-tenancy for autonomous agents is best solved by assigning an isolated SQLite file to each agentic container, eliminating the overhead of complex Row-Level Security and maximizing vector search throughput natively.
