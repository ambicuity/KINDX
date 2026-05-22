# Multimodal Pipeline Design

## Overview

This design extends KINDX's text-only indexing and retrieval capabilities to support images, CSV, and JSON files through incremental integration with the existing architecture.

## Goals

1. **Image Understanding**: Ingest images and generate searchable text descriptions via a local vision model
2. **Structured Data Indexing**: Index CSV/JSON files with schema-aware chunking that preserves data relationships
3. **Hybrid Retrieval**: Enable unified search across text, image descriptions, and structured data
4. **Architecture Consistency**: Extend existing patterns without major architectural changes

## Approach: Incremental Integration

Extend the existing `LlamaCpp` class and ingestion pipeline to handle multimodal content. This approach minimizes disruption while adding the required capabilities.

---

## Section 1: Vision Model Integration

### Model Configuration

Add vision model support to `engine/inference.ts`:

```typescript
const DEFAULT_VISION_MODEL = process.env.KINDX_VISION_MODEL ?? 
  "hf:llava-hf/llava-1.5-7b-GGUF/llava-1.5-7b-Q4_K_M.gguf";
```

### LlamaCpp Class Extensions

Add to the `LlamaCpp` class:

```typescript
private visionModel: LlamaModel | null = null;
private visionModelLoadPromise: Promise<LlamaModel> | null = null;
private visionModelUri: string;

constructor(config: LlamaCppConfig = {}) {
  // ... existing initialization ...
  this.visionModelUri = config.visionModel || DEFAULT_VISION_MODEL;
}

private async ensureVisionModel(): Promise<LlamaModel> {
  // Follow same pattern as ensureGenerateModel()
  // Lazy loading with promise guard
}

async describeImage(imagePath: string): Promise<string> {
  // Load vision model
  // Process image and generate description
  // Return text description
}
```

### Lifecycle Management

- Add vision model to `unloadIdleResources()` method
- Add vision model to `dispose()` method
- Track vision model in `resetRuntimeForCpuFallback()`
- Vision model respects same inactivity timeout as other models

---

## Section 2: Image Ingestion Pipeline

### Supported Formats

Extend `engine/ingestion.ts`:

```typescript
const IMAGE_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tiff", ".tif"
]);
```

### Ingestion Flow

1. `ingestFile()` detects image extension
2. Calls new `ingestImage()` function
3. `ingestImage()` reads image file as base64
4. Calls vision model to generate text description
5. Returns `IngestionResult` with:
   - `text`: Generated image description
   - `metadata.format`: "image"
   - `metadata.extractor`: "vision_model"
   - `metadata.bytes`: Image file size

### Error Handling

- Vision model failure: Return empty text with warning `extractor_failed:vision_model`
- Corrupt image: Return empty text with warning `extractor_failed:image_corrupt`
- Graceful degradation: Images without descriptions still indexed (no text content)

---

## Section 3: Schema-Aware Chunking for CSV/JSON

### CSV Processing

Add `ingestCsv()` to `engine/ingestion.ts`:

1. Parse CSV header to extract column names
2. Group rows into chunks preserving row boundaries
3. Each chunk includes:
   - Header row for context
   - Subset of data rows (max 100 rows per chunk)
   - Metadata about chunk position in dataset

### JSON Processing

Add `ingestJson()` to `engine/ingestion.ts`:

1. Parse JSON structure (array of objects or nested objects)
2. Flatten to key-value pairs for indexing
3. Group objects into chunks preserving object boundaries
4. Each chunk includes:
   - Schema description (field names/types)
   - Subset of JSON objects (max 50 objects per chunk)
   - Metadata about chunk position

### Chunking Parameters

- Maximum chunk size: 1000 tokens (configurable via `KINDX_CHUNK_SIZE_TOKENS`)
- Overlap: 10% of chunk size
- Preserve semantic boundaries (row/object boundaries)
- Include schema context in each chunk

### Implementation Locations

- `engine/ingestion.ts`: Add `ingestCsv()` and `ingestJson()` functions
- `engine/repository/chunking.ts`: Add `chunkCsv()` and `chunkJson()` functions
- `engine/schema.ts`: Store schema information in document metadata

---

## Section 4: Hybrid Retrieval Integration

### Unified Indexing

Image descriptions and structured data chunks are indexed as regular text documents:

1. Image descriptions stored in `content` table with hash
2. Documents table maps image paths to content hashes
3. FTS indexes image description text
4. Vector embeddings generated for image descriptions

### Search Result Extensions

Extend `HybridQueryResult` in `engine/repository/retrieval/hybrid.ts`:

```typescript
interface HybridQueryResult {
  // ... existing fields ...
  contentType: 'text' | 'image' | 'csv' | 'json';
  sourceMetadata?: {
    originalFile?: string;
    imageDescription?: boolean;
    schemaInfo?: Record<string, string>;
  };
}
```

### Search Flow

1. User queries for "diagram showing system architecture"
2. FTS matches image descriptions containing those terms
3. Vector search finds semantically similar image descriptions
4. Results include both text documents and image descriptions
5. Reranking works uniformly across all content types

### Benefits

- Unified search experience across all content types
- No special handling required in query expansion
- Existing RRF and reranking work for all content types
- Simple implementation with minimal changes to retrieval logic

---

## Files to Modify

### `engine/inference.ts`
- Add vision model configuration
- Add `ensureVisionModel()` method
- Add `describeImage()` method
- Update lifecycle management methods

### `engine/ingestion.ts`
- Add `IMAGE_EXTENSIONS` constant
- Add `ingestImage()` function
- Add `ingestCsv()` function
- Add `ingestJson()` function
- Update `ingestFile()` to handle new formats

### `engine/schema.ts`
- Add schema storage for structured data
- Update capability metadata

### `engine/repository/chunking.ts`
- Add `chunkCsv()` function
- Add `chunkJson()` function

### `engine/repository/retrieval/hybrid.ts`
- Extend `HybridQueryResult` type
- Update result assembly to include content type metadata

---

## Configuration

### Environment Variables

- `KINDX_VISION_MODEL`: Vision model URI (default: LLaVA 1.5 7B)
- `KINDX_MAX_IMAGE_SIZE_MB`: Maximum image file size (default: 10MB)
- `KINDX_CHUNK_SIZE_TOKENS`: Chunk size for structured data (default: 1000)

### Model Requirements

- Vision model must support base64 image input
- Vision model must output text descriptions
- Recommended: LLaVA 1.5 7B or Qwen-VL

---

## Testing Strategy

### Unit Tests

1. Vision model loading and description generation
2. Image ingestion for each supported format
3. CSV/JSON parsing and chunking
4. Schema extraction and storage

### Integration Tests

1. End-to-end image indexing and search
2. CSV/JSON indexing and search
3. Mixed content search (text + images + structured data)
4. Error handling and graceful degradation

### Performance Tests

1. Vision model inference time
2. Large CSV/JSON file processing
3. Search latency with mixed content

---

## Acceptance Criteria

1. ✅ Images ingested and described via vision model
2. ✅ Image descriptions indexed and searchable
3. ✅ CSV/JSON data indexed with schema-aware chunking
4. ✅ Hybrid retrieval works across text and visual content

---

## Dependencies

- node-llama-cpp vision model support
- Local GGUF vision model (LLaVA or Qwen-VL)
- No external API dependencies

## Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| Vision model large download | Configurable model, fallback to text-only |
| Vision model slow inference | Async processing, progress indicators |
| CSV/JSON malformed files | Robust parsing with error recovery |
| Memory usage with large files | Streaming processing, size limits |
