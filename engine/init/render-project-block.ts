import { AUTO_INVOCATION_CONTRACT } from "../protocol.js";

export function renderProjectFenceBody(): string {
  return [
    "<!-- This block is managed by `kindx init` — edits inside the fence will be overwritten. -->",
    "",
    AUTO_INVOCATION_CONTRACT,
    "",
    "Tools available: `query`, `get`, `multi_get`, `status`, `memory_search`, `memory_put`.",
  ].join("\n");
}
