# Local-First Multimodal Ingestion

> Roadmap design document for KINDX v1.4 — native audio, video, and screenshot
> ingestion with strict local-only guarantees, embedding parity across modalities,
> and time-range aware hybrid search. Drafted 2026-05-22.

## Branch

`feat/local-first-multimodal-ingestion`

Forked from `main` at commit `53489504` (post `test: fix typecheck blockers and
cover new engine surfaces`). This branch is **additive** and composes with the
in-flight `feat/multimodal-pipeline` spec
(`docs/superpowers/specs/2026-05-22-multimodal-pipeline-design.md`) which covers
images and structured data (CSV/JSON). This roadmap extends that spec with:

1. Native audio transcription (Whisper.cpp via GGUF).
2. Video ingestion (ffmpeg frame sampling + audio track piped to whisper).
3. Screenshot / UI capture OCR (Tesseract.wasm or PaddleOCR-lite GGML).
4. A formal `EmbeddingFamily` map so all modality-derived text lands in the
   same hybrid index as plain text documents.
5. A first-class `KINDX_LOCAL_ONLY=1` enforcement layer that becomes the new
   default, with auditable bypass.
6. Watcher integration for the new file kinds.
7. Time-range and media-kind filters on hybrid queries.

The branch does not modify the existing text extraction path, schema rows,
existing FTS5 tables, or any public Zod schema in a non-additive way.

## Owner type

Engine / retrieval-core team owns the branch. The pipeline modules
(`engine/media/*`) and the policy guard (`engine/policy/local-only.ts`) are
the core deliverable. The schemas package
(`packages/kindx-schemas/src/index.ts`) and the typed client
(`packages/kindx-client/src/index.ts`) receive purely additive surface
changes and are co-owned with the SDK team. CLI surface
(`engine/kindx.ts`) and MCP/HTTP surface (`engine/protocol.ts`,
`engine/tool-registry.ts`) are reviewed by the DX team. Model download and
caching logic in `engine/inference.ts` is co-owned with the inference team
which maintains the existing embeddinggemma + qwen3 registry. No external
team dependencies are required at design time; ffmpeg is a runtime system
dependency that must be documented and lazily required.

## Problem

KINDX today is a text-first hybrid search engine. The ingestion router in
`engine/ingestion.ts` recognises markdown, plain text, source code, PDFs (via
`pdftotext`), DOCX (via in-process unzip), images (via the vision model when
`KINDX_EXTRACTOR_PDF=1`), CSV, and JSON. There is no path for audio, video, or
screenshot OCR. Even the existing image path is gated behind a feature flag
and produces a single caption per file rather than chunks that participate in
hybrid retrieval as first-class segments.

Concretely, the gaps as of v1.3.5 are:

1. **No audio ingestion.** `.mp3`, `.wav`, `.m4a`, `.flac`, `.ogg`, `.aac`
   are silently dropped by the extractor router.
2. **No video ingestion.** `.mp4`, `.mov`, `.webm`, `.mkv` are dropped.
   Most video assets contain two retrievable streams — an audio track and
   a visual track — and we extract neither.
3. **No screenshot OCR.** UI captures flow through the optional
   vision-caption extractor, which produces a single sentence of free-form
   description. The original textual content — code, button labels, error
   messages — is lost.
4. **No embedding parity guarantee.** Vision captions happen to be embedded
   by the text embedder, but only by coincidence. There is no
   `EmbeddingFamily` abstraction, so a future change to image captioning
   could silently break the shared-vector-space invariant.
5. **No formal local-only mode.** KINDX is *de facto* local-first but there
   is no policy enforced at the extractor level. A future remote backend
   could be added without an audit hook.
6. **No watcher coverage of media file kinds.** The chokidar watcher
   triggers on text-shaped extensions only; adding `.mp4` to a watched
   folder is a no-op.
7. **No time-range or kind filters on retrieval.** A query like "transcript
   moments mentioning Q4 forecast from videos modified last week" has no
   expressible form in the current API.

The combined effect is that KINDX cannot serve as a primary memory layer for
agents whose source material is increasingly multimodal: meeting recordings,
screen shares, UI screenshots, voice memos, demo videos. Today those
artefacts have to be transcribed and captioned by *other* tools (often
cloud-hosted) and re-ingested as `.md` or `.txt`. That defeats the local-first
positioning and adds a fragile out-of-band pipeline.

## Why now in 2026

Three independent shifts have arrived in parallel and together make this the
right moment to land native multimodal ingestion.

**Local model quality crossed the production threshold in late 2025.** The
quantised Whisper.cpp builds (tiny, base, small) now produce CER under 6% on
clean English meeting audio on consumer-grade hardware (M-series Macs, modern
x86 with AVX-512). Whisper-tiny.en runs comfortably at ~10× real-time on a
laptop. LLaVA-1.5-7B in q4_K_M and the newer Phi-3-Vision quantisations
caption images well enough to match cloud baselines on common UI and
photographic content. Tesseract 5.x and the PaddleOCR-lite GGML port now
handle the screen-capture text extraction case at quality comparable to
cloud-hosted OCR APIs. The technical risk of "local models are not good
enough" is no longer real for the dominant use cases.

**Agent workloads have shifted toward multimodal source material.** Through
2024 and into 2025 the dominant artefact for an agent to reason over was a
chat transcript or a code file. By early 2026, agents are routinely consuming
recorded meetings (Granola, Limitless, Otter exports), screen shares from
collaboration tools, and UI screenshots from QA and design pipelines.
Engineering and product teams want their agents to answer "what did Priya say
about the Q4 forecast in last week's leadership sync" with the same fluency
they answer "what does the README say". Without native ingestion of the
underlying media, that question cannot be answered locally.

**Cloud-only multimodal has become commercially and legally awkward.** The
OpenAI Whisper API, Anthropic Vision endpoints, and Google Vertex multimodal
endpoints all force the asset to leave the user's machine. For enterprise
users in regulated industries (healthcare, legal, finance, government) this
is often disqualifying. Even outside those industries, the per-minute and
per-image cost of cloud transcription and captioning at scale (thousands of
hours of meeting recordings per quarter for a mid-sized company) has become
material. A local pipeline removes both the privacy risk and the marginal
cost, and pays back in months on modest deployment volumes.

The conjunction — local models are good enough, agent demand is real, cloud
alternatives are awkward — is what makes this a 2026 problem rather than a
2027 one.

## Competitive gap

**Cloud-hosted RAG vendors** (Glean, Vectara, Pinecone-as-a-service plus a
managed pipeline) lead on convenience. They handle multimodal ingestion by
calling out to OpenAI, Anthropic, or Google for transcription and
captioning, which forces customer material through vendor infrastructure
and third-party model providers. For any team that chose KINDX specifically
because it is local-first, they are not a substitute. The gap is not
feature parity — it is positioning.

**Open-source RAG frameworks with multimodal hooks** (LlamaIndex, LightRAG,
Haystack) have abstractions for image, audio, and video ingestion, but the
default implementations of those abstractions call cloud APIs. To run
fully offline the user hand-wires local Whisper, vision, and OCR backends;
configures model paths; manages GGUF downloads; reconciles framework
chunking with modality-specific segmentation; and ensures vector-space
parity at the embedding step. Feasible but not turnkey, and the experience
deteriorates as soon as the user goes beyond a single modality. KINDX's
opportunity is to ship the whole pipeline assembled, tested, and
local-only by default.

**Indexing-style desktop tools** (Recoll, DocFetcher, Spotlight, Windows
Search) handle the textual half well but do not provide hybrid retrieval
over modality-derived text, do not maintain time-aligned segments for
video and audio, and do not expose an agent-facing protocol. Not in the
same category, but they bound the floor: "find any file on my machine by
its content" must work for media.

KINDX's win condition is to be the only system that is:

1. Fully local by default, with auditable opt-in for remote backends.
2. Multimodal across audio, video, and image kinds.
3. Hybrid retrieval over a single vector space across all modalities.
4. Agent-native via MCP, HTTP, and CLI surfaces that all expose the same
   semantics.
5. Composable with the existing text path, the in-flight provenance branch,
   the memory-graph branch, and the A2A peer dispatch branch.

## KINDX opportunity

The existing KINDX architecture is shaped for this work. Four properties
make the multimodal extension cheaper here than in a typical RAG stack.

**Forward-only SQLite migrations with stable hashes.** The schema-version
gate plus content-addressed asset hashes make it safe to add
modality-specific tables without touching any existing row. Segment-level
FTS5 mirroring is a known pattern in the codebase.

**Existing inference registry with GGUF cache.** `engine/inference.ts`
already manages a content-addressed cache under `~/.cache/kindx/models/`.
Adding Whisper.cpp, a vision GGUF, and a Tesseract data bundle is an
extension of an existing pattern, not a new subsystem.

**Hybrid retrieval is already shape-agnostic.**
`engine/repository/retrieval/hybrid.ts` operates on `(chunk_id, text,
embedding, metadata)` tuples. As long as modality segments materialise
into the same shape with a `media_kind` field and a time offset, they
slot into the existing BM25 + vector + reranker pipeline without
rewriting the retrieval core.

**MCP and HTTP surfaces follow a registry pattern.** Adding new tools and
routes is purely additive on `tool-registry.ts` and the protocol layer.

The dollar-value opportunity: KINDX becomes the obvious choice for any
team whose multimodal-to-text pipeline is currently bolted together out
of cloud APIs and shell scripts. The technical opportunity: the required
surface is small (a dozen new files, one migration, a handful of additive
Zod schemas) relative to the user-visible gain.

## User stories

**Alex, security-conscious engineering manager.** Runs a 30-person team at
a healthcare company. Meeting recordings, design screenshots, and screen
shares must never leave company-owned hardware. Alex points KINDX at the
team's shared drive, sets `local-only on` (now the default), and runs
`kindx ingest media ~/Recordings/`. The pipeline transcribes, captions,
OCRs, and indexes without opening a socket beyond model download — and
even that can be served from an internal mirror.

**Bea, agent platform engineer.** Building an internal agent that answers
questions about product decisions, many of which live in recorded
leadership syncs and dashboard screenshots. Bea wires the agent to KINDX
over MCP and calls `media.search` with a kind filter and time range:
"transcript segments mentioning the Q4 forecast from videos modified in
the last seven days". The agent receives time-aligned segments with
millisecond offsets and renders deep links that open the source video at
the right timestamp.

**Carla, designer.** Maintains a corpus of design screenshots, each
annotated by date and project. Carla wants to search by visible text ("any
screenshot where I used 'sign up for free' as a primary CTA"). OCR-based
ingestion makes that query possible locally.

**Dmitri, support engineer.** His queue is full of stack-trace screenshots.
`kindx query "TypeError: Cannot read properties of undefined reading apply"`
returns the screenshots in which that exact string was visible — without
ever copy-pasting the error.

**Eli, voice-memo writer.** Records voice memos while walking. `kindx
query "the bit where I described the new onboarding flow"` returns a
transcript segment with a play button. Native Whisper covers this without
a third-party transcription service.

## Proposed UX

The UX is shaped by three commitments. First, **media ingestion is just
ingestion**: `kindx ingest <path>` over a directory containing mixed text,
audio, video, and image files Just Works. The `kindx ingest media`
subcommand exists only to pin a specific kind or override model and
sampling parameters. Second, **media search is just search**: `kindx query
"<terms>"` returns hybrid results across text and media segments alike;
`kindx media search` exists only to scope by kind or time range. Third,
**local-only is the default and surfaces visibly**: the first media-related
invocation prints `local-only mode active; remote backends require
--allow-remote`. There is no other prompt; users who want remote backends
opt in explicitly.

The user does not need to know that a video became (transcript_segments × N,
frame_caption_segments × M, thumbnail_blobs × K); those details are exposed
only on request (`--segments`, `--thumbnails`). For long-running
extractions, KINDX surfaces progress over SSE for HTTP callers and as
incremental stderr lines for the CLI. The CLI exit code is 0 if and only if
every segment landed in the index and every embedding was computed.

## CLI design

All new CLI surfaces accept `--json` and return a stable schema documented in
`packages/kindx-schemas`. All numeric durations are in milliseconds. All
times in machine-readable output are ISO-8601 UTC. The defaults below match
the implementation defaults in `engine/media/policy.ts`.

```
kindx ingest media <path...> [options]
  --kind auto|image|audio|video|screenshot   default: auto (detect by header + extension)
  --fps N                                    default: 1     (video frame sampling rate)
  --lang en|multi                            default: en    (multi enables auto-detect in whisper)
  --ocr-engine tesseract|paddle              default: tesseract
  --whisper-model tiny|base|small|medium|large  default: tiny
  --vision-model <registry-name>             default: kindx-vision-default
  --collection <name>                        default: inferred from path
  --thumbnails on|off                        default: on    (PNG thumbnails for video frames)
  --max-duration <seconds>                   default: policy.max_duration_sec
  --max-resolution <p>                       default: policy.max_resolution_p
  --allow-remote                             requires KINDX_ALLOW_REMOTE=1
  --json
```

```
kindx media list [--collection <c>] [--kind image|audio|video|screenshot]
                 [--since <iso>] [--until <iso>] [--limit N=50] [--json]
```

Lists asset rows from `media_assets`, optionally filtered. The default sort
is `ingested_at DESC`. The `--json` form returns
`{ assets: KindxMediaAssetSchema[], total: number }`.

```
kindx media show <hash|path> [--segments] [--thumbnails] [--json]
```

Resolves the input to an asset hash (path is normalised; both absolute and
relative paths supported) and prints metadata. With `--segments`, also prints
the full segment list (transcript, captions, OCR, frame summaries) in
chronological order with start_ms / end_ms columns. With `--thumbnails`,
prints sequence numbers and `taken_at_ms` timestamps but not the blob bytes
(use the HTTP endpoint for bytes).

```
kindx media transcribe <path> [--lang en|multi] [--whisper-model tiny|base|small|medium|large]
                              [--json]
```

One-shot transcription of an audio or video file. Does **not** ingest into
the index. Used as a building block (and for ad-hoc CLI use). The default
output is human-readable; `--json` returns
`{ segments: KindxMediaSegmentSchema[], modelHash: string, durationMs: number }`.

```
kindx media caption <path> [--vision-model <name>] [--frames N=1]
                           [--json]
```

One-shot vision captioning of an image, screenshot, or video file. For
video, samples N evenly-spaced frames and captions each.

```
kindx media segments <hash> [--from-ms N] [--to-ms M]
                            [--kind transcript|caption|ocr|frame_summary]
                            [--json]
```

Range query against `media_segments`. Used by agents that want a slice of a
known asset (e.g., "give me the 30-second window around the timestamp the
user clicked on").

```
kindx media search "<query>" [--kind image|audio|video|screenshot]
                             [--from <iso>] [--to <iso>]
                             [--collection <c>]
                             [--limit N=20] [--json]
```

Hybrid search restricted to media segments. Returns segments with their
parent asset metadata so the caller can construct deep links.

```
kindx media pull [whisper-tiny|whisper-base|whisper-small|whisper-medium|whisper-large
                  |vision-llava|vision-phi3|tesseract-eng|tesseract-all
                  |paddle-ocr-lite] [--mirror <url>] [--json]
```

Downloads the named local model into `~/.cache/kindx/models/` using the
existing inference cache machinery. Mirrors the existing `kindx pull` CLI
surface (used for embeddinggemma / qwen3) but accepts media-pipeline
identifiers.

```
kindx media policy get [--json]
kindx media policy set [--local-only on|off]
                       [--max-duration <sec>]
                       [--max-resolution <p>]
                       [--strip-audio on|off]
                       [--json]
```

`policy get` reads the single-row `media_policies` table. `policy set`
upserts; only specified flags change. `local-only off` requires
confirmation (`--yes` to skip the prompt in non-interactive use). When
`local-only` flips off, the next ingestion run prints a one-line warning to
stderr.

The existing `kindx query "<terms>"` is unchanged in surface. Internally it
now includes media segments in its candidate pool. Callers who want to
exclude media can pass `--kind text` (new alias).

## MCP design

All MCP tools follow the existing convention in `engine/protocol.ts`:
JSON-Schema-derived from Zod, idempotent where possible, and registered via
`tool-registry.ts`. The new tools are:

```
media.ingest
  input  : KindxMediaIngestInputSchema
           { paths: string[], kind?: 'auto'|'image'|'audio'|'video'|'screenshot',
             fps?: number, lang?: 'en'|'multi',
             ocrEngine?: 'tesseract'|'paddle',
             whisperModel?: 'tiny'|'base'|'small'|'medium'|'large',
             visionModel?: string,
             collection?: string,
             thumbnails?: boolean,
             maxDurationSec?: number,
             maxResolutionP?: number,
             allowRemote?: boolean }
  output : { ingested: KindxMediaAssetSchema[],
             skipped: { path: string, reason: string }[],
             runs: KindxMediaExtractorRunSchema[] }

media.list
  input  : { collection?: string, kind?: MediaKind,
             since?: string, until?: string, limit?: number, cursor?: string }
  output : { assets: KindxMediaAssetSchema[], nextCursor?: string }

media.show
  input  : { hash?: string, path?: string,
             segments?: boolean, thumbnails?: boolean }
  output : { asset: KindxMediaAssetSchema,
             segments?: KindxMediaSegmentSchema[],
             thumbnails?: KindxMediaThumbnailRefSchema[] }

media.transcribe
  input  : { path: string, lang?: 'en'|'multi',
             whisperModel?: string }
  output : { segments: KindxMediaSegmentSchema[],
             modelHash: string, durationMs: number }

media.caption
  input  : { path: string, visionModel?: string, frames?: number }
  output : { captions: KindxMediaSegmentSchema[], modelHash: string }

media.segments
  input  : { hash: string, fromMs?: number, toMs?: number,
             kind?: 'transcript'|'caption'|'ocr'|'frame_summary' }
  output : { segments: KindxMediaSegmentSchema[] }

media.search
  input  : KindxMediaSearchInputSchema
           { query: string,
             mediaKinds?: MediaKind[],
             timeRange?: { fromMs?: number, toMs?: number },
             modifiedRange?: { from?: string, to?: string },
             collection?: string,
             limit?: number }
  output : { hits: KindxMediaSearchHitSchema[] }   /* segment + asset summary */

media.policy.get
  input  : {}
  output : KindxMediaPolicySchema

media.policy.set
  input  : Partial<KindxMediaPolicySchema> & { confirm?: boolean }
  output : KindxMediaPolicySchema
```

`media.ingest` is the only tool that may take an arbitrary amount of time;
it streams progress events over the MCP `notifications/progress` channel
keyed by the asset hash, allowing UIs to render a progress bar per file.

Tool descriptions (the human-facing strings) are written so a model can
choose between `media.transcribe` (one-shot, no index) and `media.ingest`
(persistent, indexed) without confusion. Both descriptions cross-reference
each other.

## HTTP API design

The HTTP layer mirrors the MCP surface. Routes are mounted under `/media/`
and all use JSON request/response bodies except where noted. Long-running
ingestion is exposed via SSE for clients that want progress.

```
POST /media/ingest
  body (json): KindxMediaIngestInputSchema with `paths`
       (paths must already be readable by the engine)
  body (multipart): one or more file parts; engine stages to a temp dir
       and treats the staged paths as inputs.
  response: 202 Accepted, { runId: string,
                            assets: { path: string, hash?: string,
                                      status: 'queued'|'extracted'|'failed' }[] }

GET /media/:hash
  response: KindxMediaAssetSchema
  query: ?segments=1 to include segments,
         ?thumbnails=1 to include thumbnail refs (not blobs).

GET /media/:hash/segments
  query: ?fromMs=&toMs=&kind=
  response: { segments: KindxMediaSegmentSchema[] }

GET /media/:hash/thumbnails
  response: stream of PNG blobs as a multipart/mixed body, or
            individual blobs at /media/:hash/thumbnails/:seq

POST /media/transcribe
  body: { path?: string, ... } or multipart for direct upload
  response: { segments: KindxMediaSegmentSchema[], modelHash, durationMs }

POST /media/caption
  body: { path?: string, ... } or multipart
  response: { captions: KindxMediaSegmentSchema[], modelHash }

POST /media/search
  body: KindxMediaSearchInputSchema
  response: { hits: KindxMediaSearchHitSchema[] }

GET  /media/policies
POST /media/policies
  body: Partial<KindxMediaPolicySchema>
  response: KindxMediaPolicySchema

GET /media/:hash/progress (SSE)
  events: { type: 'started', extractor, at },
          { type: 'progress', completedMs, totalMs },
          { type: 'segment', segment: KindxMediaSegmentSchema },
          { type: 'finished', status: 'success'|'failed', at, error? }
```

Authentication and authorisation reuse the existing KINDX HTTP layer. The
local-only policy is enforced before any extractor is invoked, so even a
multipart upload to `/media/ingest` cannot trigger a remote backend unless
the request includes `--allow-remote` semantics (`X-Kindx-Allow-Remote: 1`
header, plus the server having `KINDX_ALLOW_REMOTE=1` in its environment).

Streaming responses (SSE) are sent with `Cache-Control: no-store` and
`X-Accel-Buffering: no`. The SSE channel closes on the first `finished`
event or on client disconnect; the server cleans up the in-flight extractor
on disconnect.

## Schema changes

All schema additions live in `packages/kindx-schemas/src/index.ts` and are
re-exported from `packages/kindx-client/src/index.ts`. Existing schemas are
not modified.

```
export const MediaKindSchema = z.enum([
  'image', 'audio', 'video', 'screenshot',
]);
export type MediaKind = z.infer<typeof MediaKindSchema>;

export const MediaSegmentKindSchema = z.enum([
  'transcript', 'caption', 'ocr', 'frame_summary',
]);

export const KindxMediaAssetSchema = z.object({
  hash: z.string().regex(/^[a-f0-9]{64}$/),
  collection: z.string(),
  path: z.string(),
  kind: MediaKindSchema,
  bytes: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative().nullable(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  codec: z.record(z.string(), z.unknown()).nullable(),
  createdAt: z.string(),    // ISO-8601 UTC; from filesystem mtime
  ingestedAt: z.string(),   // ISO-8601 UTC; when the engine processed it
  status: z.enum(['queued', 'extracting', 'indexed', 'failed', 'skipped']),
  error: z.record(z.string(), z.unknown()).nullable(),
});

export const KindxMediaSegmentSchema = z.object({
  assetHash: z.string(),
  seq: z.number().int().nonnegative(),
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().nonnegative(),
  kind: MediaSegmentKindSchema,
  text: z.string(),
  embeddingRef: z.string().nullable(),
  confidence: z.number().min(0).max(1),
});

export const KindxMediaThumbnailRefSchema = z.object({
  assetHash: z.string(),
  seq: z.number().int().nonnegative(),
  takenAtMs: z.number().int().nonnegative(),
  byteLength: z.number().int().nonnegative(),
});

export const KindxMediaExtractorRunSchema = z.object({
  id: z.string(),
  assetHash: z.string(),
  extractor: z.enum([
    'whisper', 'video-frames', 'vision-caption',
    'ocr-tesseract', 'ocr-paddle',
  ]),
  model: z.string(),
  modelSha256: z.string(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  status: z.enum(['running', 'success', 'failed', 'cancelled']),
  warnings: z.array(z.string()).default([]),
});

export const KindxMediaPolicySchema = z.object({
  localOnly: z.boolean().default(true),
  maxDurationSec: z.number().int().positive().nullable().default(null),
  maxResolutionP: z.number().int().positive().nullable().default(null),
  stripAudio: z.boolean().default(false),
  updatedAt: z.string(),
});

export const KindxMediaIngestInputSchema = z.object({
  paths: z.array(z.string()).min(1),
  kind: z.union([z.literal('auto'), MediaKindSchema]).default('auto'),
  fps: z.number().positive().default(1),
  lang: z.enum(['en', 'multi']).default('en'),
  ocrEngine: z.enum(['tesseract', 'paddle']).default('tesseract'),
  whisperModel: z.enum(['tiny','base','small','medium','large']).default('tiny'),
  visionModel: z.string().optional(),
  collection: z.string().optional(),
  thumbnails: z.boolean().default(true),
  maxDurationSec: z.number().int().positive().optional(),
  maxResolutionP: z.number().int().positive().optional(),
  allowRemote: z.boolean().default(false),
});

export const KindxMediaSearchInputSchema = z.object({
  query: z.string().min(1),
  mediaKinds: z.array(MediaKindSchema).optional(),
  timeRange: z.object({
    fromMs: z.number().int().nonnegative().optional(),
    toMs: z.number().int().nonnegative().optional(),
  }).optional(),
  modifiedRange: z.object({
    from: z.string().optional(),
    to: z.string().optional(),
  }).optional(),
  collection: z.string().optional(),
  limit: z.number().int().positive().max(200).default(20),
});

export const KindxMediaSearchHitSchema = z.object({
  segment: KindxMediaSegmentSchema,
  asset: KindxMediaAssetSchema,
  score: z.number(),
  rerankScore: z.number().nullable(),
});
```

Existing types in `kindx-schemas` are untouched. Consumers on older versions
of the client continue to work; they simply do not see the media types.

## Storage / index changes

A single forward-only migration (`engine/migrations/00X_media_assets.sql`,
sequence number determined at branch merge) adds five tables and one FTS5
virtual table, plus indexes. The migration bumps `KINDX_SCHEMA_VERSION`.

```sql
-- 00X_media_assets.sql

CREATE TABLE IF NOT EXISTS media_assets (
  hash         TEXT    PRIMARY KEY,
  collection   TEXT    NOT NULL,
  path         TEXT    NOT NULL,
  kind         TEXT    NOT NULL
    CHECK (kind IN ('image','audio','video','screenshot')),
  bytes        INTEGER NOT NULL,
  duration_ms  INTEGER,
  width        INTEGER,
  height       INTEGER,
  codec_json   TEXT,
  created_at   INTEGER NOT NULL,
  ingested_at  INTEGER NOT NULL,
  status       TEXT    NOT NULL
    CHECK (status IN ('queued','extracting','indexed','failed','skipped')),
  error_json   TEXT
);

CREATE INDEX IF NOT EXISTS idx_media_assets_collection_kind
  ON media_assets(collection, kind);
CREATE INDEX IF NOT EXISTS idx_media_assets_status
  ON media_assets(status);
CREATE INDEX IF NOT EXISTS idx_media_assets_created_at
  ON media_assets(created_at);

CREATE TABLE IF NOT EXISTS media_segments (
  asset_hash    TEXT    NOT NULL REFERENCES media_assets(hash) ON DELETE CASCADE,
  seq           INTEGER NOT NULL,
  start_ms      INTEGER NOT NULL,
  end_ms        INTEGER NOT NULL,
  kind          TEXT    NOT NULL
    CHECK (kind IN ('transcript','caption','ocr','frame_summary')),
  text          TEXT    NOT NULL,
  embedding_ref TEXT,
  confidence    REAL    NOT NULL DEFAULT 1.0,
  PRIMARY KEY (asset_hash, seq)
);

CREATE INDEX IF NOT EXISTS idx_media_segments_kind
  ON media_segments(asset_hash, kind);
CREATE INDEX IF NOT EXISTS idx_media_segments_start_ms
  ON media_segments(start_ms);

CREATE VIRTUAL TABLE IF NOT EXISTS media_segments_fts
  USING fts5(
    text,
    content='media_segments',
    content_rowid='rowid',
    tokenize='porter unicode61'
  );

-- triggers to keep the FTS table in sync
CREATE TRIGGER IF NOT EXISTS media_segments_ai
AFTER INSERT ON media_segments BEGIN
  INSERT INTO media_segments_fts(rowid, text)
    VALUES (new.rowid, new.text);
END;
CREATE TRIGGER IF NOT EXISTS media_segments_ad
AFTER DELETE ON media_segments BEGIN
  INSERT INTO media_segments_fts(media_segments_fts, rowid, text)
    VALUES('delete', old.rowid, old.text);
END;
CREATE TRIGGER IF NOT EXISTS media_segments_au
AFTER UPDATE ON media_segments BEGIN
  INSERT INTO media_segments_fts(media_segments_fts, rowid, text)
    VALUES('delete', old.rowid, old.text);
  INSERT INTO media_segments_fts(rowid, text) VALUES (new.rowid, new.text);
END;

CREATE TABLE IF NOT EXISTS media_thumbnails (
  asset_hash   TEXT    NOT NULL REFERENCES media_assets(hash) ON DELETE CASCADE,
  seq          INTEGER NOT NULL,
  taken_at_ms  INTEGER NOT NULL,
  png_blob     BLOB    NOT NULL,
  PRIMARY KEY (asset_hash, seq)
);

CREATE TABLE IF NOT EXISTS media_extractor_runs (
  id            TEXT    PRIMARY KEY,
  asset_hash    TEXT    NOT NULL REFERENCES media_assets(hash) ON DELETE CASCADE,
  extractor     TEXT    NOT NULL,
  model         TEXT    NOT NULL,
  model_sha256  TEXT    NOT NULL,
  started_at    INTEGER NOT NULL,
  finished_at   INTEGER,
  status        TEXT    NOT NULL
    CHECK (status IN ('running','success','failed','cancelled')),
  warnings_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_media_extractor_runs_asset
  ON media_extractor_runs(asset_hash);

CREATE TABLE IF NOT EXISTS media_policies (
  id                INTEGER PRIMARY KEY CHECK (id = 1),
  local_only        INTEGER NOT NULL DEFAULT 1,
  max_duration_sec  INTEGER,
  max_resolution_p  INTEGER,
  strip_audio       INTEGER NOT NULL DEFAULT 0,
  updated_at        INTEGER NOT NULL
);

INSERT OR IGNORE INTO media_policies(id, local_only, updated_at)
  VALUES (1, 1, strftime('%s','now') * 1000);
```

Embedding vectors continue to live in the existing `chunk_embeddings` table
(or its sqlite-vec virtual sibling). `media_segments.embedding_ref` is a
string handle into that table (typically `media:{asset_hash}:{seq}`). This
gives us a single vector space across text chunks and media segments
without duplicating storage.

Cascade deletes ensure that purging an asset cleans up segments, thumbnails,
and extractor run records. The embedding rows are cleaned up via the
existing chunk-embedding GC sweep, which already understands stale
`embedding_ref` keys.

The migration is forward-only. Rollback is documented as "drop the new
tables manually" and is not automated, consistent with the existing
migration policy.

## Implementation plan

The work decomposes into eleven phases. Each phase ends with a green
Vitest run on the corresponding spec file and on the existing suite. The
phases are ordered so that each one is independently mergeable behind a
feature flag (`KINDX_MEDIA=1`) until the surface is fully wired.

**Phase 1 — Model registry and downloader.** Extend `engine/inference.ts`
with `DEFAULT_WHISPER_MODEL_URI`, `DEFAULT_VISION_MODEL_URI`,
`DEFAULT_OCR_BUNDLE_URI`. Add the `kindx media pull` CLI subcommand and the
shared `pullMediaModel(name)` helper. Validate SHA-256 of each downloaded
blob against the registry. Spec: extend existing inference tests with new
defaults.

**Phase 2 — Local-only policy guard.** Add `engine/policy/local-only.ts`
with `assertLocalOnly(context)`. Add the `media_policies` table and a small
`engine/media/policy.ts` accessor (`getPolicy`, `setPolicy`). Every extractor
in subsequent phases takes a `PolicyContext` and calls `assertLocalOnly()`
before any potentially-remote operation. Spec:
`specs/media-policy-local-only.test.ts`.

**Phase 3 — Whisper extractor.** Add `engine/media/audio-whisper.ts`. It
takes a path to an audio file (or a path that ffmpeg can extract audio
from), invokes whisper.cpp on the resolved input, and returns
`KindxMediaSegmentSchema[]` with `kind='transcript'`. The implementation
shells out to a bundled `whisper-cli` binary when available and falls back
to the `node-llama-cpp` whisper bindings otherwise. Spec:
`specs/media-audio-whisper.test.ts` using a bundled 5-second WAV fixture.

**Phase 4 — Video frame sampler.** Add `engine/media/video-frames.ts`
which uses ffmpeg (lazy-required) to (a) decode the audio track to a
temporary WAV for the Whisper extractor and (b) sample frames at the
configured fps into PNG buffers. Emits `(frame_index, taken_at_ms, png)` 
tuples. Spec: `specs/media-video-frames.test.ts` using a 10-second MP4
fixture.

**Phase 5 — Vision captioning and OCR.** Add
`engine/media/vision-caption.ts` (LLaVA/Phi-3-Vision via node-llama-cpp)
and `engine/media/ocr.ts` (Tesseract.wasm first; PaddleOCR-lite as
opt-in). Both take a PNG buffer and return one or more
`KindxMediaSegmentSchema` rows (`kind='caption'` or `kind='ocr'`). Specs:
`specs/media-vision-caption.test.ts`, `specs/media-ocr.test.ts`.

**Phase 6 — Segment store and embeddings.** Add `engine/media/store.ts`
with `upsertAsset`, `upsertSegments`, `attachThumbnails`,
`recordExtractorRun`. Wire `embedding_ref` writes through
`engine/repository/embeddings.ts` so segments share the same vector index
as text chunks. Add `engine/media/thumbnails.ts` for PNG size capping and
optional storage. Specs: `specs/media-segment-store.test.ts`,
`specs/media-thumbnails.test.ts`, `specs/media-embedding-parity.test.ts`.

**Phase 7 — Pipeline orchestration.** Add `engine/media/pipeline.ts`
which composes Phases 3–6 based on detected `kind`. The pipeline takes a
single asset path, produces an asset row, a segment list, a thumbnail
list, and an extractor-run audit trail. Cancellation, progress events,
and per-asset error handling are concentrated here.

**Phase 8 — Search integration.** Add `engine/media/search.ts` and extend
`engine/repository/retrieval/hybrid.ts` with `mediaKinds?` and `timeRange?`
parameters. The hybrid path now joins `media_segments_fts` and
`media_segments` alongside the existing text chunk path. Spec:
`specs/media-hybrid-search.test.ts`.

**Phase 9 — CLI, MCP, HTTP wiring.** Register all new tools and routes.
Surface `--json` everywhere. Implement SSE progress on
`GET /media/:hash/progress`. The CLI subcommand parser lives next to the
existing one in `engine/kindx.ts`.

**Phase 10 — Watcher integration.** Extend `engine/watcher.ts` to
recognise media extensions and queue ingestion jobs into the pipeline.
The watcher respects the policy (`local_only`, `max_duration_sec`,
`max_resolution_p`). Spec: `specs/media-watcher-integration.test.ts`.

**Phase 11 — Documentation, demo, and migration.** Update the user-facing
documentation in `docs/`, add a short demo script under `scripts/`, and
ensure the migration runs cleanly on an existing v1.3.5 database. Bump
the version to v1.4.0-rc.1.

The branch may merge progressively: Phases 1–6 land first behind
`KINDX_MEDIA=1`. Phase 8 turns hybrid search media-aware. Phases 9–11 ship
the final user-visible surface and flip the default to `KINDX_MEDIA=1`.

## File-by-file changes

**New files.**

- `engine/media/pipeline.ts` — top-level orchestration. Exports
  `ingestMediaPath(path, opts, ctx)`. Handles kind detection, policy
  enforcement, extractor selection, progress events, retry. ~350 lines.
- `engine/media/audio-whisper.ts` — Whisper.cpp integration. Exports
  `transcribeAudio`. Handles model resolution, language detection,
  segment boundary cleanup (collapses silence; splits on > 30 s). ~250 lines.
- `engine/media/video-frames.ts` — ffmpeg-based frame sampler and audio
  demuxer. Exports `sampleFrames` and `extractAudioTrack`. Lazily binds
  to ffmpeg. ~200 lines.
- `engine/media/vision-caption.ts` — Vision model integration. Exports
  `captionImage`. Keeps the model warm across frames of one video. ~180 lines.
- `engine/media/ocr.ts` — OCR engine integration. Exports `ocrImage`,
  returning one segment per detected text block when bounding boxes are
  available. Layout-aware chunking groups adjacent text. ~220 lines.
- `engine/media/store.ts` — DB writes. Exports `upsertAsset`,
  `upsertSegments`, `attachThumbnails`, `recordExtractorRun`,
  `loadAsset`, `listAssets`, `loadSegments`, `purgeAsset`. Tx-aware.
  ~200 lines.
- `engine/media/search.ts` — segment search. Exports
  `searchMediaSegments`. Composes BM25 hits from `media_segments_fts`
  with vector hits from the shared embedding table; reranks if
  configured. ~180 lines.
- `engine/media/policy.ts` — policy table accessor. Exports `getPolicy`,
  `setPolicy`, `defaultPolicy`. Caches the single row per pipeline run.
  ~80 lines.
- `engine/media/thumbnails.ts` — `compressThumbnail` (≤ 240 px long
  edge) and `shouldStoreThumbnail`. Per-asset blob budget. ~80 lines.
- `engine/embeddings/family.ts` — `EmbeddingFamily` type (`'text' |
  'image' | 'audio_transcript' | 'video_caption' | 'ocr'`) and
  `resolveEmbedder(family, ctx)`. Default maps everything except
  `image` to the existing text embedder. ~100 lines.
- `engine/policy/local-only.ts` — `assertLocalOnly(action, ctx)` and
  `LocalOnlyViolationError`. Records bypasses with timestamp, action,
  caller into the audit log. ~60 lines.
- `engine/migrations/00X_media_assets.sql` — schema migration above.

**Edited files.**

- `engine/ingestion.ts` — extend the router to dispatch `.mp3`, `.wav`,
  `.m4a`, `.flac`, `.ogg`, `.aac`, `.mp4`, `.mov`, `.webm`, `.mkv`,
  `.png`, `.jpg`, `.jpeg`, `.heic`, `.webp` to the media pipeline.
  Existing text/PDF/DOCX paths unchanged.
- `engine/inference.ts` — add `DEFAULT_WHISPER_MODEL_URI`,
  `DEFAULT_VISION_MODEL_URI`, `DEFAULT_OCR_BUNDLE_URI` and the env
  overrides. Extend the `kindx pull` resolver.
- `engine/repository/chunking.ts` — add a `segment-aware` mode that
  treats segments as pre-chunked input, bypassing the token chunker.
- `engine/repository/embeddings.ts` — accept optional `family` on
  `embedChunks`; default unchanged.
- `engine/watcher.ts` — add media extensions and trigger
  `ingestMediaPath`. Reuse the existing debounce window.
- `engine/repository/retrieval/hybrid.ts` — accept `mediaKinds?` and
  `timeRange?`. Default behaviour unchanged.
- `engine/protocol.ts` — register the new MCP tools and HTTP routes.
- `engine/tool-registry.ts` — add the nine new tool entries.
- `engine/kindx.ts` — add the new CLI subcommands.
- `packages/kindx-schemas/src/index.ts` — additive exports.
- `packages/kindx-client/src/index.ts` — additive typed client methods.

**New tests.**

- `specs/media-audio-whisper.test.ts` — 5 s WAV; CER under target;
  respects `--whisper-model` override.
- `specs/media-video-frames.test.ts` — frame sampling at 1 fps and 2 fps;
  timestamp accuracy ±50 ms; audio track extraction yields a valid WAV.
- `specs/media-vision-caption.test.ts` — captioning a PNG; model warm
  across sequential calls.
- `specs/media-ocr.test.ts` — OCR Levenshtein < 5% of reference.
- `specs/media-segment-store.test.ts` — round-trips assets, segments,
  thumbnails, runs; cascade delete works.
- `specs/media-hybrid-search.test.ts` — mixed text + media result set;
  `mediaKinds` and `timeRange` filters narrow correctly.
- `specs/media-watcher-integration.test.ts` — a dropped .mp4 triggers
  pipeline ingestion within the debounce window.
- `specs/media-policy-local-only.test.ts` — every extractor calls
  `assertLocalOnly()`; bypass requires both env and CLI flag; bypass is
  audit-logged.
- `specs/media-embedding-parity.test.ts` — transcripts, captions, OCR,
  and plain text share the vector space (canned cosine similarity).
- `specs/media-thumbnails.test.ts` — size cap, per-asset budget, absent
  thumbnails do not break `media.show`.

**Fixtures.** `specs/fixtures/media/sample.wav` (5s, "the quick brown fox"
spoken voice), `specs/fixtures/media/sample.mp4` (10s, sample-video.org
CC0 sample), `specs/fixtures/media/sample.png` (UI screenshot showing
known text strings). Each is committed (small) or referenced via the
existing fixture-downloader helper if size-prohibitive.

## Test plan

The test plan has three layers. Each layer must be green for a phase to
merge.

**Unit tests.** Every new module owns a `specs/media-*.test.ts` file with
mock-free, deterministic tests. Whisper, vision, and OCR tests use small
bundled fixtures and pin model versions via `KINDX_WHISPER_MODEL`,
`KINDX_VISION_MODEL`, `KINDX_OCR_ENGINE`. Each test runs the full
extractor against the fixture and asserts against a recorded baseline
(stored in `specs/fixtures/media/baselines/`). Baselines are regenerated
by `npm run baseline:media` when the underlying model is intentionally
bumped.

**Integration tests.** `specs/media-hybrid-search.test.ts` ingests one of
each modality (text + audio + video + screenshot) into a fresh test
database and runs the hybrid query path. The test asserts that the same
query string returns a mixed set of text chunks and media segments, that
`mediaKinds: ['audio']` narrows to transcript-only, and that
`timeRange: { fromMs: 1000, toMs: 5000 }` narrows by start_ms.

**End-to-end smoke.** `specs/media-watcher-integration.test.ts` writes
files into a temp directory under the watcher's purview and asserts that
each is ingested within the debounce window. A separate
`specs/media-policy-local-only.test.ts` runs the full pipeline with a
mocked HTTP transport that fails on any non-localhost connection;
ingestion must succeed unless the test explicitly enables
`--allow-remote`.

**Network isolation assertion.** Every media test runs under a
`NetworkSandbox` helper that intercepts all outbound HTTP and asserts no
non-loopback connection is opened. This is the test-level enforcement of
the local-only guarantee. The sandbox is permissive about model downloads
when the test pre-warms the cache; in CI the cache is warmed once before
the test suite runs.

**Performance sanity.** A separate Vitest file
(`specs/media-perf.test.ts`, opt-in via `KINDX_PERF=1`) measures
end-to-end ingestion time for the bundled fixtures and asserts they are
within a generous envelope (5 s audio under 10 s wall-clock on the
reference CPU; 10 s video under 60 s). This is not a release gate but
protects against major regressions.

**Schema migration test.** `specs/migration-media-assets.test.ts` runs
the migration against a snapshot of a v1.3.5 database, asserts that no
existing row is mutated, asserts that the new tables and indexes exist,
and asserts that re-running the migration is a no-op.

## Acceptance criteria

The branch is mergeable to `main` when **all** of the following hold.

1. The full media pipeline runs offline. `specs/media-policy-local-only.test.ts`
   passes with the `NetworkSandbox` enabled, demonstrating that no
   extractor (whisper, video-frames, vision-caption, ocr) opens a
   non-loopback connection in default configuration.
2. Whisper-tiny transcription of the bundled 5-second WAV achieves a
   character error rate below 6% against the recorded baseline.
3. Video frame sampling at 1 fps on the 10-second bundled MP4 yields ten
   frames with timestamps within ±50 ms of the expected `taken_at_ms`
   values.
4. OCR on the bundled screenshot fixture achieves a Levenshtein distance
   of less than 5% of the reference text length.
5. Media search (`kindx media search "<term>"`) returns time-aligned
   segments with non-null `start_ms` and `end_ms` for transcript, caption,
   and frame-summary kinds. OCR segments may use `start_ms = end_ms = 0`.
6. The chokidar watcher picks up a newly-dropped `.mp4` in a watched
   folder within one debounce interval (default 1500 ms) and the
   resulting asset row reaches `status='indexed'` within the
   pipeline-specific extraction time.
7. The default `kindx query "<terms>"` returns a hybrid result set that
   may include both text chunks and media segments, with reranker scores
   computed consistently across modalities.
8. Every new CLI subcommand supports `--json`, and the JSON output
   validates against the corresponding schema in
   `packages/kindx-schemas`.
9. The schema migration applies cleanly to a v1.3.5 database, leaves
   existing tables untouched, and is idempotent on re-run.
10. `KINDX_LOCAL_ONLY` defaults to `1` (enforced) and remote backends
    refuse to run unless `KINDX_ALLOW_REMOTE=1` is set in the process
    environment AND the calling surface passes `--allow-remote` (or the
    MCP / HTTP equivalent). Every bypass is recorded in the audit log
    with timestamp, caller, and action.
11. Vitest is green for the existing suite and for all new spec files.
12. The schemas package and client package compile under TypeScript ESM
    with the existing strict settings; `noUncheckedIndexedAccess` and
    `exactOptionalPropertyTypes` remain on.

## Risks

**Model size.** Whisper-tiny is ~75 MB; whisper-large is ~1.5 GB;
LLaVA-7B q4 is ~4 GB. Mitigation: `kindx media pull` is opt-in and
incremental; defaults select the smallest viable model per modality; a
`--profile minimal` shorthand pulls tiny + vision-phi3 + tesseract-eng
for ~1.2 GB total.

**ffmpeg dependency.** Video ingestion requires ffmpeg on the system
path. Mitigation: lazy-require inside `engine/media/video-frames.ts`;
clear error with install hints (Homebrew, apt, scoop) when missing;
audio-only and image-only workflows do not require it.

**Extraction time on large videos.** A one-hour 1080p video at 1 fps
sampling produces 3,600 frames to caption plus an hour of audio to
transcribe — 30+ minutes on a laptop. Mitigation: stream progress over
SSE / MCP `notifications/progress`; expose `--fps 0.2`; allow per-asset
cancellation; document the speed envelope.

**Thumbnail blob bloat.** PNG thumbnails per sampled frame can balloon
the database. Mitigation: thumbnails are opt-in; when enabled they are
downsampled to ≤ 240 px on the long edge; per-asset storage budget
defaults to 5 MB; thumbnails are GC-eligible without affecting segments.

**OCR quality on UI screenshots.** Tesseract is weaker on monospace
stack traces with mixed colours. Mitigation: `--ocr-engine paddle` as an
alternative; OCR confidence is exposed in `media_segments.confidence`
so callers can filter low-confidence segments.

**Codec coverage gaps.** Exotic formats (AV1 in certain containers, HEIF
live photos) may fall through. Mitigation: pipeline surfaces `failed`
with a specific error code; asset row is preserved so retries with a
newer ffmpeg succeed; failure does not abort the batch.

**Concurrency on shared resources.** Whisper plus vision can exhaust RAM.
Mitigation: per-host concurrency limit (default 1 video, 2 audio in
parallel) configurable via `KINDX_MEDIA_CONCURRENCY`.

**Model drift in baselines.** An upstream model bump can break tests.
Mitigation: baselines pinned to model SHA-256; `npm run baseline:media`
regenerates intentionally; CI caches by SHA.

**Backward compatibility.** New tables and routes are additive. Hybrid
retrieval adds optional parameters; default behaviour is preserved
bit-for-bit when absent. The only behaviour change is that `kindx
query` now considers media segments — intentional and documented.

**Local-only enforcement holes.** A bundled binary could open a socket.
Mitigation: the `NetworkSandbox` test helper enforces the property at
test time; the binaries we ship do not phone home; the audit log
records every model download (the only legitimate non-loopback
connection).

## Non-goals

The following are explicitly out of scope for the
`feat/local-first-multimodal-ingestion` branch. Each has a placeholder in
the future-extensions section.

**Speaker diarization.** The transcript output is a flat sequence of
segments without speaker labels. Diarization is a separate, larger
problem (pyannote-style models are bigger and require additional
inference passes). The schema is designed so that adding a `speaker_id`
column later is additive.

**Real-time microphone capture.** The pipeline is file-based. A live
microphone capture surface is out of scope; it requires a long-lived
audio process and a different progress model.

**Full video re-rendering.** We sample frames and decode audio but do
not produce re-rendered output (e.g., highlight reels, summary videos).
The thumbnail blob is the largest piece of binary output the pipeline
produces.

**GPU-only models.** Every default model must run acceptably on CPU.
GPU acceleration is allowed but never required. This is what keeps the
"local-first on consumer hardware" promise honest.

**Cloud Whisper / Vision / OCR APIs.** Even with `--allow-remote`, the
branch does not ship adapters to OpenAI Whisper, Anthropic Vision, or
Google Vertex. Those adapters can land later as plugins; the policy
guard is in place to make their addition safe.

**Cross-modal embedders.** We use the existing text embedder for all
modality-derived text (transcripts, captions, OCR). A native cross-modal
embedder (CLIP-style image+text in one vector space) is interesting but
not necessary to deliver the user value and is deferred.

**Search over thumbnail bytes.** Thumbnails exist for UI deep linking,
not for search. There is no vector index over thumbnail content.

## Future extensions

**Speaker diarization (`feat/diarization`).** Add a `speaker_id INTEGER`
to `media_segments`, ship a quantised pyannote-style model, and update
the transcript extractor to produce per-speaker segments.

**Live capture (`feat/live-capture`).** A `kindx media capture` command
that records from the system microphone or screen and streams into the
pipeline incrementally. Requires a new progress model and a way to
finalise partial assets.

**Multimodal embedding models (`feat/cross-modal-embeddings`).** Replace
the text embedder on captions and OCR segments with a model trained
jointly on text and image (e.g., a quantised CLIP). The
`EmbeddingFamily` abstraction is the seam where this lands.

**RAG-over-meeting chains (`feat/meeting-chains`).** Compose transcript
segments into per-meeting summary chains stored in the memory-graph
branch. A meeting becomes an entity whose attributes include
participants, topics, decisions, and action items, derived from the
underlying transcript.

**Video-aware reranker.** Use frame-level captions as additional signal
in the reranker to break ties between transcript segments. Requires the
reranker to accept multi-modal context; deferred until the reranker
branch lands.

**Heuristic chunk merging.** Adjacent transcript segments with high
embedding similarity could be merged into super-segments for retrieval,
trading granularity for relevance density. Deferred; current
fixed-segment behaviour is acceptable.

**Optional sqlite-vec partitioning.** As the segment count grows
(millions for heavy users), partitioning the vector index by modality
or collection may help. Deferred until we observe a real regression.

## Merge notes

This branch is additive. The merge story has three audiences.

**Core text path.** Untouched. `engine/repository/retrieval/hybrid.ts`
gains optional parameters; default behaviour is byte-identical. Existing
schemas and tests are unmodified.

**Provenance branch (`feat/signed-provenance`).** Composes cleanly.
Media assets carry the same provenance signature shape as text
documents; `media_assets.hash` is the signing identifier. The
provenance signer treats media assets as opaque blobs.

**Observability branch (`feat/structured-tracing`).** Each extractor run
is a span; the pipeline orchestrator emits a parent span with child
spans for whisper, frame-sampling, captioning, and OCR. Adds
`media.kind`, `media.duration_ms`, `media.extractor.model_sha256`
attributes.

**Memory-graph branch (`feat/memory-graph`).** Entities discovered in
transcripts (names, dates, project codes) become nodes via the existing
NER pass; the source attribute is the transcript segment, the parent
asset, and the offset.

**A2A peer branch (`feat/peer-dispatch`).** A peer can dispatch an
ingestion request, including media, to another KINDX node; the
receiving node's `assertLocalOnly()` still fires. The asset hash makes
cross-peer ingestion idempotent.

**Schema version bump.** The migration bumps `KINDX_SCHEMA_VERSION`. No
data migration is required because all new tables start empty.

**Configuration changes.** New env vars: `KINDX_WHISPER_MODEL`,
`KINDX_VISION_MODEL`, `KINDX_OCR_ENGINE`, `KINDX_ALLOW_REMOTE`,
`KINDX_MEDIA_CONCURRENCY`. `KINDX_LOCAL_ONLY` defaults to 1.

**Changelog (`v1.4.0`).** Native audio (Whisper.cpp), video (ffmpeg +
vision), and screenshot (Tesseract / Paddle) ingestion; embedding
parity across modalities; strict local-only default with auditable
`--allow-remote` opt-in; watcher and hybrid retrieval extended to media
kinds; new `media.*` MCP tools, HTTP routes, and CLI subcommands.
Backwards-compatible additive migration.

**Rollout.** Behind `KINDX_MEDIA=1` for one minor release. Default flips
to enabled in v1.5.0 unless telemetry suggests otherwise. Until the
flip, `kindx ingest` over media files emits `media ingestion available;
enable with KINDX_MEDIA=1`.

**Sequencing with the existing multimodal spec.** The in-flight
`docs/superpowers/specs/2026-05-22-multimodal-pipeline-design.md` lands
first because it introduces the image-caption infrastructure this
roadmap reuses. This roadmap's schemas are supersets of the in-flight
spec's structures. Merge order: existing-spec → media schemas → media
pipeline → media search → media CLI/MCP/HTTP → media watcher.

**Open questions for review.** Thumbnail blob storage (inline vs sidecar):
recommend inline for v1.4. Score parity between `media.search` and `kindx
query`: recommend identical for v1.4. Audit-log CLI: defer to a small
`kindx audit list` PR after this branch lands. Battery-aware watcher
pause: out of scope.

The branch is ready to start when the in-flight multimodal spec merges
and Phase 1 (model registry) is reviewed.
