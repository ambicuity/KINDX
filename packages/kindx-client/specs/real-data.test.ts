import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

import { KindxClient } from "../src/index.js";
import {
  createStore,
  type Store,
} from "../../../engine/repository.js";

type SeedDoc = { relativePath: string; body: string };

function collectMarkdownFiles(root: string): SeedDoc[] {
  return readdirSync(root)
    .filter((entry) => entry.endsWith(".md"))
    .map((entry) => {
      const absolute = join(root, entry);
      return {
        relativePath: entry,
        body: readFileSync(absolute, "utf8"),
      };
    });
}

describe("KindxClient real data", () => {
  let store: Store;
  let tempDir = "";

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), "kindx-client-realdata-"));
    const dbPath = join(tempDir, "index.sqlite");

    store = createStore(dbPath);
    const now = new Date().toISOString();

    const here = dirname(fileURLToPath(import.meta.url));
    const root = join(here, "..", "..", "..");
    const docs = collectMarkdownFiles(join(root, "specs", "eval-docs"));

    for (const doc of docs) {
      const hash = createHash("sha256").update(doc.body).digest("hex");
      store.insertContent(hash, doc.body, now);
      store.insertDocument("eval", doc.relativePath, doc.relativePath, hash, now, now);
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(() => {
    if (store) store.close();
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  it("queries and retrieves documents from real corpus", async () => {
    let initialized = false;

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url.endsWith("/query")) {
        const body = JSON.parse(String(init?.body || "{}"));
        const searches = body.searches as Array<{ type: string; query: string }>;
        const lexQuery = searches.find((s) => s.type === "lex")?.query;
        const primaryQuery = lexQuery
          || searches[0]?.query
          || "";
        const limit = body.limit ?? 10;
        const minScore = body.minScore ?? 0;

        const ftsResults = primaryQuery
          ? store.searchFTS(primaryQuery, limit)
          : [];
        const results = ftsResults
          .filter((r) => r.score >= minScore)
          .slice(0, limit);

        const formatted = results.map((r) => {
          return {
            docid: `#${r.docid}`,
            file: r.displayPath,
            title: r.title || r.displayPath,
            score: Math.round(r.score * 100) / 100,
            context: r.context,
            snippet: `1: ${r.displayPath}`,
          };
        });

        return new Response(JSON.stringify({ results: formatted }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      if (url.endsWith("/mcp")) {
        const body = JSON.parse(String(init?.body || "{}"));

        if (body.method === "initialize") {
          initialized = true;
          return new Response(
            JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { serverInfo: { name: "kindx" } } }),
            {
              status: 200,
              headers: {
                "content-type": "application/json",
                "mcp-session-id": "session-1",
              },
            }
          );
        }

        if (body.method === "tools/call" && body.params?.name === "get" && initialized) {
          const query = body.params.arguments.file as string;
          const doc = store.findDocument(query, { includeBody: false });
          if ("error" in doc) {
            return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { isError: true } }), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          }

          const text = store.getDocumentBody(doc) || "";
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: body.id,
              result: {
                content: [{
                  type: "resource",
                  resource: {
                    uri: `kindx://${doc.displayPath}`,
                    name: doc.displayPath,
                    title: doc.title,
                    mimeType: "text/markdown",
                    text,
                  },
                }],
              },
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            }
          );
        }
      }

      return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    });

    const client = new KindxClient({ baseUrl: "http://localhost:8181" });

    const result = await client.query({
      searches: [{ type: "lex", query: "rate limiting" }],
      limit: 5,
      minScore: 0,
    });

    expect(result.results.length).toBeGreaterThan(0);

    const target = result.results.find((item) => item.file.includes("api-design-principles.md"));
    expect(target).toBeTruthy();

    const file = target?.file || result.results[0]!.file;
    const doc = await client.get({ file });
    const textContent = doc.content?.find((item) => item.type === "resource");
    expect(textContent).toBeTruthy();
    expect((textContent as any).resource.text).toContain("Rate Limiting");
  });
});
