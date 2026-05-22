import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import YAML from "yaml";
import { atomicWriteFile } from "./utils/atomic-write.js";

export interface IndexEntry {
  created_at: string;
  description?: string;
}

export interface IndexRegistry {
  version: 1;
  default: string;
  indexes: Record<string, IndexEntry>;
}

export interface NamedIndex extends IndexEntry {
  name: string;
}

const INDEX_NAME_RE = /^[a-z][a-z0-9-]{1,63}$/;

function getConfigDir(): string {
  if (process.env.KINDX_CONFIG_DIR) return process.env.KINDX_CONFIG_DIR;
  if (process.env.XDG_CONFIG_HOME) return join(process.env.XDG_CONFIG_HOME, "kindx");
  return join(homedir(), ".config", "kindx");
}

function getRegistryPath(): string {
  return join(getConfigDir(), "indexes.yml");
}

let _cachedRegistry: IndexRegistry | null = null;
let _lastRegistryMtime = 0;

export function __resetRegistryCacheForTests(): void {
  _cachedRegistry = null;
  _lastRegistryMtime = 0;
}

function defaultRegistry(): IndexRegistry {
  return {
    version: 1,
    default: "index",
    indexes: {},
  };
}

export function loadRegistry(): IndexRegistry {
  const path = getRegistryPath();
  if (!existsSync(path)) return defaultRegistry();

  try {
    const stat = statSync(path);
    if (_cachedRegistry && stat.mtimeMs === _lastRegistryMtime) {
      return _cachedRegistry;
    }
    const raw = readFileSync(path, "utf8");
    const parsed = YAML.parse(raw) as Partial<IndexRegistry>;
    const registry: IndexRegistry = {
      version: 1,
      default: parsed?.default || "index",
      indexes: parsed?.indexes || {},
    };
    _cachedRegistry = registry;
    _lastRegistryMtime = stat.mtimeMs;
    return registry;
  } catch {
    return defaultRegistry();
  }
}

export function saveRegistry(registry: IndexRegistry): void {
  const content = YAML.stringify({
    version: registry.version,
    default: registry.default,
    indexes: registry.indexes,
  });
  atomicWriteFile(getRegistryPath(), content);
  const stat = statSync(getRegistryPath());
  _cachedRegistry = registry;
  _lastRegistryMtime = stat.mtimeMs;
}

export function getDefaultIndexName(): string {
  return loadRegistry().default;
}

export function ensureDefaultIndexRegistered(): void {
  const registry = loadRegistry();
  if (!registry.indexes["index"]) {
    registry.indexes["index"] = {
      created_at: new Date().toISOString(),
      description: "Default index",
    };
    saveRegistry(registry);
  }
}

export function registerIndex(name: string, description?: string): IndexEntry {
  if (!INDEX_NAME_RE.test(name)) {
    throw new Error(`Index name must match [a-z][a-z0-9-]{1,63}, got: '${name}'`);
  }
  const registry = loadRegistry();
  if (registry.indexes[name]) {
    throw new Error(`Index '${name}' already exists`);
  }
  const entry: IndexEntry = {
    created_at: new Date().toISOString(),
    description: description || undefined,
  };
  registry.indexes[name] = entry;
  saveRegistry(registry);
  return entry;
}

export function unregisterIndex(name: string): void {
  const registry = loadRegistry();
  if (name === registry.default) {
    throw new Error(`Cannot delete the default index '${name}'`);
  }
  if (!registry.indexes[name]) {
    throw new Error(`Index '${name}' not found`);
  }
  delete registry.indexes[name];
  saveRegistry(registry);
}

export function listIndexes(): NamedIndex[] {
  const registry = loadRegistry();
  return Object.entries(registry.indexes).map(([name, entry]) => ({
    name,
    ...entry,
  }));
}

export function getIndex(name: string): NamedIndex | null {
  const registry = loadRegistry();
  const entry = registry.indexes[name];
  if (!entry) return null;
  return { name, ...entry };
}
