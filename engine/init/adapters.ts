import { homedir, platform } from "node:os";
import { join } from "node:path";
import { createJsonAdapter } from "./json-adapter.js";
import { createTomlAdapter } from "./toml-adapter.js";
import type { Adapter } from "./types.js";

const HOME = homedir();
const isMac = platform() === "darwin";
const isWin = platform() === "win32";

function claudeDesktopPath(): string {
  if (isMac) return join(HOME, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  if (isWin) return join(process.env.APPDATA ?? join(HOME, "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
  return join(HOME, ".config", "Claude", "claude_desktop_config.json");
}

export const ALL_ADAPTERS: Adapter[] = [
  createJsonAdapter({
    name: "claude-code",
    label: "Claude Code",
    configPath: join(HOME, ".claude", "settings.json"),
    keyPath: ["mcpServers", "kindx"],
  }),
  createJsonAdapter({
    name: "claude-desktop",
    label: "Claude Desktop",
    configPath: claudeDesktopPath(),
    keyPath: ["mcpServers", "kindx"],
  }),
  createJsonAdapter({
    name: "cursor",
    label: "Cursor",
    configPath: join(HOME, ".cursor", "mcp.json"),
    keyPath: ["mcpServers", "kindx"],
    jsoncTolerant: true,
  }),
  createJsonAdapter({
    name: "continue",
    label: "Continue",
    configPath: join(HOME, ".continue", "config.json"),
    keyPath: ["mcpServers", "kindx"],
  }),
  createJsonAdapter({
    name: "opencode",
    label: "OpenCode",
    configPath: join(HOME, ".opencode", "config.json"),
    keyPath: ["mcp", "servers", "kindx"],
  }),
  createTomlAdapter({
    name: "codex",
    label: "Codex CLI",
    configPath: join(HOME, ".codex", "config.toml"),
    key: "mcp_servers.kindx",
  }),
  createJsonAdapter({
    name: "copilot",
    label: "Copilot CLI",
    configPath: join(HOME, ".copilot", "mcp.json"),
    keyPath: ["mcpServers", "kindx"],
  }),
  createJsonAdapter({
    name: "zed",
    label: "Zed",
    configPath: join(HOME, ".config", "zed", "settings.json"),
    keyPath: ["context_servers", "kindx"],
    jsoncTolerant: true,
  }),
];

export function adapterByName(name: string): Adapter | undefined {
  return ALL_ADAPTERS.find((a) => a.name === name);
}
