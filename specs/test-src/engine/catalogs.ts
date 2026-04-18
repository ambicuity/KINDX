/**
 * Collections configuration management
 *
 * This module manages the YAML-based collection configuration at ~/.config/kindx/index.yml.
 * Collections define which directories to index and their associated contexts.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from "fs";
import { join, resolve } from "path";
import { homedir } from "os";
import YAML from "yaml";

// ============================================================================
// Types
// ============================================================================

/**
 * Context definitions for a collection
 * Key is path prefix (e.g., "/", "/2024", "/Board of Directors")
 * Value is the context description
 */
export type ContextMap = Record<string, string>;

/**
 * A single collection configuration
 */
export interface Collection {
  path: string;              // Absolute path to index
  pattern: string;           // Glob pattern (e.g., "**/*.md")
  ignore?: string[];         // Glob patterns to exclude (e.g., ["Sessions/**"])
  context?: ContextMap;      // Optional context definitions
  update?: string;           // Optional bash command to run during kindx update
  includeByDefault?: boolean; // Include in queries by default (default: true)
  shard_count?: number;      // Optional per-collection shard count for vector storage
  max_rerank_candidates?: number; // Optional max rerank candidates for this collection
  rerank_timeout_ms?: number; // Optional rerank timeout budget
  embedding_batch_size?: number; // Optional embed scheduler batch size
  embedding_workers?: number; // Optional embed scheduler worker count
  embed_queue_limit?: number; // Optional per-run embed queue cap
  vector_fanout_workers?: number; // Optional bounded parallelism for shard/collection vector fanout
  rerank_queue_limit?: number; // Optional rerank queue length cap
  rerank_concurrency?: number; // Optional rerank parallel workers
  rerank_drop_policy?: "timeout_fallback" | "wait"; // Optional rerank backpressure behavior
}

/**
 * The complete configuration file structure
 */
export interface CollectionConfig {
  global_context?: string;                    // Context applied to all collections
  collections: Record<string, Collection>;    // Collection name -> config
}

/**
 * Collection with its name (for return values)
 */
export interface NamedCollection extends Collection {
  name: string;
}

// ============================================================================
// Configuration paths
// ============================================================================

// Current index name (default: "index")
let currentIndexName: string = "index";

/**
 * Set the current index name for config file lookup
 * Config file will be ~/.config/kindx/{indexName}.yml
 */
export function setConfigIndexName(name: string): void {
  // Resolve relative paths to absolute paths and sanitize for use as filename
  if (name.includes('/')) {
    const absolutePath = resolve(process.cwd(), name);
    // Replace path separators with underscores to create a valid filename
    currentIndexName = absolutePath.replace(/\//g, '_').replace(/^_/, '');
  } else {
    currentIndexName = name;
  }
}

function getConfigDir(): string {
  // Allow override via KINDX_CONFIG_DIR for testing
  if (process.env.KINDX_CONFIG_DIR) {
    return process.env.KINDX_CONFIG_DIR;
  }
  // Respect XDG Base Directory specification (consistent with repository.ts)
  if (process.env.XDG_CONFIG_HOME) {
    return join(process.env.XDG_CONFIG_HOME, "kindx");
  }
  return join(homedir(), ".config", "kindx");
}

function getConfigFilePath(): string {
  return join(getConfigDir(), `${currentIndexName}.yml`);
}

/**
 * Ensure config directory exists
 */
function ensureConfigDir(): void {
  const configDir = getConfigDir();
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
  }
}

// ============================================================================
// Core functions
// ============================================================================

let _cachedConfig: CollectionConfig | null = null;
let _lastConfigMtime = 0;

/**
 * Load configuration from ~/.config/kindx/index.yml
 * Returns empty config if file doesn't exist
 */
export function loadConfig(): CollectionConfig {
  const configPath = getConfigFilePath();
  if (!existsSync(configPath)) {
    return { collections: {} };
  }

  try {
    const stat = statSync(configPath);
    if (_cachedConfig && stat.mtimeMs === _lastConfigMtime) {
      return _cachedConfig;
    }

    const content = readFileSync(configPath, "utf-8");
    const config = YAML.parse(content) as CollectionConfig;

    // Ensure collections object exists
    if (!config.collections) {
      config.collections = {};
    }

    _cachedConfig = config;
    _lastConfigMtime = stat.mtimeMs;

    return config;
  } catch (error) {
    throw new Error(`Failed to parse ${configPath}: ${error}`);
  }
}

/**
 * Save configuration to ~/.config/kindx/index.yml
 */
export function saveConfig(config: CollectionConfig): void {
  ensureConfigDir();
  const configPath = getConfigFilePath();

  try {
    const yaml = YAML.stringify(config, {
      indent: 2,
      lineWidth: 0,  // Don't wrap lines
    });
    writeFileSync(configPath, yaml, "utf-8");
    
    // Update cache synchronously
    const stat = statSync(configPath);
    _cachedConfig = config;
    _lastConfigMtime = stat.mtimeMs;
  } catch (error) {
    throw new Error(`Failed to write ${configPath}: ${error}`);
  }
}

/**
 * Get a specific collection by name
 * Returns null if not found
 */
export function getCollection(name: string): NamedCollection | null {
  const config = loadConfig();
  let collection: any;
  if (Array.isArray(config.collections)) {
    collection = config.collections.find((c: any) => c.name === name);
  } else {
    collection = config.collections[name];
  }

  if (!collection) {
    return null;
  }

  return { name, ...collection };
}

/**
 * List all collections
 */
export function listCollections(): NamedCollection[] {
  const config = loadConfig();
  return Object.entries(config.collections).map(([name, collection]) => ({
    name,
    ...collection,
  }));
}

/**
 * Get collections that are included by default in queries
 */
export function getDefaultCollections(): NamedCollection[] {
  return listCollections().filter(c => c.includeByDefault !== false);
}

/**
 * Get collection names that are included by default
 */
export function getDefaultCollectionNames(): string[] {
  return getDefaultCollections().map(c => c.name);
}

/**
 * Update a collection's settings
 */
export function updateCollectionSettings(
  name: string,
  settings: {
    update?: string | null;
    includeByDefault?: boolean;
    shard_count?: number | null;
    max_rerank_candidates?: number | null;
    rerank_timeout_ms?: number | null;
    embedding_batch_size?: number | null;
    embedding_workers?: number | null;
    embed_queue_limit?: number | null;
    vector_fanout_workers?: number | null;
    rerank_queue_limit?: number | null;
    rerank_concurrency?: number | null;
    rerank_drop_policy?: "timeout_fallback" | "wait" | null;
  }
): boolean {
  const config = loadConfig();
  let collection: any;
  if (Array.isArray(config.collections)) {
    collection = config.collections.find((c: any) => c.name === name);
  } else {
    collection = config.collections[name];
  }
  if (!collection) return false;

  if (settings.update !== undefined) {
    if (settings.update === null) {
      delete collection.update;
    } else {
      collection.update = settings.update;
    }
  }

  if (settings.includeByDefault !== undefined) {
    if (settings.includeByDefault === true) {
      // true is default, remove the field
      delete collection.includeByDefault;
    } else {
      collection.includeByDefault = settings.includeByDefault;
    }
  }

  if (settings.shard_count !== undefined) {
    if (settings.shard_count === null) delete collection.shard_count;
    else collection.shard_count = settings.shard_count;
  }

  if (settings.max_rerank_candidates !== undefined) {
    if (settings.max_rerank_candidates === null) delete collection.max_rerank_candidates;
    else collection.max_rerank_candidates = settings.max_rerank_candidates;
  }

  if (settings.rerank_timeout_ms !== undefined) {
    if (settings.rerank_timeout_ms === null) delete collection.rerank_timeout_ms;
    else collection.rerank_timeout_ms = settings.rerank_timeout_ms;
  }

  if (settings.embedding_batch_size !== undefined) {
    if (settings.embedding_batch_size === null) delete collection.embedding_batch_size;
    else collection.embedding_batch_size = settings.embedding_batch_size;
  }

  if (settings.embedding_workers !== undefined) {
    if (settings.embedding_workers === null) delete collection.embedding_workers;
    else collection.embedding_workers = settings.embedding_workers;
  }

  if (settings.embed_queue_limit !== undefined) {
    if (settings.embed_queue_limit === null) delete collection.embed_queue_limit;
    else collection.embed_queue_limit = settings.embed_queue_limit;
  }

  if (settings.vector_fanout_workers !== undefined) {
    if (settings.vector_fanout_workers === null) delete collection.vector_fanout_workers;
    else collection.vector_fanout_workers = settings.vector_fanout_workers;
  }

  if (settings.rerank_queue_limit !== undefined) {
    if (settings.rerank_queue_limit === null) delete collection.rerank_queue_limit;
    else collection.rerank_queue_limit = settings.rerank_queue_limit;
  }

  if (settings.rerank_concurrency !== undefined) {
    if (settings.rerank_concurrency === null) delete collection.rerank_concurrency;
    else collection.rerank_concurrency = settings.rerank_concurrency;
  }

  if (settings.rerank_drop_policy !== undefined) {
    if (settings.rerank_drop_policy === null) delete collection.rerank_drop_policy;
    else collection.rerank_drop_policy = settings.rerank_drop_policy;
  }

  saveConfig(config);
  return true;
}

/**
 * Add or update a collection
 */
export function addCollection(
  name: string,
  path: string,
  pattern: string = "**/*.md"
): void {
  const config = loadConfig();

  if (Array.isArray(config.collections)) {
    const existingIdx = config.collections.findIndex((c: any) => c.name === name);
    if (existingIdx >= 0) {
      config.collections[existingIdx] = { name, path, pattern, context: config.collections[existingIdx].context };
    } else {
      config.collections.push({ name, path, pattern } as any);
    }
  } else {
    config.collections[name] = {
      path,
      pattern,
      context: config.collections[name]?.context, // Preserve existing context
    };
  }

  saveConfig(config);
}

/**
 * Remove a collection
 */
export function removeCollection(name: string): boolean {
  const config = loadConfig();

  if (Array.isArray(config.collections)) {
    const idx = config.collections.findIndex((c: any) => c.name === name);
    if (idx === -1) return false;
    config.collections.splice(idx, 1);
  } else {
    if (!config.collections[name]) {
      return false;
    }
    delete config.collections[name];
  }
  saveConfig(config);
  return true;
}

/**
 * Rename a collection
 */
export function renameCollection(oldName: string, newName: string): boolean {
  const config = loadConfig();

  if (Array.isArray(config.collections)) {
    if (config.collections.some((c: any) => c.name === newName)) throw new Error(`Collection '${newName}' already exists`);
    const idx = config.collections.findIndex((c: any) => c.name === oldName);
    if (idx === -1) return false;
    config.collections[idx].name = newName;
  } else {
    if (!config.collections[oldName]) {
      return false;
    }

    if (config.collections[newName]) {
      throw new Error(`Collection '${newName}' already exists`);
    }

    config.collections[newName] = config.collections[oldName];
    delete config.collections[oldName];
  }
  saveConfig(config);
  return true;
}

// ============================================================================
// Context management
// ============================================================================

/**
 * Get global context
 */
export function getGlobalContext(): string | undefined {
  const config = loadConfig();
  return config.global_context;
}

/**
 * Set global context
 */
export function setGlobalContext(context: string | undefined): void {
  const config = loadConfig();
  config.global_context = context;
  saveConfig(config);
}

/**
 * Get all contexts for a collection
 */
export function getContexts(collectionName: string): ContextMap | undefined {
  const collection = getCollection(collectionName);
  return collection?.context;
}

/**
 * Add or update a context for a specific path in a collection
 */
export function addContext(
  collectionName: string,
  pathPrefix: string,
  contextText: string
): boolean {
  const config = loadConfig();
  const collection = config.collections[collectionName];

  if (!collection) {
    return false;
  }

  if (!collection.context) {
    collection.context = {};
  }

  collection.context[pathPrefix] = contextText;
  saveConfig(config);
  return true;
}

/**
 * Remove a context from a collection
 */
export function removeContext(
  collectionName: string,
  pathPrefix: string
): boolean {
  const config = loadConfig();
  const collection = config.collections[collectionName];

  if (!collection?.context?.[pathPrefix]) {
    return false;
  }

  delete collection.context[pathPrefix];

  // Remove empty context object
  if (Object.keys(collection.context).length === 0) {
    delete collection.context;
  }

  saveConfig(config);
  return true;
}

/**
 * List all contexts across all collections
 */
export function listAllContexts(): Array<{
  collection: string;
  path: string;
  context: string;
}> {
  const config = loadConfig();
  const results: Array<{ collection: string; path: string; context: string }> = [];

  // Add global context if present
  if (config.global_context) {
    results.push({
      collection: "*",
      path: "/",
      context: config.global_context,
    });
  }

  // Add collection contexts
  for (const [name, collection] of Object.entries(config.collections)) {
    if (collection.context) {
      for (const [path, context] of Object.entries(collection.context)) {
        results.push({
          collection: name,
          path,
          context,
        });
      }
    }
  }

  return results;
}

/**
 * Find best matching context for a given collection and path
 * Returns the most specific matching context (longest path prefix match)
 */
export function findContextForPath(
  collectionName: string,
  filePath: string
): string | undefined {
  const config = loadConfig();
  const collection = config.collections[collectionName];

  if (!collection?.context) {
    return config.global_context;
  }

  // Find all matching prefixes
  const matches: Array<{ prefix: string; context: string }> = [];

  for (const [prefix, context] of Object.entries(collection.context)) {
    // Normalize paths for comparison
    const normalizedPath = filePath.startsWith("/") ? filePath : `/${filePath}`;
    const normalizedPrefix = prefix.startsWith("/") ? prefix : `/${prefix}`;

    if (normalizedPath.startsWith(normalizedPrefix)) {
      matches.push({ prefix: normalizedPrefix, context });
    }
  }

  // Return most specific match (longest prefix)
  if (matches.length > 0) {
    matches.sort((a, b) => b.prefix.length - a.prefix.length);
    return matches[0]!.context;
  }

  // Fallback to global context
  return config.global_context;
}

// ============================================================================
// Utility functions
// ============================================================================

/**
 * Get the config file path (useful for error messages)
 */
export function getConfigPath(): string {
  return getConfigFilePath();
}

/**
 * Check if config file exists
 */
export function configExists(): boolean {
  return existsSync(getConfigFilePath());
}

/**
 * Validate a collection name
 * Collection names must be valid and not contain special characters
 */
export function isValidCollectionName(name: string): boolean {
  // Allow alphanumeric, hyphens, underscores
  return /^[a-zA-Z0-9_-]+$/.test(name);
}

/**
 * Update the glob pattern for an existing collection.
 * Returns false if collection does not exist.
 */
export function updateCollectionPattern(name: string, newPattern: string): boolean {
  const config = loadConfig();
  const collection = config.collections[name];
  if (!collection) return false;

  collection.pattern = newPattern;
  saveConfig(config);
  return true;
}
