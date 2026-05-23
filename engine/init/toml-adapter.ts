import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, copyFileSync } from "node:fs";
import { dirname } from "node:path";
import TOML from "@iarna/toml";
import type { Adapter, DetectResult, WriteResult } from "./types.js";

export interface TomlAdapterConfig {
  name: string;
  label: string;
  configPath: string;
  /** Dotted key path, e.g. "mcp_servers.kindx". */
  key: string;
}

function readToml(path: string): any {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, "utf-8");
  if (!raw.trim()) return {};
  return TOML.parse(raw);
}

function setDotted(obj: any, key: string, value: any): void {
  const parts = key.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur[parts[i]] == null || typeof cur[parts[i]] !== "object") cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

function getDotted(obj: any, key: string): any {
  return key.split(".").reduce((cur, k) => (cur == null ? undefined : cur[k]), obj);
}

function atomicWriteToml(path: string, value: any): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${Date.now()}.${process.pid}`;
  writeFileSync(tmp, TOML.stringify(value));
  renameSync(tmp, path);
}

export function createTomlAdapter(cfg: TomlAdapterConfig): Adapter {
  return {
    name: cfg.name,
    label: cfg.label,
    detect(): DetectResult {
      const exists = existsSync(cfg.configPath);
      let alreadyWired = false;
      if (exists) {
        try { alreadyWired = getDotted(readToml(cfg.configPath), cfg.key) != null; } catch { /* */ }
      }
      return { configPath: cfg.configPath, exists, alreadyWired };
    },
    write(opts): WriteResult {
      const detected = this.detect();
      if (detected.alreadyWired && !opts.force) {
        return { configPath: cfg.configPath, outcome: "skipped", reason: "already wired (use --force to overwrite)" };
      }
      const parsed = readToml(cfg.configPath);
      setDotted(parsed, cfg.key, { command: opts.command, args: opts.args });
      if (opts.dryRun) return { configPath: cfg.configPath, outcome: detected.exists ? "updated" : "created" };

      let backupPath: string | undefined;
      if (detected.exists) {
        backupPath = `${cfg.configPath}.kindx.bak.${Date.now()}`;
        copyFileSync(cfg.configPath, backupPath);
      }
      atomicWriteToml(cfg.configPath, parsed);
      return { configPath: cfg.configPath, outcome: detected.exists ? "updated" : "created", backupPath };
    },
  };
}
