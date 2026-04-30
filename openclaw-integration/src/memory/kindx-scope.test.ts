import { describe, expect, it } from "vitest";
import type { ResolvedKindxConfig } from "./backend-config.js";
import {
  deriveKindxScopeChannel,
  deriveKindxScopeChatType,
  isKindxScopeAllowed,
} from "./kindx-scope.js";

describe("kindx scope", () => {
  const allowDirect: ResolvedKindxConfig["scope"] = {
    default: "deny",
    rules: [{ action: "allow", match: { chatType: "direct" } }],
  };

  it("derives channel and chat type from canonical keys once", () => {
    expect(deriveKindxScopeChannel("Workspace:group:123")).toBe("workspace");
    expect(deriveKindxScopeChatType("Workspace:group:123")).toBe("group");
  });

  it("derives channel and chat type from stored key suffixes", () => {
    expect(deriveKindxScopeChannel("agent:agent-1:workspace:channel:chan-123")).toBe("workspace");
    expect(deriveKindxScopeChatType("agent:agent-1:workspace:channel:chan-123")).toBe("channel");
  });

  it("treats parsed keys with no chat prefix as direct", () => {
    expect(deriveKindxScopeChannel("agent:agent-1:peer-direct")).toBeUndefined();
    expect(deriveKindxScopeChatType("agent:agent-1:peer-direct")).toBe("direct");
    expect(isKindxScopeAllowed(allowDirect, "agent:agent-1:peer-direct")).toBe(true);
    expect(isKindxScopeAllowed(allowDirect, "agent:agent-1:peer:group:abc")).toBe(false);
  });

  it("applies scoped key-prefix checks against normalized key", () => {
    const scope: ResolvedKindxConfig["scope"] = {
      default: "deny",
      rules: [{ action: "allow", match: { keyPrefix: "workspace:" } }],
    };
    expect(isKindxScopeAllowed(scope, "agent:agent-1:workspace:group:123")).toBe(true);
    expect(isKindxScopeAllowed(scope, "agent:agent-1:other:group:123")).toBe(false);
  });

  it("supports rawKeyPrefix matches for agent-prefixed keys", () => {
    const scope: ResolvedKindxConfig["scope"] = {
      default: "allow",
      rules: [{ action: "deny", match: { rawKeyPrefix: "agent:main:discord:" } }],
    };
    expect(isKindxScopeAllowed(scope, "agent:main:discord:channel:c123")).toBe(false);
    expect(isKindxScopeAllowed(scope, "agent:main:slack:channel:c123")).toBe(true);
  });

  it("keeps legacy agent-prefixed keyPrefix rules working", () => {
    const scope: ResolvedKindxConfig["scope"] = {
      default: "allow",
      rules: [{ action: "deny", match: { keyPrefix: "agent:main:discord:" } }],
    };
    expect(isKindxScopeAllowed(scope, "agent:main:discord:channel:c123")).toBe(false);
    expect(isKindxScopeAllowed(scope, "agent:main:slack:channel:c123")).toBe(true);
  });
});
