import { afterEach, describe, expect, it, vi } from "vitest";
import { KindxClient } from "../src/index.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("KindxClient", () => {
  it("queries via REST endpoint", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({
        results: [{
          docid: "#abc123",
          file: "docs/overview.md",
          title: "Overview",
          score: 0.91,
          context: null,
          snippet: "1: hello",
        }],
      }), { status: 200, headers: { "content-type": "application/json" } })
    );

    const client = new KindxClient({ baseUrl: "http://localhost:8181" });
    const result = await client.query({ searches: [{ type: "lex", query: "hello" }] });

    expect(result.results[0]?.docid).toBe("#abc123");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("invokes MCP status tool", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ jsonrpc: "2.0", id: 1, result: { serverInfo: { name: "kindx" } } }),
        { status: 200, headers: { "content-type": "application/json", "mcp-session-id": "session-1" } }
      ))
      .mockResolvedValueOnce(new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          result: {
            content: [{ type: "text", text: "ok" }],
            structuredContent: {
              totalDocuments: 1,
              needsEmbedding: 0,
              hasVectorIndex: false,
              collections: [{
                name: "docs",
                path: "/tmp/docs",
                pattern: "**/*.md",
                documents: 1,
                lastUpdated: "now",
              }],
              watchDaemon: "inactive",
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      ));

    const client = new KindxClient({ baseUrl: "http://localhost:8181" });
    const status = await client.status();

    expect(status.totalDocuments).toBe(1);
    expect(status.collections[0]?.name).toBe("docs");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("uses memory_mark_accessed tool contract", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ jsonrpc: "2.0", id: 1, result: { serverInfo: { name: "kindx" } } }),
        { status: 200, headers: { "content-type": "application/json", "mcp-session-id": "session-1" } }
      ))
      .mockResolvedValueOnce(new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          result: {
            content: [{ type: "text", text: "marked memory #12 accessed" }],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      ));

    const client = new KindxClient({ baseUrl: "http://localhost:8181" });
    await client.memoryMark({ id: 12, scope: "workspace-a" });

    const secondCall = fetchMock.mock.calls[1];
    const secondInit = secondCall?.[1] as RequestInit;
    const parsed = JSON.parse(String(secondInit?.body));
    expect(parsed?.method).toBe("tools/call");
    expect(parsed?.params?.name).toBe("memory_mark_accessed");
    expect(parsed?.params?.arguments?.id).toBe(12);
    expect(parsed?.params?.arguments?.scope).toBe("workspace-a");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
