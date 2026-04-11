import {
  KindxGetInputSchema,
  KindxMcpToolResultSchema,
  KindxMemoryHistoryInputSchema,
  KindxMemoryMarkInputSchema,
  KindxMemoryPutInputSchema,
  KindxMemorySearchInputSchema,
  KindxMultiGetInputSchema,
  KindxQueryInputSchema,
  KindxQueryResponseSchema,
  KindxStatusOutputSchema,
  type KindxGetInput,
  type KindxMcpToolResult,
  type KindxMemoryHistoryInput,
  type KindxMemoryMarkInput,
  type KindxMemoryPutInput,
  type KindxMemorySearchInput,
  type KindxMultiGetInput,
  type KindxQueryInput,
  type KindxQueryResponse,
  type KindxStatusOutput,
} from "@ambicuity/kindx-schemas";

export type KindxClientOptions = {
  baseUrl: string;
  token?: string;
  timeoutMs?: number;
};

type JsonRpcResponse = {
  jsonrpc?: string;
  id?: string | number | null;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
    data?: unknown;
  };
};

export class KindxClientError extends Error {
  status?: number;
  details?: unknown;

  constructor(message: string, options?: { status?: number; details?: unknown }) {
    super(message);
    this.name = "KindxClientError";
    this.status = options?.status;
    this.details = options?.details;
  }
}

export class KindxClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly token?: string;
  private mcpSessionId?: string;
  private rpcIdCounter = 0;

  constructor(options: KindxClientOptions) {
    this.baseUrl = trimTrailingSlashes(options.baseUrl);
    this.token = options.token;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  async search(input: KindxQueryInput): Promise<KindxQueryResponse> {
    return this.query(input);
  }

  async query(input: KindxQueryInput): Promise<KindxQueryResponse> {
    const payload = KindxQueryInputSchema.parse(input);
    const json = await this.postJson(`${this.baseUrl}/query`, payload);
    return KindxQueryResponseSchema.parse(json);
  }

  async get(input: KindxGetInput): Promise<KindxMcpToolResult> {
    return this.callTool("get", KindxGetInputSchema.parse(input));
  }

  async multiGet(input: KindxMultiGetInput): Promise<KindxMcpToolResult> {
    return this.callTool("multi_get", KindxMultiGetInputSchema.parse(input));
  }

  async status(): Promise<KindxStatusOutput> {
    const output = await this.callTool("status", {});
    return KindxStatusOutputSchema.parse(output.structuredContent ?? {});
  }

  async memoryPut(input: KindxMemoryPutInput): Promise<KindxMcpToolResult> {
    return this.callTool("memory_put", KindxMemoryPutInputSchema.parse(input));
  }

  async memorySearch(input: KindxMemorySearchInput): Promise<KindxMcpToolResult> {
    return this.callTool("memory_search", KindxMemorySearchInputSchema.parse(input));
  }

  async memoryHistory(input: KindxMemoryHistoryInput): Promise<KindxMcpToolResult> {
    return this.callTool("memory_history", KindxMemoryHistoryInputSchema.parse(input));
  }

  async memoryMark(input: KindxMemoryMarkInput): Promise<KindxMcpToolResult> {
    return this.callTool("memory_mark_accessed", KindxMemoryMarkInputSchema.parse(input));
  }

  private async callTool(name: string, args: Record<string, unknown>): Promise<KindxMcpToolResult> {
    const sessionId = await this.ensureSession();
    const rpc = await this.postJson<JsonRpcResponse>(`${this.baseUrl}/mcp`, {
      jsonrpc: "2.0",
      id: this.nextRpcId(),
      method: "tools/call",
      params: {
        name,
        arguments: args,
      },
    }, {
      "mcp-session-id": sessionId,
    });

    const parsed = this.parseJsonRpc(rpc);
    return KindxMcpToolResultSchema.parse(parsed.result ?? {});
  }

  private async ensureSession(): Promise<string> {
    if (this.mcpSessionId) return this.mcpSessionId;

    const response = await this.postJson<JsonRpcResponse>(
      `${this.baseUrl}/mcp`,
      {
        jsonrpc: "2.0",
        id: this.nextRpcId(),
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "kindx-client", version: "0.1.0" },
        },
      },
      undefined,
      true,
    );

    const rpc = this.parseJsonRpc(response.body);
    if (!response.sessionId) {
      throw new KindxClientError("Missing MCP session id from initialize response", {
        details: rpc,
      });
    }

    this.mcpSessionId = response.sessionId;
    return response.sessionId;
  }

  private nextRpcId(): number {
    this.rpcIdCounter += 1;
    return this.rpcIdCounter;
  }

  private parseJsonRpc(body: unknown): JsonRpcResponse {
    const rpc = body as JsonRpcResponse;
    if (rpc?.error) {
      throw new KindxClientError(rpc.error.message || "MCP JSON-RPC error", {
        details: rpc.error,
      });
    }
    return rpc;
  }

  private async postJson<T>(
    url: string,
    body: unknown,
    headers?: Record<string, string>,
    includeResponseHeaders?: false,
  ): Promise<T>;
  private async postJson<T>(
    url: string,
    body: unknown,
    headers: Record<string, string> | undefined,
    includeResponseHeaders: true,
  ): Promise<{ body: T; sessionId?: string }>;
  private async postJson<T>(
    url: string,
    body: unknown,
    headers?: Record<string, string>,
    includeResponseHeaders: boolean = false,
  ): Promise<T | { body: T; sessionId?: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const requestHeaders: Record<string, string> = {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...headers,
      };
      if (this.token) {
        requestHeaders.Authorization = `Bearer ${this.token}`;
      }

      const res = await fetch(url, {
        method: "POST",
        headers: requestHeaders,
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      const text = await res.text();
      let parsed: T;
      try {
        parsed = (text ? JSON.parse(text) : {}) as T;
      } catch {
        throw new KindxClientError("Invalid JSON response from KINDX server", {
          status: res.status,
          details: text,
        });
      }

      if (!res.ok) {
        throw new KindxClientError(`KINDX request failed with status ${res.status}`, {
          status: res.status,
          details: parsed,
        });
      }

      if (!includeResponseHeaders) {
        return parsed;
      }

      return {
        body: parsed,
        sessionId: res.headers.get("mcp-session-id") ?? undefined,
      };
    } catch (err) {
      if (err instanceof KindxClientError) throw err;
      if (err instanceof Error && err.name === "AbortError") {
        throw new KindxClientError("KINDX request timed out", { details: { timeoutMs: this.timeoutMs } });
      }
      throw new KindxClientError("KINDX request failed", { details: err });
    } finally {
      clearTimeout(timer);
    }
  }
}

function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) {
    end -= 1;
  }
  return value.slice(0, end);
}
