/**
 * remote-llm.ts - Remote API (OpenAI-compatible) backend for KINDX
 *
 * Implements the core KINDX LLM interface by proxying requests via `fetch`
 * to Ollama, LM Studio, vLLM, OpenRouter, LiteLLM, or any /v1 OpenAI compatible endpoint.
 */

import type {
  LLM,
  EmbedOptions,
  GenerateOptions,
  RerankOptions,
  EmbeddingResult,
  GenerateResult,
  ModelInfo,
  Queryable,
  RerankDocument,
  RerankResult,
  QueryType
} from "./inference.js";
import { formatQueryForEmbedding, formatDocForEmbedding, isQwen3EmbeddingModel } from "./inference.js";

function getBaseUrl(): string {
  // Default to Ollama's local OpenAI compatibility layer if not provided
  return process.env.KINDX_OPENAI_BASE_URL?.replace(/\/+$/, "") || "http://localhost:11434/v1";
}

function getHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (process.env.KINDX_OPENAI_API_KEY) {
    headers["Authorization"] = `Bearer ${process.env.KINDX_OPENAI_API_KEY}`;
  }
  return headers;
}

export class RemoteLLM implements LLM {
  private embedModel: string;
  private generateModel: string;
  private rerankModel: string;

  constructor() {
    this.embedModel = process.env.KINDX_OPENAI_EMBED_MODEL || "nomic-embed-text";
    this.generateModel = process.env.KINDX_OPENAI_GENERATE_MODEL || "qwen2.5-coder:1.5b";
    this.rerankModel = process.env.KINDX_OPENAI_RERANK_MODEL || "qwen3-reranker";
    
    process.stderr.write(`KINDX: Running in Remote API mode (Endpoint: ${getBaseUrl()})\n`);
  }

  async embed(text: string, options?: EmbedOptions): Promise<EmbeddingResult | null> {
    const model = options?.model || this.embedModel;
    let formattedText = text;

    if (options?.isQuery) {
      formattedText = formatQueryForEmbedding(text, model);
    } else {
      formattedText = formatDocForEmbedding(text, options?.title, model);
    }

    try {
      const res = await fetch(`${getBaseUrl()}/embeddings`, {
        method: "POST",
        headers: getHeaders(),
        body: JSON.stringify({
          model,
          input: formattedText,
        }),
      });

      if (!res.ok) {
        throw new Error(`Embedding API returned ${res.status}: ${await res.text()}`);
      }

      const data = await res.json() as any;
      if (!data.data || !data.data[0] || !data.data[0].embedding) {
        return null;
      }

      return {
        embedding: data.data[0].embedding,
        model,
      };
    } catch (err) {
      console.error("Remote embedding failed:", err);
      return null;
    }
  }

  async embedBatch(texts: string[]): Promise<(EmbeddingResult | null)[]> {
    if (texts.length === 0) return [];
    
    const results: (EmbeddingResult | null)[] = [];
    const model = this.embedModel;

    try {
      // Send as a single batch if the endpoint supports array inputs
      // (OpenAI and Ollama both support string[] arrays for batch embedding)
      const res = await fetch(`${getBaseUrl()}/embeddings`, {
        method: "POST",
        headers: getHeaders(),
        body: JSON.stringify({
          model,
          input: texts,
        }),
      });

      if (!res.ok) {
        // If batching fails entirely (e.g. timeout or payload too large), fallback iteratively
        throw new Error(`Batch embedding API returned ${res.status}: ${await res.text()}`);
      }

      const data = await res.json() as any;
      if (!data.data || !Array.isArray(data.data)) {
        throw new Error("Invalid response format from embeddings API");
      }

      // Reconstruct exactly in order. OpenAI guarantees order of data array matches input.
      for (let i = 0; i < texts.length; i++) {
        const item = data.data.find((d: any) => d.index === i) || data.data[i];
        if (item && item.embedding) {
          results.push({ embedding: item.embedding, model });
        } else {
          results.push(null);
        }
      }

      return results;
    } catch (err) {
      console.warn("Remote batch embedding failed, attempting sequential fallback:", err);
      // Sequential fallback
      for (const t of texts) {
        results.push(await this.embed(t, { model }));
      }
      return results;
    }
  }

  async generate(prompt: string, options?: GenerateOptions): Promise<GenerateResult | null> {
    const model = options?.model || this.generateModel;
    const max_tokens = options?.maxTokens || 150;
    const temperature = options?.temperature || 0.7;

    try {
      const res = await fetch(`${getBaseUrl()}/chat/completions`, {
        method: "POST",
        headers: getHeaders(),
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: prompt }],
          max_tokens,
          temperature,
          stream: false
        }),
      });

      if (!res.ok) {
        throw new Error(`Chat API returned ${res.status}: ${await res.text()}`);
      }

      const data = await res.json() as any;
      const text = data.choices?.[0]?.message?.content || "";

      return {
        text,
        model,
        done: true
      };
    } catch (err) {
      console.error("Remote generation failed:", err);
      return null;
    }
  }

  async modelExists(model: string): Promise<ModelInfo> {
    try {
      const res = await fetch(`${getBaseUrl()}/models`, {
        method: "GET",
        headers: getHeaders()
      });

      if (!res.ok) {
        return { name: model, exists: false };
      }

      const data = await res.json() as any;
      const exists = !!data.data?.find((m: any) => m.id === model);
      
      return {
        name: model,
        exists,
      };
    } catch (err) {
      // Assume false if the /v1/models endpoint fails
      return { name: model, exists: false };
    }
  }

  async expandQuery(query: string, options?: { context?: string; includeLexical?: boolean }): Promise<Queryable[]> {
    const includeLexical = options?.includeLexical ?? true;
    const context = options?.context;

    // Fast-path bypass for short queries
    const tokenCount = query.trim().split(/\s+/).filter(Boolean).length;
    if (tokenCount <= 3) {
      const bypass: Queryable[] = [{ type: 'vec', text: query }];
      if (includeLexical) bypass.unshift({ type: 'lex', text: query });
      return bypass;
    }

    const domainInstruction = context
      ? `Domain context: ${context}\nYour expansions MUST stay within this domain. Do not introduce concepts from outside it.`
      : `Stay strictly within the semantic domain implied by the query itself.`;

    const systemPrompt = [
      `You are a search query expansion engine. Your ONLY task is to output structured query variations.`,
      ``,
      `OUTPUT FORMAT (strict JSON array of objects):`,
      `[`,
      `  { "type": "lex", "text": "<exact keyword phrase>" },`,
      `  { "type": "vec", "text": "<semantically equivalent rephrasing>" },`,
      `  { "type": "hyde", "text": "<a verbatim 1-2 sentence excerpt that would appear in a relevant technical document>" }`,
      `]`,
      ``,
      `RULES:`,
      `  - MUST output valid JSON only. Nothing else.`,
      `  - Output 2 to 4 objects maximally.`,
      domainInstruction,
    ].join('\n');

    try {
      const res = await fetch(`${getBaseUrl()}/chat/completions`, {
        method: "POST",
        headers: getHeaders(),
        body: JSON.stringify({
          model: this.generateModel,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: `Expand this search query: ${query}` }
          ],
          max_tokens: 600,
          temperature: 0.7,
          response_format: { type: "json_object" } // Coerce strict JSON if supported
        }),
      });

      if (!res.ok) {
        throw new Error(`Chat API (expansion) returned ${res.status}`);
      }

      const data = await res.json() as any;
      const jsonText = data.choices?.[0]?.message?.content || "[]";
      
      let parsed = [];
      try {
        // In case the model wrapped it in markdown codeblocks
        const cleaned = jsonText.replace(/^[\\s\\S]*?\\[\\s*/, "[").replace(/\\][\\s\\S]*?$/, "]");
        parsed = JSON.parse(cleaned);
      } catch (parseErr) {
        try {
           parsed = JSON.parse(jsonText);
        } catch { /* ignored */ }
      }

      if (Array.isArray(parsed) && parsed.length > 0) {
        const queryables = parsed.filter(item => 
          item && typeof item === 'object' && 
          ['lex', 'vec', 'hyde'].includes(item.type) && 
          typeof item.text === 'string'
        ) as Queryable[];

        if (queryables.length > 0) {
          return includeLexical ? queryables : queryables.filter(q => q.type !== 'lex');
        }
      }
      throw new Error("Invalid output structure");
    } catch (err) {
      console.warn("Remote query expansion failed, falling back:", err);
      const fallback: Queryable[] = [{ type: 'vec', text: query }];
      if (includeLexical) fallback.unshift({ type: 'lex', text: query });
      return fallback;
    }
  }

  async rerank(query: string, documents: RerankDocument[], options?: RerankOptions): Promise<RerankResult> {
    const model = options?.model || this.rerankModel;
    
    // Default fallback behaviour: return bm25-ordered documents as 0.9->~0 scores.
    const fallbackRanked = documents.map((doc, idx) => ({
      file: doc.file,
      index: idx,
      score: 0.9 * Math.pow(0.95, idx)
    }));

    if (documents.length === 0) {
      return { results: [], model };
    }

    try {
      // Use the standard Cohere/Jina /v1/rerank interface:
      // { model: string, query: string, documents: string[]|object[] }
      const res = await fetch(`${getBaseUrl()}/rerank`, {
        method: "POST",
        headers: getHeaders(),
        body: JSON.stringify({
          model,
          query,
          documents: documents.map(d => d.text.slice(0, 8000)) // Cap characters per chunk to avoid massive payload
        }),
      });

      // If the endpoint simply doesn't support the /rerank route (e.g. OpenAI official),
      // we must gracefully fallback to pure BM25/Vector lexical scores.
      if (res.status === 404) {
        return { results: fallbackRanked, model };
      }

      if (!res.ok) {
         console.warn(`Reranker endpoint returned ${res.status}. Falling back to BM25 order.`);
         return { results: fallbackRanked, model };
      }

      const data = await res.json() as any;
      if (!data.results || !Array.isArray(data.results)) {
        return { results: fallbackRanked, model };
      }

      // Expected format: { results: [{ index: 0, relevance_score: 0.89 }, ...] }
      const scoredDocs = documents.map((doc, i) => {
        const resultInfo = data.results.find((r: any) => r.index === i);
        // Map relevance_score to KINDX score. 
        return {
          file: doc.file,
          index: i,
          score: resultInfo?.relevance_score || fallbackRanked[i]!.score
        };
      });

      // Sort by score descending
      scoredDocs.sort((a, b) => b.score - a.score);

      return {
        results: scoredDocs,
        model
      };

    } catch (err) {
      console.warn("Remote reranking failed, falling back to BM25 input order:", err);
      return {
        results: fallbackRanked,
        model
      };
    }
  }

  async dispose(): Promise<void> {
    // Native fetch requires no active disposal/teardown in Node
  }
}
