/**
 * init-command.ts — Extracted 'kindx init' unified setup flow from kindx.ts
 *
 * Consolidates collection registration, metadata indexing, and embedding
 * generation into a single three-step guided workflow.
 */
import { resolve } from "path";
import { c } from "../utils/ui.js";

export interface InitDeps {
  /** Runs updateCollections() from kindx.ts */
  updateCollections: (filter: string, opts: { pull?: boolean }) => Promise<void>;
  /** Runs vectorIndex() from kindx.ts */
  vectorIndex: (model: string, force: boolean, resume: boolean) => Promise<void>;
  defaultGlob: string;
  defaultEmbedModel: string;
}

export async function runInitCommand(
  args: string[],
  values: Record<string, unknown>,
  deps: InitDeps,
): Promise<void> {
  const pwd = args[0] || process.cwd();
  const resolvedPwd = pwd === '.' ? process.cwd() : resolve(pwd);
  const globPattern = (values.mask as string) || deps.defaultGlob;
  const name = (values.name as string) || args[1];

  console.log(`\n${c.magenta}=== 1/3: Registering Collection ===${c.reset}`);
  let finalName = name;
  if (!finalName) {
    finalName = resolvedPwd.split('/').filter(Boolean).pop() || "default";
  }

  const { addCollection } = await import("../catalogs.js");
  try {
    addCollection(finalName, resolvedPwd, globPattern);
    console.log(`${c.green}✓${c.reset} Collection '${finalName}' registered at ${resolvedPwd}`);
  } catch (err: any) {
    if (err.message?.includes('already exists')) {
      console.log(`${c.yellow}!${c.reset} Collection '${finalName}' already exists. Proceeding to update...`);
    } else {
      throw err;
    }
  }

  console.log(`\n${c.magenta}=== 2/3: Indexing Metadata ===${c.reset}`);
  await deps.updateCollections(finalName, { pull: Boolean(values.pull) });

  console.log(`\n${c.magenta}=== 3/3: Generating Embeddings ===${c.reset}`);
  await deps.vectorIndex(deps.defaultEmbedModel, false, !!values.resume);

  console.log(`\n${c.green}✓ Setup complete! Run 'kindx search' or 'kindx query' to test.${c.reset}`);
}
