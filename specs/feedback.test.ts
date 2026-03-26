import { afterEach, describe, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createStore,
  insertContent,
  insertDocument,
  structuredSearch,
  insertFeedback,
  listFeedback,
  getFeedbackPenalty,
} from "../engine/repository.js";

const openStores: ReturnType<typeof createStore>[] = [];
const cleanupDirs: string[] = [];

async function createTestStore(prefix: string): Promise<ReturnType<typeof createStore>> {
  const dir = await mkdtemp(join(tmpdir(), `kindx-${prefix}-`));
  cleanupDirs.push(dir);
  const dbPath = join(dir, "index.sqlite");
  const store = createStore(dbPath);
  openStores.push(store);
  return store;
}

afterEach(async () => {
  while (openStores.length > 0) {
    const s = openStores.pop();
    s?.close();
  }
  while (cleanupDirs.length > 0) {
    const d = cleanupDirs.pop();
    if (!d) continue;
    await rm(d, { recursive: true, force: true });
  }
});

describe("corrective feedback", () => {
  test("stores and lists feedback with upsert semantics", async () => {
    const store = await createTestStore("feedback-list");
    insertFeedback(store.db, "Deploy k8s", "hash_a_0", -1);
    insertFeedback(store.db, "Deploy k8s", "hash_a_0", 1);

    const all = listFeedback(store.db);
    expect(all).toHaveLength(1);
    expect(all[0]?.query).toBe("deploy k8s");
    expect(all[0]?.signal).toBe(1);

    const filtered = listFeedback(store.db, "deploy");
    expect(filtered).toHaveLength(1);
  });

  test("applies negative penalty for matching query+hash", async () => {
    const store = await createTestStore("feedback-penalty");
    insertFeedback(store.db, "deploy", "hash_a_0", -1);
    insertFeedback(store.db, "deploy", "hash_a_1", -1);
    const penalty = getFeedbackPenalty(store.db, "deploy", "hash_a");
    expect(penalty).toBeLessThan(0);
    expect(penalty).toBeGreaterThanOrEqual(-0.3);
  });

  test("structured search demotes previously downvoted document on second pass", async () => {
    const backingStore = await createTestStore("feedback-structured");
    const now = new Date().toISOString();

    insertContent(backingStore.db, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "Deploy guide for Kubernetes rollouts", now);
    insertDocument(
      backingStore.db,
      "docs",
      "deploy-a.md",
      "Deploy A",
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      now,
      now,
    );
    insertContent(backingStore.db, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "Deployment checklist and troubleshooting", now);
    insertDocument(
      backingStore.db,
      "docs",
      "deploy-b.md",
      "Deploy B",
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      now,
      now,
    );

    const fakeStore: any = {
      db: backingStore.db,
      searchFTS: () => [
        {
          filepath: "kindx://docs/deploy-a.md",
          displayPath: "docs/deploy-a.md",
          title: "Deploy A",
          hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          docid: "aaaaaa",
          collectionName: "docs",
          modifiedAt: "",
          bodyLength: 40,
          body: "Deploy guide for Kubernetes rollouts",
          context: null,
          score: 0.95,
          source: "fts",
        },
        {
          filepath: "kindx://docs/deploy-b.md",
          displayPath: "docs/deploy-b.md",
          title: "Deploy B",
          hash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          docid: "bbbbbb",
          collectionName: "docs",
          modifiedAt: "",
          bodyLength: 42,
          body: "Deployment checklist and troubleshooting",
          context: null,
          score: 0.85,
          source: "fts",
        },
      ],
      searchVec: async () => [],
      rerank: async (_query: string, docs: { file: string; text: string }[]) =>
        docs.map((d) => ({ file: d.file, score: 0.8 })),
      getContextForFile: () => null,
    };

    const before = await structuredSearch(fakeStore, [{ type: "lex", query: "deploy" }], {
      limit: 2,
      candidateLimit: 2,
    });
    expect(before[0]?.file).toBe("kindx://docs/deploy-a.md");

    insertFeedback(backingStore.db, "deploy", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa_0", -1);

    const after = await structuredSearch(fakeStore, [{ type: "lex", query: "deploy" }], {
      limit: 2,
      candidateLimit: 2,
    });
    expect(after[0]?.file).toBe("kindx://docs/deploy-b.md");
  });
});
