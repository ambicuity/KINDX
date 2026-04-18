import { z } from "zod";

export const KindxSubSearchSchema = z.object({
  type: z.enum(["lex", "vec", "hyde"]),
  query: z.string().min(1),
});

export const KindxQueryInputSchema = z.object({
  searches: z.array(KindxSubSearchSchema).min(1).max(10),
  limit: z.number().int().positive().max(500).optional().default(10),
  minScore: z.number().min(0).max(1).optional().default(0),
  candidateLimit: z.number().int().positive().optional(),
  collections: z.array(z.string().min(1)).optional(),
});

export const KindxSearchResultSchema = z.object({
  docid: z.string(),
  file: z.string(),
  title: z.string(),
  score: z.number(),
  context: z.string().nullable(),
  snippet: z.string(),
});

export const KindxQueryResponseSchema = z.object({
  results: z.array(KindxSearchResultSchema),
});

export const KindxGetInputSchema = z.object({
  file: z.string().min(1),
  fromLine: z.number().int().positive().optional(),
  maxLines: z.number().int().positive().optional(),
  lineNumbers: z.boolean().optional().default(false),
});

export const KindxMultiGetInputSchema = z.object({
  pattern: z.string().min(1),
  maxLines: z.number().int().positive().optional(),
  maxBytes: z.number().int().positive().optional().default(10_240),
  lineNumbers: z.boolean().optional().default(false),
});

export const KindxStatusOutputSchema = z.object({
  totalDocuments: z.number(),
  needsEmbedding: z.number(),
  hasVectorIndex: z.boolean(),
  collections: z.array(z.object({
    name: z.string(),
    path: z.string(),
    pattern: z.string(),
    documents: z.number(),
    lastUpdated: z.string(),
  })),
  watchDaemon: z.enum(["active", "inactive"]).optional(),
});

export const KindxMemoryPutInputSchema = z.object({
  scope: z.string().optional(),
  key: z.string().min(1),
  value: z.string().min(1),
  source: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
  semanticThreshold: z.number().min(0).max(1).optional(),
  tags: z.array(z.string()).optional(),
});

export const KindxMemorySearchInputSchema = z.object({
  scope: z.string().optional(),
  query: z.string().min(1),
  mode: z.enum(["semantic", "text"]).optional().default("semantic"),
  threshold: z.number().min(0).max(1).optional(),
  limit: z.number().int().positive().optional().default(10),
});

export const KindxMemoryHistoryInputSchema = z.object({
  scope: z.string().optional(),
  key: z.string().min(1),
});

export const KindxMemoryMarkInputSchema = z.object({
  scope: z.string().optional(),
  id: z.number().int().positive(),
});

const ResourceItemSchema = z.object({
  type: z.literal("resource"),
  resource: z.object({
    uri: z.string(),
    name: z.string().optional(),
    title: z.string().optional(),
    mimeType: z.string().optional(),
    text: z.string(),
  }),
});

const TextItemSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
});

export const KindxMcpToolResultSchema = z.object({
  content: z.array(z.union([TextItemSchema, ResourceItemSchema])).optional(),
  structuredContent: z.unknown().optional(),
  isError: z.boolean().optional(),
});

export type KindxSubSearch = z.infer<typeof KindxSubSearchSchema>;
export type KindxQueryInput = z.infer<typeof KindxQueryInputSchema>;
export type KindxSearchResult = z.infer<typeof KindxSearchResultSchema>;
export type KindxQueryResponse = z.infer<typeof KindxQueryResponseSchema>;
export type KindxGetInput = z.infer<typeof KindxGetInputSchema>;
export type KindxMultiGetInput = z.infer<typeof KindxMultiGetInputSchema>;
export type KindxStatusOutput = z.infer<typeof KindxStatusOutputSchema>;
export type KindxMemoryPutInput = z.infer<typeof KindxMemoryPutInputSchema>;
export type KindxMemorySearchInput = z.infer<typeof KindxMemorySearchInputSchema>;
export type KindxMemoryHistoryInput = z.infer<typeof KindxMemoryHistoryInputSchema>;
export type KindxMemoryMarkInput = z.infer<typeof KindxMemoryMarkInputSchema>;
export type KindxMcpToolResult = z.infer<typeof KindxMcpToolResultSchema>;
