import type { Database } from "./runtime.js";
import { withLLMSession, formatDocForEmbedding, formatQueryForEmbedding } from "./inference.js";

const MEMORY_SCHEMA_VERSION = "1";
const DEFAULT_SCOPE = "default";
const DEFAULT_SEMANTIC_THRESHOLD = 0.92;

const SINGLE_CARDINALITY_KEYS = new Set([
  "first_name",
  "last_name",
  "full_name",
  "date_of_birth",
  "gender",
  "job_title",
  "card_holder_name",
]);

export type MemoryRecord = {
  id: number;
  scope: string;
  key: string;
  value: string;
  confidence: number;
  source: string | null;
  appearedCount: number;
  accessedCount: number;
  createdAt: string | null;
  lastAppearedAt: string | null;
  lastAccessedAt: string | null;
  supersededBy: number | null;
  supersededAt: string | null;
  searchText: string | null;
};

export type MemorySearchResult = {
  id: number;
  scope: string;
  key: string;
  value: string;
  source: string | null;
  appearedCount: number;
  accessedCount: number;
  similarity?: number;
  hitRate?: number;
  score?: number;
};

export type MemoryHistoryItem = {
  id: number;
  scope: string;
  key: string;
  value: string;
  confidence: number;
  source: string | null;
  createdAt: string | null;
  supersededBy: number | null;
  supersededAt: string | null;
};

export type MemoryStats = {
  scope: string;
  totalMemories: number;
  superseded: number;
  links: number;
  embedded: number;
  byTag: Record<string, number>;
  topAccessed: { key: string; value: string; accessed: number }[];
};

export type UpsertMemoryInput = {
  scope?: string;
  key: string;
  value: string;
  tags?: string[];
  source?: string;
  confidence?: number;
  semanticThreshold?: number;
  precomputedVector?: number[];
  disableSemanticDedup?: boolean;
};

export type MemoryScopeResolution = {
  scope: string;
  source: "explicit" | "session" | "workspace" | "default";
  error?: {
    code: "cross_scope_forbidden";
    message: string;
  };
};

function nowIso(): string {
  return new Date().toISOString();
}

function withTransaction<T>(db: Database, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const value = fn();
    db.exec("COMMIT");
    return value;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Ignore rollback errors and preserve the original error.
    }
    throw error;
  }
}

function normalizeScope(scope?: string): string {
  const s = (scope || "").trim();
  return s.length > 0 ? s : DEFAULT_SCOPE;
}

function normalizeScopeOrUndefined(scope?: string | null): string | undefined {
  if (typeof scope !== "string") return undefined;
  const s = scope.trim();
  return s.length > 0 ? s : undefined;
}

function sanitizeScopeSegment(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function deriveWorkspaceMemoryScope(workspaceUri?: string | null): string | undefined {
  const raw = normalizeScopeOrUndefined(workspaceUri);
  if (!raw) return undefined;

  let basename = raw;
  try {
    if (raw.includes("://")) {
      const parsed = new URL(raw);
      if (parsed.protocol === "file:") {
        const path = decodeURIComponent(parsed.pathname || "");
        const segments = path.split("/").filter(Boolean);
        basename = segments[segments.length - 1] || "";
      } else {
        const host = parsed.hostname || "";
        const pathSegments = (parsed.pathname || "").split("/").filter(Boolean);
        basename = pathSegments[pathSegments.length - 1] || host || raw;
      }
    } else {
      const segments = raw.split(/[\\/]/).filter(Boolean);
      basename = segments[segments.length - 1] || raw;
    }
  } catch {
    const segments = raw.split(/[\\/]/).filter(Boolean);
    basename = segments[segments.length - 1] || raw;
  }

  const cleaned = sanitizeScopeSegment(basename);
  return cleaned.length > 0 ? cleaned : DEFAULT_SCOPE;
}

export function resolveMemoryScope(input: {
  explicitScope?: unknown;
  sessionScope?: string | null;
  workspaceScope?: string | null;
  strictIsolation?: boolean;
}): MemoryScopeResolution {
  const explicit = normalizeScopeOrUndefined(typeof input.explicitScope === "string" ? input.explicitScope : undefined);
  const session = normalizeScopeOrUndefined(input.sessionScope);
  const workspace = normalizeScopeOrUndefined(input.workspaceScope);
  const strictIsolation = input.strictIsolation === true;

  if (explicit && strictIsolation && (session || workspace)) {
    const allowed = session || workspace;
    if (allowed && explicit !== allowed) {
      return {
        scope: explicit,
        source: "explicit",
        error: {
          code: "cross_scope_forbidden",
          message: `Explicit scope '${explicit}' is not allowed for this session (allowed scope: '${allowed}').`,
        },
      };
    }
  }

  if (explicit) return { scope: explicit, source: "explicit" };
  if (session) return { scope: session, source: "session" };
  if (workspace) return { scope: workspace, source: "workspace" };
  return { scope: DEFAULT_SCOPE, source: "default" };
}

function keyPrefix(key: string): string {
  const idx = key.indexOf(":");
  return idx >= 0 ? key.slice(0, idx) : key;
}

function normalizeTags(tags?: string[]): string[] {
  if (!tags || tags.length === 0) return [];
  const out = new Set<string>();
  for (const tag of tags) {
    const t = (tag || "").trim();
    if (t.length > 0) out.add(t);
  }
  return [...out];
}

function toMemoryRecord(row: any): MemoryRecord {
  return {
    id: Number(row.id),
    scope: String(row.scope),
    key: String(row.key),
    value: String(row.value),
    confidence: Number(row.confidence ?? 1),
    source: row.source ?? null,
    appearedCount: Number(row.appeared_count ?? 0),
    accessedCount: Number(row.accessed_count ?? 0),
    createdAt: row.created_at ?? null,
    lastAppearedAt: row.last_appeared_at ?? null,
    lastAccessedAt: row.last_accessed_at ?? null,
    supersededBy: row.superseded_by == null ? null : Number(row.superseded_by),
    supersededAt: row.superseded_at ?? null,
    searchText: row.search_text ?? null,
  };
}

function normalizeVector(values: number[] | Float32Array): Float32Array {
  const vec = values instanceof Float32Array ? values : new Float32Array(values);
  let sumSquares = 0;
  for (let i = 0; i < vec.length; i += 1) {
    const v = vec[i] ?? 0;
    sumSquares += v * v;
  }
  const norm = Math.sqrt(sumSquares);
  if (!Number.isFinite(norm) || norm <= 0) {
    return vec;
  }
  const out = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i += 1) {
    out[i] = (vec[i] ?? 0) / norm;
  }
  return out;
}

function serializeVector(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

function deserializeVector(blob: Buffer | Uint8Array): Float32Array {
  const buf = blob instanceof Buffer ? blob : Buffer.from(blob);
  const arr = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
  return new Float32Array(arr);
}

function cosineSimilarityNormalized(a: Float32Array, b: Float32Array): number {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < len; i += 1) {
    dot += (a[i] ?? 0) * (b[i] ?? 0);
  }
  return dot;
}

function getSemanticCandidates(db: Database, scope: string, prefix: string): { id: number; key: string; embedding: Float32Array }[] {
  const rows = db.prepare(`
    SELECT m.id, m.key, e.embedding
    FROM memories m
    JOIN memory_embeddings e ON e.memory_id = m.id
    WHERE m.scope = ? AND m.superseded_by IS NULL
  `).all(scope) as { id: number; key: string; embedding: Buffer }[];

  return rows
    .filter((row) => keyPrefix(String(row.key)) === prefix)
    .map((row) => ({
      id: Number(row.id),
      key: String(row.key),
      embedding: deserializeVector(row.embedding),
    }));
}

function incrementCounters(db: Database, ids: number[]): void {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => "?").join(",");
  const now = nowIso();
  db.prepare(`
    UPDATE memories
    SET appeared_count = appeared_count + 1,
        accessed_count = accessed_count + 1,
        last_appeared_at = ?,
        last_accessed_at = ?
    WHERE id IN (${placeholders})
  `).run(now, now, ...ids);
}

function ensureTags(db: Database, memoryId: number, tags: string[]): void {
  for (const tag of tags) {
    db.prepare(`
      INSERT OR IGNORE INTO memory_tags (memory_id, tag)
      VALUES (?, ?)
    `).run(memoryId, tag);
  }
}

function mergeSource(existingSource: string | null, incomingSource?: string): string | null {
  const oldSource = (existingSource || "").trim();
  const nextSource = (incomingSource || "").trim();
  if (!nextSource) return oldSource || null;
  if (!oldSource) return nextSource;
  if (oldSource.split(",").map((s) => s.trim()).includes(nextSource)) return oldSource;
  return `${oldSource}, ${nextSource}`;
}

function tryStoreEmbedding(db: Database, memoryId: number, vector?: number[] | Float32Array): void {
  if (!vector || vector.length === 0) return;
  const norm = normalizeVector(vector);
  const embeddedAt = nowIso();
  db.prepare(`
    INSERT OR REPLACE INTO memory_embeddings (memory_id, embedding, model, embedded_at)
    VALUES (?, ?, ?, ?)
  `).run(memoryId, serializeVector(norm), "kindx-local", embeddedAt);
}

function insertNewMemory(db: Database, params: {
  scope: string;
  key: string;
  value: string;
  source?: string;
  confidence: number;
  searchText: string;
  tags: string[];
  vector?: number[] | Float32Array;
}): number {
  const now = nowIso();
  const run = db.prepare(`
    INSERT INTO memories (
      scope, key, value, confidence, source,
      appeared_count, accessed_count,
      created_at, last_appeared_at, last_accessed_at,
      search_text
    ) VALUES (?, ?, ?, ?, ?, 1, 0, ?, ?, NULL, ?)
  `).run(
    params.scope,
    params.key,
    params.value,
    params.confidence,
    params.source && params.source.trim().length > 0 ? params.source.trim() : null,
    now,
    now,
    params.searchText,
  );
  const memoryId = Number(run.lastInsertRowid);
  ensureTags(db, memoryId, params.tags);
  tryStoreEmbedding(db, memoryId, params.vector);
  return memoryId;
}

export function initializeMemorySchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS metadata (
      key TEXT PRIMARY KEY,
      value TEXT
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope TEXT NOT NULL DEFAULT 'default',
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      confidence REAL DEFAULT 1.0,
      source TEXT,
      appeared_count INTEGER DEFAULT 0,
      accessed_count INTEGER DEFAULT 0,
      created_at TEXT,
      last_appeared_at TEXT,
      last_accessed_at TEXT,
      superseded_by INTEGER REFERENCES memories(id),
      superseded_at TEXT,
      search_text TEXT,
      UNIQUE(scope, key, value)
    )
  `);

  const memoryColumns = db.prepare(`PRAGMA table_info(memories)`).all() as { name: string }[];
  const hasScope = memoryColumns.some((c) => c.name === "scope");
  if (!hasScope) {
    db.exec(`ALTER TABLE memories ADD COLUMN scope TEXT NOT NULL DEFAULT 'default'`);
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_scope_key_value ON memories(scope, key, value)`);
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_tags (
      memory_id INTEGER REFERENCES memories(id) ON DELETE CASCADE,
      tag TEXT NOT NULL,
      PRIMARY KEY (memory_id, tag)
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_links (
      source_id INTEGER REFERENCES memories(id) ON DELETE CASCADE,
      target_id INTEGER REFERENCES memories(id) ON DELETE CASCADE,
      relation TEXT NOT NULL,
      created_at TEXT,
      PRIMARY KEY (source_id, target_id, relation)
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_embeddings (
      memory_id INTEGER PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
      embedding BLOB NOT NULL,
      model TEXT NOT NULL,
      embedded_at TEXT NOT NULL
    )
  `);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_memories_scope_key_active ON memories(scope, key, superseded_by)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_memories_scope_search ON memories(scope, search_text)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_memories_scope_accessed ON memories(scope, accessed_count)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_memory_tags_tag ON memory_tags(tag)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_memory_links_source ON memory_links(source_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_memory_links_target ON memory_links(target_id)`);

  db.prepare(`
    INSERT OR REPLACE INTO metadata (key, value)
    VALUES ('memory_schema_version', ?)
  `).run(MEMORY_SCHEMA_VERSION);
}

async function computeMemoryVector(searchText: string, precomputedVector?: number[]): Promise<number[] | undefined> {
  if (precomputedVector && precomputedVector.length > 0) return precomputedVector;
  try {
    return await withLLMSession(async (session) => {
      const formatted = formatDocForEmbedding(searchText);
      const result = await session.embed(formatted, { isQuery: false });
      return result?.embedding;
    }, { maxDuration: 2 * 60 * 1000, name: "memory-embed-single" });
  } catch {
    return undefined;
  }
}

export async function upsertMemory(db: Database, input: UpsertMemoryInput): Promise<MemoryRecord> {
  const scope = normalizeScope(input.scope);
  const key = (input.key || "").trim();
  const value = (input.value || "").trim();
  const source = (input.source || "").trim();
  const confidence = Number.isFinite(input.confidence) ? Number(input.confidence) : 1.0;
  const tags = normalizeTags(input.tags);
  const semanticThreshold = input.semanticThreshold ?? DEFAULT_SEMANTIC_THRESHOLD;

  if (!key || !value) {
    throw new Error("Both key and value are required for memory upsert.");
  }

  const searchText = `${key}: ${value}`;

  // 1) Exact dedup
  const exact = db.prepare(`
    SELECT id, source, appeared_count
    FROM memories
    WHERE scope = ? AND key = ? AND value = ?
    LIMIT 1
  `).get(scope, key, value) as { id: number; source: string | null; appeared_count: number } | undefined;

  if (exact) {
    return withTransaction(db, () => {
      const mergedSource = mergeSource(exact.source, source);
      const now = nowIso();
      db.prepare(`
        UPDATE memories
        SET source = ?,
            confidence = ?,
            appeared_count = ?,
            last_appeared_at = ?,
            search_text = ?
        WHERE id = ?
      `).run(mergedSource, confidence, Number(exact.appeared_count || 0) + 1, now, searchText, exact.id);
      ensureTags(db, Number(exact.id), tags);

      const row = db.prepare(`SELECT * FROM memories WHERE id = ?`).get(exact.id);
      return toMemoryRecord(row);
    });
  }

  let vector = input.precomputedVector;
  const prefix = keyPrefix(key);

  // 2) Semantic supersession within same key prefix + scope
  if (!input.disableSemanticDedup) {
    vector = vector ?? await computeMemoryVector(searchText, input.precomputedVector);
    if (vector && vector.length > 0) {
      const normQuery = normalizeVector(vector);
      const candidates = getSemanticCandidates(db, scope, prefix);
      let best: { id: number; similarity: number } | null = null;
      for (const candidate of candidates) {
        const sim = cosineSimilarityNormalized(normQuery, candidate.embedding);
        if (sim >= semanticThreshold && (!best || sim > best.similarity)) {
          best = { id: candidate.id, similarity: sim };
        }
      }

      if (best) {
        return withTransaction(db, () => {
          const newId = insertNewMemory(db, {
            scope,
            key,
            value,
            source,
            confidence,
            searchText,
            tags,
            vector,
          });

          const now = nowIso();
          db.prepare(`
            UPDATE memories
            SET superseded_by = ?, superseded_at = ?
            WHERE id = ?
          `).run(newId, now, best.id);

          const row = db.prepare(`SELECT * FROM memories WHERE id = ?`).get(newId);
          return toMemoryRecord(row);
        });
      }
    }
  }

  // 3) Single-cardinality supersession
  if (SINGLE_CARDINALITY_KEYS.has(prefix)) {
    const old = db.prepare(`
      SELECT id
      FROM memories
      WHERE scope = ? AND key = ? AND superseded_by IS NULL
      LIMIT 1
    `).get(scope, key) as { id: number } | undefined;

    if (old) {
      vector = vector ?? await computeMemoryVector(searchText, input.precomputedVector);
      return withTransaction(db, () => {
        const newId = insertNewMemory(db, {
          scope,
          key,
          value,
          source,
          confidence,
          searchText,
          tags,
          vector,
        });

        db.prepare(`
          UPDATE memories
          SET superseded_by = ?, superseded_at = ?
          WHERE id = ?
        `).run(newId, nowIso(), old.id);

        const row = db.prepare(`SELECT * FROM memories WHERE id = ?`).get(newId);
        return toMemoryRecord(row);
      });
    }
  }

  // 4) New insert
  vector = vector ?? await computeMemoryVector(searchText, input.precomputedVector);
  return withTransaction(db, () => {
    const newId = insertNewMemory(db, {
      scope,
      key,
      value,
      source,
      confidence,
      searchText,
      tags,
      vector,
    });

    const row = db.prepare(`SELECT * FROM memories WHERE id = ?`).get(newId);
    return toMemoryRecord(row);
  });
}

export function textSearchMemory(db: Database, scopeInput: string, queryInput: string, limit = 20): MemorySearchResult[] {
  const scope = normalizeScope(scopeInput);
  const query = (queryInput || "").trim();
  if (!query) return [];

  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];

  const where = words.map(() => `LOWER(m.search_text) LIKE ?`).join(" AND ");
  const params = words.map((w) => `%${w}%`);

  const rows = db.prepare(`
    SELECT m.id, m.scope, m.key, m.value, m.source, m.appeared_count, m.accessed_count,
      CASE WHEN m.appeared_count = 0 THEN 0.0
      ELSE CAST(m.accessed_count AS REAL) / m.appeared_count END AS hit_rate,
      m.search_text
    FROM memories m
    WHERE m.scope = ? AND m.superseded_by IS NULL AND ${where}
    ORDER BY hit_rate DESC, m.accessed_count DESC
    LIMIT ?
  `).all(scope, ...params, limit) as {
    id: number;
    scope: string;
    key: string;
    value: string;
    source: string | null;
    appeared_count: number;
    accessed_count: number;
    hit_rate: number;
    search_text: string;
  }[];

  const scored = rows.map((row) => {
    const text = (row.search_text || `${row.key}: ${row.value}`).toLowerCase();
    const score = words.reduce((acc, w) => acc + (text.includes(w) ? 1 : 0), 0);
    return {
      id: Number(row.id),
      scope: row.scope,
      key: row.key,
      value: row.value,
      source: row.source,
      appearedCount: Number(row.appeared_count) + 1,
      accessedCount: Number(row.accessed_count) + 1,
      hitRate: Number(row.hit_rate || 0),
      score,
    };
  }).sort((a, b) => (b.score - a.score) || (b.hitRate || 0) - (a.hitRate || 0));

  incrementCounters(db, scored.map((s) => s.id));

  return scored;
}

export function semanticSearchMemoryWithVector(
  db: Database,
  scopeInput: string,
  queryVector: number[] | Float32Array,
  limit = 20,
  threshold = 0.3,
): MemorySearchResult[] {
  const scope = normalizeScope(scopeInput);
  const normQuery = normalizeVector(queryVector);

  const rows = db.prepare(`
    SELECT m.id, m.scope, m.key, m.value, m.source, m.appeared_count, m.accessed_count, e.embedding
    FROM memories m
    JOIN memory_embeddings e ON e.memory_id = m.id
    WHERE m.scope = ? AND m.superseded_by IS NULL
  `).all(scope) as {
    id: number;
    scope: string;
    key: string;
    value: string;
    source: string | null;
    appeared_count: number;
    accessed_count: number;
    embedding: Buffer;
  }[];

  const scored = rows
    .map((row) => {
      const sim = cosineSimilarityNormalized(normQuery, deserializeVector(row.embedding));
      return {
        id: Number(row.id),
        scope: row.scope,
        key: row.key,
        value: row.value,
        source: row.source,
        appearedCount: Number(row.appeared_count) + 1,
        accessedCount: Number(row.accessed_count) + 1,
        similarity: sim,
      };
    })
    .filter((row) => row.similarity >= threshold)
    .sort((a, b) => (b.similarity || 0) - (a.similarity || 0))
    .slice(0, limit);

  incrementCounters(db, scored.map((s) => s.id));

  return scored;
}

export async function semanticSearchMemory(
  db: Database,
  scopeInput: string,
  queryInput: string,
  limit = 20,
  threshold = 0.3,
  precomputedQueryVector?: number[],
): Promise<MemorySearchResult[]> {
  const scope = normalizeScope(scopeInput);
  const query = (queryInput || "").trim();
  if (!query) return [];

  let queryVector = precomputedQueryVector;
  if (!queryVector || queryVector.length === 0) {
    try {
      queryVector = await withLLMSession(async (session) => {
        const formatted = formatQueryForEmbedding(query);
        const result = await session.embed(formatted, { isQuery: true });
        return result?.embedding;
      }, { maxDuration: 2 * 60 * 1000, name: "memory-search-query" });
    } catch {
      queryVector = undefined;
    }
  }

  if (!queryVector || queryVector.length === 0) {
    return textSearchMemory(db, scope, query, limit);
  }

  const semantic = semanticSearchMemoryWithVector(db, scope, queryVector, limit, threshold);
  if (semantic.length === 0) {
    return textSearchMemory(db, scope, query, limit);
  }

  return semantic;
}

export function getMemoryHistory(db: Database, scopeInput: string, key: string): MemoryHistoryItem[] {
  const scope = normalizeScope(scopeInput);
  const rows = db.prepare(`
    SELECT id, scope, key, value, confidence, source, created_at, superseded_by, superseded_at
    FROM memories
    WHERE scope = ? AND key = ?
    ORDER BY created_at
  `).all(scope, key) as any[];

  return rows.map((row) => ({
    id: Number(row.id),
    scope: String(row.scope),
    key: String(row.key),
    value: String(row.value),
    confidence: Number(row.confidence ?? 1),
    source: row.source ?? null,
    createdAt: row.created_at ?? null,
    supersededBy: row.superseded_by == null ? null : Number(row.superseded_by),
    supersededAt: row.superseded_at ?? null,
  }));
}

export function markMemoryAccessed(db: Database, scopeInput: string, memoryId: number): boolean {
  const scope = normalizeScope(scopeInput);
  const run = db.prepare(`
    UPDATE memories
    SET accessed_count = accessed_count + 1,
        last_accessed_at = ?
    WHERE id = ? AND scope = ?
  `).run(nowIso(), memoryId, scope);
  return Number(run.changes) > 0;
}

export function getMemoryStats(db: Database, scopeInput: string): MemoryStats {
  const scope = normalizeScope(scopeInput);

  const total = db.prepare(`SELECT COUNT(*) AS cnt FROM memories WHERE scope = ? AND superseded_by IS NULL`).get(scope) as { cnt: number };
  const superseded = db.prepare(`SELECT COUNT(*) AS cnt FROM memories WHERE scope = ? AND superseded_by IS NOT NULL`).get(scope) as { cnt: number };
  const links = db.prepare(`
    SELECT COUNT(*) AS cnt
    FROM memory_links l
    JOIN memories m ON m.id = l.source_id
    WHERE m.scope = ?
  `).get(scope) as { cnt: number };
  const embedded = db.prepare(`
    SELECT COUNT(*) AS cnt
    FROM memory_embeddings e
    JOIN memories m ON m.id = e.memory_id
    WHERE m.scope = ?
  `).get(scope) as { cnt: number };

  const tagRows = db.prepare(`
    SELECT t.tag AS tag, COUNT(*) AS cnt
    FROM memory_tags t
    JOIN memories m ON m.id = t.memory_id
    WHERE m.scope = ?
    GROUP BY t.tag
    ORDER BY cnt DESC
  `).all(scope) as { tag: string; cnt: number }[];

  const topRows = db.prepare(`
    SELECT key, value, accessed_count
    FROM memories
    WHERE scope = ? AND accessed_count > 0
    ORDER BY accessed_count DESC
    LIMIT 10
  `).all(scope) as { key: string; value: string; accessed_count: number }[];

  return {
    scope,
    totalMemories: Number(total?.cnt || 0),
    superseded: Number(superseded?.cnt || 0),
    links: Number(links?.cnt || 0),
    embedded: Number(embedded?.cnt || 0),
    byTag: Object.fromEntries(tagRows.map((r) => [r.tag, Number(r.cnt)])),
    topAccessed: topRows.map((r) => ({ key: r.key, value: r.value, accessed: Number(r.accessed_count) })),
  };
}

export async function embedMemories(
  db: Database,
  scopeInput: string,
  force = false,
): Promise<{ embedded: number; totalCandidates: number }> {
  const scope = normalizeScope(scopeInput);

  if (force) {
    db.prepare(`
      DELETE FROM memory_embeddings
      WHERE memory_id IN (SELECT id FROM memories WHERE scope = ?)
    `).run(scope);
  }

  const rows = db.prepare(`
    SELECT m.id, m.key, m.value
    FROM memories m
    LEFT JOIN memory_embeddings e ON e.memory_id = m.id
    WHERE m.scope = ? AND m.superseded_by IS NULL AND (? = 1 OR e.memory_id IS NULL)
    ORDER BY m.id
  `).all(scope, force ? 1 : 0) as { id: number; key: string; value: string }[];

  if (rows.length === 0) {
    return { embedded: 0, totalCandidates: 0 };
  }

  const formatted = rows.map((r) => formatDocForEmbedding(`${r.key}: ${r.value}`));

  const vectors = await withLLMSession(async (session) => {
    const embedded = await session.embedBatch(formatted);
    return embedded.map((e) => e?.embedding);
  }, { maxDuration: 30 * 60 * 1000, name: "memory-embed-backfill" });

  let embeddedCount = 0;
  for (let i = 0; i < rows.length; i += 1) {
    const memoryId = Number(rows[i]?.id);
    const vec = vectors[i];
    if (!memoryId || !vec || vec.length === 0) continue;
    tryStoreEmbedding(db, memoryId, vec);
    embeddedCount += 1;
  }

  return { embedded: embeddedCount, totalCandidates: rows.length };
}
