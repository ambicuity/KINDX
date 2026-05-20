// Extracted from engine/repository.ts as part of W1 decomposition (C14).
// Document lookup, body retrieval, index status, snippet extraction, and the
// shared `withTimeout` helper used by orchestrators.
// Spec: docs/superpowers/specs/2026-05-20-kindx-strategic-refactor-program-design.md §5

import { resolve as pathResolve } from "path";
import type { Database } from "../../runtime.js";
import { CHUNK_SIZE_CHARS } from "../../chunker.js";
import {
  listCollections as collectionsListCollections,
} from "../../catalogs.js";
import { describeEncryptionState } from "../../encryption.js";
import { getShardRuntimeStatus, getAnnRuntimeStatus } from "../../sharding.js";
import type {
  DocumentResult,
  DocumentNotFound,
  IndexStatus,
  MultiGetResult,
  SnippetResult,
} from "../types.js";
import { homedir } from "../paths.js";
import { isDocid, findDocumentByDocid, findSimilarFiles } from "../docid.js";
import { getHashesNeedingEmbedding } from "../store-maintenance.js";
import { getIndexCapabilities } from "../store-maintenance.js";
import { getMainDatabasePath } from "../vec.js";
import { getDocid } from "../handelize.js";
// getContextForFile, toVirtualPath, matchFilesByGlob still live in engine/repository.ts.
import {
  getContextForFile,
  toVirtualPath,
  matchFilesByGlob,
  DEFAULT_MULTI_GET_MAX_BYTES,
} from "../../repository.js";

type DbDocRow = {
  virtual_path: string;
  display_path: string;
  title: string;
  hash: string;
  collection: string;
  path: string;
  modified_at: string;
  body_length: number;
  body?: string;
  ingest_format?: string;
  ingest_extractor?: string;
  ingest_warnings_json?: string;
};

export function hasDocumentIngestTable(db: Database): boolean {
  const row = db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type='table' AND name='document_ingest'
  `).get() as { name?: string } | undefined;
  return !!row?.name;
}

/**
 * Find a document by filename/path, docid (#hash), or with fuzzy matching.
 * Returns document metadata without body by default.
 *
 * Supports:
 * - Virtual paths: kindx://collection/path/to/file.md
 * - Absolute paths: /path/to/file.md
 * - Relative paths: path/to/file.md
 * - Short docid: #abc123 (first 6 chars of hash)
 */
export function findDocument(db: Database, filename: string, options: { includeBody?: boolean } = {}): DocumentResult | DocumentNotFound {
  let filepath = filename;
  const colonMatch = filepath.match(/:(\d+)$/);
  if (colonMatch) {
    filepath = filepath.slice(0, -colonMatch[0].length);
  }

  // Check if this is a docid lookup (#abc123, abc123, "#abc123", "abc123", etc.)
  if (isDocid(filepath)) {
    const docidMatch = findDocumentByDocid(db, filepath);
    if (docidMatch) {
      filepath = docidMatch.filepath;
    } else {
      return { error: "not_found", query: filename, similarFiles: [] };
    }
  }

  if (filepath.startsWith('~/')) {
    filepath = homedir() + filepath.slice(1);
  }

  const bodyCol = options.includeBody ? `, content.doc as body` : ``;
  const hasIngest = hasDocumentIngestTable(db);
  const ingestCols = hasIngest
    ? `, di.format as ingest_format, di.extractor as ingest_extractor, di.warnings_json as ingest_warnings_json`
    : ``;
  const ingestJoin = hasIngest
    ? `LEFT JOIN document_ingest di ON di.collection = d.collection AND di.path = d.path`
    : ``;

  // Build computed columns
  // Note: absoluteFilepath is computed from YAML collections after query
  const selectCols = `
    'kindx://' || d.collection || '/' || d.path as virtual_path,
    d.collection || '/' || d.path as display_path,
    d.title,
    d.hash,
    d.collection,
    d.path,
    d.modified_at,
    LENGTH(content.doc) as body_length
    ${ingestCols}
    ${bodyCol}
  `;

  // Try to match by virtual path first
  let doc = db.prepare(`
    SELECT ${selectCols}
    FROM documents d
    JOIN content ON content.hash = d.hash
    ${ingestJoin}
    WHERE 'kindx://' || d.collection || '/' || d.path = ? AND d.active = 1
  `).get(filepath) as DbDocRow | null;

  // Try fuzzy match by virtual path
  if (!doc) {
    // Tier-1 perf: try the index-friendly equivalence on `path` first so the
    // common case (user typed an exact relative path like `notes/foo.md`)
    // hits idx_documents_path instead of doing a full-table scan via the
    // leading-wildcard LIKE. Only fall back to the LIKE for partial inputs.
    doc = db.prepare(`
      SELECT ${selectCols}
      FROM documents d
      JOIN content ON content.hash = d.hash
      ${ingestJoin}
      WHERE d.path = ? AND d.active = 1
      LIMIT 1
    `).get(filepath) as DbDocRow | null;

    if (!doc) {
      doc = db.prepare(`
        SELECT ${selectCols}
        FROM documents d
        JOIN content ON content.hash = d.hash
        ${ingestJoin}
        WHERE 'kindx://' || d.collection || '/' || d.path LIKE ? AND d.active = 1
        LIMIT 1
      `).get(`%${filepath}`) as DbDocRow | null;
    }
  }

  // Try to match by absolute path or relative to CWD
  if (!doc && !filepath.startsWith('kindx://')) {
    const absolutePath = pathResolve(process.cwd(), filepath);
    const virtualP = toVirtualPath(db, absolutePath);
    if (virtualP) {
      doc = db.prepare(`
        SELECT ${selectCols}
        FROM documents d
        JOIN content ON content.hash = d.hash
        ${ingestJoin}
        WHERE 'kindx://' || d.collection || '/' || d.path = ? AND d.active = 1
      `).get(virtualP) as DbDocRow | null;
    }
  }

  // Try to match by absolute path (requires looking up collection paths from YAML)
  if (!doc && !filepath.startsWith('kindx://')) {
    const collections = collectionsListCollections();
    for (const coll of collections) {
      let relativePath: string | null = null;

      // If filepath is absolute and starts with collection path, extract relative part
      if (filepath.startsWith(coll.path + '/')) {
        relativePath = filepath.slice(coll.path.length + 1);
      }
      // Otherwise treat filepath as relative to collection
      else if (!filepath.startsWith('/')) {
        relativePath = filepath;
      }

      if (relativePath) {
        doc = db.prepare(`
          SELECT ${selectCols}
          FROM documents d
          JOIN content ON content.hash = d.hash
          ${ingestJoin}
          WHERE d.collection = ? AND d.path = ? AND d.active = 1
        `).get(coll.name, relativePath) as DbDocRow | null;
        if (doc) break;
      }
    }
  }

  if (!doc) {
    const similar = findSimilarFiles(db, filepath, 5, 5);
    return { error: "not_found", query: filename, similarFiles: similar };
  }

  // Get context using virtual path
  const virtualPath = doc.virtual_path || `kindx://${doc.collection}/${doc.display_path}`;
  const context = getContextForFile(db, virtualPath);

  return {
    filepath: virtualPath,
    displayPath: doc.display_path,
    title: doc.title,
    context,
    hash: doc.hash,
    docid: getDocid(doc.hash),
    collectionName: doc.collection,
    modifiedAt: doc.modified_at,
    bodyLength: doc.body_length,
    ...(options.includeBody && doc.body !== undefined && { body: doc.body }),
    ...((doc.ingest_format || doc.ingest_extractor || doc.ingest_warnings_json) && {
      extraction: {
        format: doc.ingest_format || "unknown",
        extractor: doc.ingest_extractor || "unknown",
        warnings: (() => {
          try {
            return JSON.parse(doc.ingest_warnings_json || "[]") as string[];
          } catch {
            return ["ingest_warning_parse_error"];
          }
        })(),
      },
    }),
  };
}

/**
 * Get the body content for a document
 * Optionally slice by line range
 */
export function getDocumentBody(db: Database, doc: DocumentResult | { filepath: string }, fromLine?: number, maxLines?: number): string | null {
  const filepath = doc.filepath;

  // Try to resolve document by filepath (absolute or virtual)
  let row: { body: string } | null = null;

  // Try virtual path first
  if (filepath.startsWith('kindx://')) {
    row = db.prepare(`
      SELECT content.doc as body
      FROM documents d
      JOIN content ON content.hash = d.hash
      WHERE 'kindx://' || d.collection || '/' || d.path = ? AND d.active = 1
    `).get(filepath) as { body: string } | null;
  }

  // Try absolute path by looking up in YAML collections
  if (!row) {
    const collections = collectionsListCollections();
    for (const coll of collections) {
      if (filepath.startsWith(coll.path + '/')) {
        const relativePath = filepath.slice(coll.path.length + 1);
        row = db.prepare(`
          SELECT content.doc as body
          FROM documents d
          JOIN content ON content.hash = d.hash
          WHERE d.collection = ? AND d.path = ? AND d.active = 1
        `).get(coll.name, relativePath) as { body: string } | null;
        if (row) break;
      }
    }
  }

  if (!row) return null;

  let body = row.body;
  if (fromLine !== undefined || maxLines !== undefined) {
    const lines = body.split('\n');
    const start = (fromLine || 1) - 1;
    const end = maxLines !== undefined ? start + maxLines : lines.length;
    body = lines.slice(start, end).join('\n');
  }

  return body;
}

/**
 * Find multiple documents by glob pattern or comma-separated list
 * Returns documents without body by default (use getDocumentBody to load)
 */
export function findDocuments(
  db: Database,
  pattern: string,
  options: { includeBody?: boolean; maxBytes?: number } = {}
): { docs: MultiGetResult[]; errors: string[] } {
  const isCommaSeparated = pattern.includes(',') && !pattern.includes('*') && !pattern.includes('?');
  const errors: string[] = [];
  const maxBytes = options.maxBytes ?? DEFAULT_MULTI_GET_MAX_BYTES;

  const bodyCol = options.includeBody ? `, content.doc as body` : ``;
  const hasIngest = hasDocumentIngestTable(db);
  const ingestCols = hasIngest
    ? `, di.format as ingest_format, di.extractor as ingest_extractor, di.warnings_json as ingest_warnings_json`
    : ``;
  const ingestJoin = hasIngest
    ? `LEFT JOIN document_ingest di ON di.collection = d.collection AND di.path = d.path`
    : ``;
  const selectCols = `
    'kindx://' || d.collection || '/' || d.path as virtual_path,
    d.collection || '/' || d.path as display_path,
    d.title,
    d.hash,
    d.collection,
    d.path,
    d.modified_at,
    LENGTH(content.doc) as body_length
    ${ingestCols}
    ${bodyCol}
  `;

  let fileRows: DbDocRow[];

  if (isCommaSeparated) {
    const names = pattern.split(',').map(s => s.trim()).filter(Boolean);
    fileRows = [];
    for (const name of names) {
      let doc = db.prepare(`
        SELECT ${selectCols}
        FROM documents d
        JOIN content ON content.hash = d.hash
        ${ingestJoin}
        WHERE 'kindx://' || d.collection || '/' || d.path = ? AND d.active = 1
      `).get(name) as DbDocRow | null;
      if (!doc) {
        doc = db.prepare(`
          SELECT ${selectCols}
          FROM documents d
          JOIN content ON content.hash = d.hash
          ${ingestJoin}
          WHERE 'kindx://' || d.collection || '/' || d.path LIKE ? AND d.active = 1
          LIMIT 1
        `).get(`%${name}`) as DbDocRow | null;
      }
      if (doc) {
        fileRows.push(doc);
      } else {
        const similar = findSimilarFiles(db, name, 5, 3);
        let msg = `File not found: ${name}`;
        if (similar.length > 0) {
          msg += ` (did you mean: ${similar.join(', ')}?)`;
        }
        errors.push(msg);
      }
    }
  } else {
    // Glob pattern match
    const matched = matchFilesByGlob(db, pattern);
    if (matched.length === 0) {
      errors.push(`No files matched pattern: ${pattern}`);
      return { docs: [], errors };
    }
    const virtualPaths = matched.map((m: { filepath: string }) => m.filepath);
    const placeholders = virtualPaths.map(() => '?').join(',');
    fileRows = db.prepare(`
      SELECT ${selectCols}
      FROM documents d
      JOIN content ON content.hash = d.hash
      ${ingestJoin}
      WHERE 'kindx://' || d.collection || '/' || d.path IN (${placeholders}) AND d.active = 1
    `).all(...virtualPaths) as DbDocRow[];
  }

  const results: MultiGetResult[] = [];

  for (const row of fileRows) {
    // Get context using virtual path
    const virtualPath = row.virtual_path || `kindx://${row.collection}/${row.display_path}`;
    const context = getContextForFile(db, virtualPath);

    if (row.body_length > maxBytes) {
      results.push({
        doc: { filepath: virtualPath, displayPath: row.display_path },
        skipped: true,
        skipReason: `File too large (${Math.round(row.body_length / 1024)}KB > ${Math.round(maxBytes / 1024)}KB)`,
      });
      continue;
    }

    results.push({
      doc: {
        filepath: virtualPath,
        displayPath: row.display_path,
        title: row.title || row.display_path.split('/').pop() || row.display_path,
        context,
        hash: row.hash,
        docid: getDocid(row.hash),
        collectionName: row.collection,
        modifiedAt: row.modified_at,
        bodyLength: row.body_length,
        ...(options.includeBody && row.body !== undefined && { body: row.body }),
        ...((row.ingest_format || row.ingest_extractor || row.ingest_warnings_json) && {
          extraction: {
            format: row.ingest_format || "unknown",
            extractor: row.ingest_extractor || "unknown",
            warnings: (() => {
              try {
                return JSON.parse(row.ingest_warnings_json || "[]") as string[];
              } catch {
                return ["ingest_warning_parse_error"];
              }
            })(),
          },
        }),
      },
      skipped: false,
    });
  }

  return { docs: results, errors };
}

export function getStatus(db: Database): IndexStatus {
  // Load collections from YAML
  const yamlCollections = collectionsListCollections();

  // Get document counts and last update times for each collection
  const collections = yamlCollections.map((col: { name: string; path: string; pattern: string }) => {
    const stats = db.prepare(`
      SELECT
        COUNT(*) as active_count,
        MAX(modified_at) as last_doc_update
      FROM documents
      WHERE collection = ? AND active = 1
    `).get(col.name) as { active_count: number; last_doc_update: string | null };

    return {
      name: col.name,
      path: col.path,
      pattern: col.pattern,
      documents: stats.active_count,
      lastUpdated: stats.last_doc_update || new Date().toISOString(),
    };
  });

  // Sort by last update time (most recent first)
  collections.sort((a: { lastUpdated: string }, b: { lastUpdated: string }) => {
    if (!a.lastUpdated) return 1;
    if (!b.lastUpdated) return -1;
    return new Date(b.lastUpdated).getTime() - new Date(a.lastUpdated).getTime();
  });

  const totalDocs = (db.prepare(`SELECT COUNT(*) as c FROM documents WHERE active = 1`).get() as { c: number }).c;
  const needsEmbedding = getHashesNeedingEmbedding(db);
  const hasVectors = !!db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='vectors_vec'`).get();
  const mainDbPath = getMainDatabasePath(db);
  const shardStatus = getShardRuntimeStatus(mainDbPath);
  const ann = getAnnRuntimeStatus(mainDbPath);
  const capabilities = getIndexCapabilities(db);
  const encryption = describeEncryptionState(mainDbPath);
  const hasIngest = hasDocumentIngestTable(db);
  const warnedDocuments = hasIngest
    ? (db.prepare(`
      SELECT COUNT(*) AS c
      FROM document_ingest
      WHERE warnings_json IS NOT NULL
        AND warnings_json != '[]'
        AND LENGTH(TRIM(warnings_json)) > 2
    `).get() as { c: number }).c
    : 0;
  const byFormat = hasIngest
    ? (db.prepare(`
      SELECT format, COUNT(*) AS count
      FROM document_ingest
      GROUP BY format
      ORDER BY count DESC, format ASC
    `).all() as Array<{ format: string; count: number }>)
    : [];
  const byWarning = hasIngest
    ? (db.prepare(`
      SELECT warning, COUNT(*) AS count
      FROM (
        SELECT TRIM(j.value) AS warning
        FROM document_ingest di, json_each(di.warnings_json) j
      )
      WHERE warning != ''
      GROUP BY warning
      ORDER BY count DESC, warning ASC
    `).all() as Array<{ warning: string; count: number }>)
    : [];

  return {
    totalDocuments: totalDocs,
    needsEmbedding,
    hasVectorIndex: hasVectors,
    capabilities,
    ann,
    encryption,
    ingestion: {
      warnedDocuments,
      byFormat,
      byWarning,
    },
    collections,
    shards: shardStatus,
  };
}

export function extractSnippet(body: string, query: string, maxLen = 500, chunkPos?: number, chunkLen?: number): SnippetResult {
  const totalLines = body.split('\n').length;
  let searchBody = body;
  let lineOffset = 0;

  if (chunkPos && chunkPos > 0) {
    // Search within the chunk region, with some padding for context
    // Use provided chunkLen or fall back to max chunk size (covers variable-length chunks)
    const searchLen = chunkLen || CHUNK_SIZE_CHARS;
    const contextStart = Math.max(0, chunkPos - 100);
    const contextEnd = Math.min(body.length, chunkPos + searchLen + 100);
    searchBody = body.slice(contextStart, contextEnd);
    if (contextStart > 0) {
      lineOffset = body.slice(0, contextStart).split('\n').length - 1;
    }
  }

  const lines = searchBody.split('\n');
  const queryTerms = query.toLowerCase().split(/\s+/).filter(t => t.length > 0);
  let bestLine = 0, bestScore = -1;

  for (let i = 0; i < lines.length; i++) {
    const lineLower = (lines[i] ?? "").toLowerCase();
    let score = 0;
    for (const term of queryTerms) {
      if (lineLower.includes(term)) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      bestLine = i;
    }
  }

  const start = Math.max(0, bestLine - 1);
  const end = Math.min(lines.length, bestLine + 3);
  const snippetLines = lines.slice(start, end);
  let snippetText = snippetLines.join('\n');

  // If we focused on a chunk window and it produced an empty/whitespace-only snippet,
  // fall back to a full-document snippet so we always show something useful.
  if (chunkPos && chunkPos > 0 && snippetText.trim().length === 0) {
    return extractSnippet(body, query, maxLen, undefined);
  }

  if (snippetText.length > maxLen) snippetText = snippetText.substring(0, maxLen - 3) + "...";

  const absoluteStart = lineOffset + start + 1; // 1-indexed
  const snippetLineCount = snippetLines.length;
  const linesBefore = absoluteStart - 1;
  const linesAfter = totalLines - (absoluteStart + snippetLineCount - 1);

  // Format with diff-style header: @@ -start,count @@ (linesBefore before, linesAfter after)
  const header = `@@ -${absoluteStart},${snippetLineCount} @@ (${linesBefore} before, ${linesAfter} after)`;
  const snippet = `${header}\n${snippetText}`;

  return {
    line: lineOffset + bestLine + 1,
    snippet,
    linesBefore,
    linesAfter,
    snippetLines: snippetLineCount,
  };
}

/**
 * Add line numbers to text content.
 * Each line becomes: "{lineNum}: {content}"
 */
export function addLineNumbers(text: string, startLine: number = 1): string {
  const lines = text.split('\n');
  return lines.map((line, i) => `${startLine + i}: ${line}`).join('\n');
}

export async function withTimeout<T>(task: Promise<T>, timeoutMs?: number): Promise<{ timedOut: boolean; value: T | null }> {
  if (!timeoutMs || timeoutMs <= 0) {
    return { timedOut: false, value: await task };
  }
  let timer: NodeJS.Timeout | null = null;
  const timeoutPromise = new Promise<{ timedOut: true; value: null }>((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true, value: null }), timeoutMs);
  });
  const value = await Promise.race([
    task.then((v) => ({ timedOut: false as const, value: v })),
    timeoutPromise,
  ]);
  if (timer) clearTimeout(timer);
  return value;
}
