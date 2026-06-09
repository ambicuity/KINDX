import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, copyFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Adapter, DetectResult, WriteResult } from "./types.js";

export interface JsonAdapterConfig {
  name: string;
  label: string;
  configPath: string;
  keyPath: string[];      // e.g. ["mcpServers", "kindx"] or ["mcp","servers","kindx"]
  jsoncTolerant?: boolean; // strip // and trailing commas before parsing
}

function stripJsonc(text: string): string {
  // Strip // line comments outside strings, then trailing commas.
  let out = "";
  let i = 0;
  let inString = false;
  let stringChar = "";
  let escaped = false;
  while (i < text.length) {
    const c = text[i];
    if (inString) {
      out += c;
      if (escaped) { escaped = false; }
      else if (c === "\\") { escaped = true; }
      else if (c === stringChar) { inString = false; }
      i++;
    } else if (c === '"' || c === "'") {
      inString = true;
      stringChar = c;
      out += c;
      i++;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
    } else {
      out += c;
      i++;
    }
  }
  // Remove trailing commas before } or ]
  return out.replace(/,(\s*[}\]])/g, "$1");
}

function readConfig(path: string, jsoncTolerant?: boolean): any {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, "utf-8");
  if (!raw.trim()) return {};
  const parsed = jsoncTolerant ? JSON.parse(stripJsonc(raw)) : JSON.parse(raw);
  return parsed && typeof parsed === "object" ? parsed : {};
}

function getAtPath(obj: any, keyPath: string[]): any {
  let cur = obj;
  for (const k of keyPath) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = cur[k];
  }
  return cur;
}

function setAtPath(obj: any, keyPath: string[], value: any): void {
  let cur = obj;
  for (let i = 0; i < keyPath.length - 1; i++) {
    const k = keyPath[i];
    if (cur[k] == null || typeof cur[k] !== "object") cur[k] = {};
    cur = cur[k];
  }
  cur[keyPath[keyPath.length - 1]] = value;
}

function atomicWriteJson(path: string, value: any): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${Date.now()}.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  renameSync(tmp, path);
}

export function createJsonAdapter(cfg: JsonAdapterConfig): Adapter {
  return {
    name: cfg.name,
    label: cfg.label,
    detect(): DetectResult {
      const exists = existsSync(cfg.configPath);
      let alreadyWired = false;
      if (exists) {
        try {
          const parsed = readConfig(cfg.configPath, cfg.jsoncTolerant);
          alreadyWired = getAtPath(parsed, cfg.keyPath) != null;
        } catch { /* unreadable → treat as not wired */ }
      }
      return { configPath: cfg.configPath, exists, alreadyWired };
    },
    write(opts): WriteResult {
      const detected = this.detect();
      if (detected.alreadyWired && !opts.force) {
        return { configPath: cfg.configPath, outcome: "skipped", reason: "already wired (use --force to overwrite)" };
      }
      const parsed = readConfig(cfg.configPath, cfg.jsoncTolerant);
      setAtPath(parsed, cfg.keyPath, { command: opts.command, args: opts.args });

      if (opts.dryRun) {
        return { configPath: cfg.configPath, outcome: detected.exists ? "updated" : "created" };
      }

      let backupPath: string | undefined;
      if (detected.exists) {
        backupPath = `${cfg.configPath}.kindx.bak.${Date.now()}`;
        copyFileSync(cfg.configPath, backupPath);
      }
      atomicWriteJson(cfg.configPath, parsed);
      return { configPath: cfg.configPath, outcome: detected.exists ? "updated" : "created", backupPath };
    },
  };
}
