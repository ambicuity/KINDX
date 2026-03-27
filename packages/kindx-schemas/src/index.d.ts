import { z } from "zod";
export declare const KindxSubSearchSchema: z.ZodObject<{
    type: z.ZodEnum<{
        lex: "lex";
        vec: "vec";
        hyde: "hyde";
    }>;
    query: z.ZodString;
}, z.core.$strip>;
export declare const KindxQueryInputSchema: z.ZodObject<{
    searches: z.ZodArray<z.ZodObject<{
        type: z.ZodEnum<{
            lex: "lex";
            vec: "vec";
            hyde: "hyde";
        }>;
        query: z.ZodString;
    }, z.core.$strip>>;
    limit: z.ZodDefault<z.ZodOptional<z.ZodNumber>>;
    minScore: z.ZodDefault<z.ZodOptional<z.ZodNumber>>;
    candidateLimit: z.ZodOptional<z.ZodNumber>;
    collections: z.ZodOptional<z.ZodArray<z.ZodString>>;
}, z.core.$strip>;
export declare const KindxSearchResultSchema: z.ZodObject<{
    docid: z.ZodString;
    file: z.ZodString;
    title: z.ZodString;
    score: z.ZodNumber;
    context: z.ZodNullable<z.ZodString>;
    snippet: z.ZodString;
}, z.core.$strip>;
export declare const KindxQueryResponseSchema: z.ZodObject<{
    results: z.ZodArray<z.ZodObject<{
        docid: z.ZodString;
        file: z.ZodString;
        title: z.ZodString;
        score: z.ZodNumber;
        context: z.ZodNullable<z.ZodString>;
        snippet: z.ZodString;
    }, z.core.$strip>>;
}, z.core.$strip>;
export declare const KindxFeedbackInputSchema: z.ZodObject<{
    query: z.ZodString;
    chunkId: z.ZodString;
    signal: z.ZodEnum<{
        relevant: "relevant";
        irrelevant: "irrelevant";
    }>;
}, z.core.$strip>;
export declare const KindxGetInputSchema: z.ZodObject<{
    file: z.ZodString;
    fromLine: z.ZodOptional<z.ZodNumber>;
    maxLines: z.ZodOptional<z.ZodNumber>;
    lineNumbers: z.ZodDefault<z.ZodOptional<z.ZodBoolean>>;
}, z.core.$strip>;
export declare const KindxMultiGetInputSchema: z.ZodObject<{
    pattern: z.ZodString;
    maxLines: z.ZodOptional<z.ZodNumber>;
    maxBytes: z.ZodDefault<z.ZodOptional<z.ZodNumber>>;
    lineNumbers: z.ZodDefault<z.ZodOptional<z.ZodBoolean>>;
}, z.core.$strip>;
export declare const KindxStatusOutputSchema: z.ZodObject<{
    totalDocuments: z.ZodNumber;
    needsEmbedding: z.ZodNumber;
    hasVectorIndex: z.ZodBoolean;
    collections: z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        path: z.ZodString;
        pattern: z.ZodString;
        documents: z.ZodNumber;
        lastUpdated: z.ZodString;
    }, z.core.$strip>>;
    watchDaemon: z.ZodOptional<z.ZodEnum<{
        active: "active";
        inactive: "inactive";
    }>>;
}, z.core.$strip>;
export declare const KindxMemoryPutInputSchema: z.ZodObject<{
    scope: z.ZodOptional<z.ZodEnum<{
        global: "global";
        collection: "collection";
        document: "document";
    }>>;
    collection: z.ZodOptional<z.ZodString>;
    file: z.ZodOptional<z.ZodString>;
    key: z.ZodString;
    value: z.ZodUnion<readonly [z.ZodString, z.ZodNumber, z.ZodBoolean, z.ZodObject<{}, z.core.$loose>, z.ZodArray<z.ZodUnknown>]>;
    source: z.ZodOptional<z.ZodString>;
    confidence: z.ZodOptional<z.ZodNumber>;
    ttlSeconds: z.ZodOptional<z.ZodNumber>;
    tags: z.ZodOptional<z.ZodArray<z.ZodString>>;
}, z.core.$strip>;
export declare const KindxMemorySearchInputSchema: z.ZodObject<{
    scope: z.ZodOptional<z.ZodEnum<{
        global: "global";
        collection: "collection";
        document: "document";
    }>>;
    collection: z.ZodOptional<z.ZodString>;
    file: z.ZodOptional<z.ZodString>;
    query: z.ZodString;
    limit: z.ZodDefault<z.ZodOptional<z.ZodNumber>>;
}, z.core.$strip>;
export declare const KindxMemoryHistoryInputSchema: z.ZodObject<{
    scope: z.ZodOptional<z.ZodEnum<{
        global: "global";
        collection: "collection";
        document: "document";
    }>>;
    collection: z.ZodOptional<z.ZodString>;
    file: z.ZodOptional<z.ZodString>;
    key: z.ZodString;
    limit: z.ZodDefault<z.ZodOptional<z.ZodNumber>>;
}, z.core.$strip>;
export declare const KindxMemoryMarkInputSchema: z.ZodObject<{
    scope: z.ZodOptional<z.ZodEnum<{
        global: "global";
        collection: "collection";
        document: "document";
    }>>;
    collection: z.ZodOptional<z.ZodString>;
    file: z.ZodOptional<z.ZodString>;
    id: z.ZodString;
    useful: z.ZodOptional<z.ZodBoolean>;
    ignored: z.ZodOptional<z.ZodBoolean>;
    note: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const KindxMcpToolResultSchema: z.ZodObject<{
    content: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodObject<{
        type: z.ZodLiteral<"text">;
        text: z.ZodString;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"resource">;
        resource: z.ZodObject<{
            uri: z.ZodString;
            name: z.ZodOptional<z.ZodString>;
            title: z.ZodOptional<z.ZodString>;
            mimeType: z.ZodOptional<z.ZodString>;
            text: z.ZodString;
        }, z.core.$strip>;
    }, z.core.$strip>]>>>;
    structuredContent: z.ZodOptional<z.ZodUnknown>;
    isError: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strip>;
export type KindxSubSearch = z.infer<typeof KindxSubSearchSchema>;
export type KindxQueryInput = z.infer<typeof KindxQueryInputSchema>;
export type KindxSearchResult = z.infer<typeof KindxSearchResultSchema>;
export type KindxQueryResponse = z.infer<typeof KindxQueryResponseSchema>;
export type KindxFeedbackInput = z.infer<typeof KindxFeedbackInputSchema>;
export type KindxGetInput = z.infer<typeof KindxGetInputSchema>;
export type KindxMultiGetInput = z.infer<typeof KindxMultiGetInputSchema>;
export type KindxStatusOutput = z.infer<typeof KindxStatusOutputSchema>;
export type KindxMemoryPutInput = z.infer<typeof KindxMemoryPutInputSchema>;
export type KindxMemorySearchInput = z.infer<typeof KindxMemorySearchInputSchema>;
export type KindxMemoryHistoryInput = z.infer<typeof KindxMemoryHistoryInputSchema>;
export type KindxMemoryMarkInput = z.infer<typeof KindxMemoryMarkInputSchema>;
export type KindxMcpToolResult = z.infer<typeof KindxMcpToolResultSchema>;
