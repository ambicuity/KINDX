/**
 * MCP HTTP initialization helper for KINDX.
 *
 * Goal:
 * - Ensure robust initialize handshake.
 * - Capture and reuse MCP session id.
 * - Use single-await control flow for each network operation.
 *
 * Usage:
 *   npx tsx tooling/init-mcp-http.ts http://127.0.0.1:31337/mcp
 */

const endpoint = process.argv[2] || "http://127.0.0.1:31337/mcp";

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: Record<string, unknown>;
};

async function postJsonRpc(
  url: string,
  body: JsonRpcRequest,
  sessionId?: string,
): Promise<{ status: number; json: any; sessionId?: string }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
  };

  if (sessionId) {
    headers["mcp-session-id"] = sessionId;
  }

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  const nextSessionId = response.headers.get("mcp-session-id") || sessionId;
  const json = await response.json();

  return {
    status: response.status,
    json,
    ...(nextSessionId ? { sessionId: nextSessionId } : {}),
  };
}

async function main(): Promise<void> {
  const initializeRequest: JsonRpcRequest = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "kindx-init-script", version: "1.0.1" },
      rootUri: "file:///tmp/workspace-alpha",
    },
  };

  const init = await postJsonRpc(endpoint, initializeRequest);

  if (init.status !== 200 || !init.sessionId) {
    throw new Error(`Initialize failed (status=${init.status}): ${JSON.stringify(init.json)}`);
  }

  const toolsList = await postJsonRpc(
    endpoint,
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    },
    init.sessionId,
  );

  if (toolsList.status !== 200) {
    throw new Error(`tools/list failed (status=${toolsList.status}): ${JSON.stringify(toolsList.json)}`);
  }

  const toolNames: string[] = Array.isArray(toolsList.json?.result?.tools)
    ? toolsList.json.result.tools.map((t: any) => t?.name).filter(Boolean)
    : [];

  process.stdout.write(
    JSON.stringify(
      {
        endpoint,
        initialized: true,
        sessionId: init.sessionId,
        toolsCount: toolNames.length,
        hasMemoryTools: toolNames.includes("memory_put") && toolNames.includes("memory_search"),
      },
      null,
      2,
    ) + "\n",
  );
}

main().catch((err) => {
  process.stderr.write(`init-mcp-http failed: ${String(err)}\n`);
  process.exit(1);
});
