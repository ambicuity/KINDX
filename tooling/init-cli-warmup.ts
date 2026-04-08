/**
 * CLI-side warmup helper for KINDX local inference.
 *
 * Goal:
 * - Use withLLMSession lifecycle correctly.
 * - Avoid nested/double-await anti-patterns by explicit staged awaits.
 *
 * Usage:
 *   npx tsx tooling/init-cli-warmup.ts
 */

import { withLLMSession } from "../engine/inference.js";

async function main(): Promise<void> {
  const result = await withLLMSession(async (session) => {
    const embedProbe = await session.embed("KINDX warmup probe", { isQuery: true });

    const expansionProbe = await session.expandQuery("deployment reliability", {
      includeLexical: true,
    });

    const rerankProbe = await session.rerank("capital of france", [
      { file: "a.md", text: "Paris is the capital of France." },
      { file: "b.md", text: "Berlin is the capital of Germany." },
    ]);

    return {
      embedOk: !!embedProbe && Array.isArray(embedProbe.embedding),
      expandedCount: expansionProbe.length,
      rerankCount: rerankProbe.results.length,
      model: rerankProbe.model,
    };
  }, { maxDuration: 2 * 60 * 1000, name: "cli-warmup" });

  process.stdout.write(`${JSON.stringify({ warmed: true, ...result }, null, 2)}\n`);
}

main().catch((err) => {
  process.stderr.write(`init-cli-warmup failed: ${String(err)}\n`);
  process.exit(1);
});
