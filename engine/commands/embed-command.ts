export async function runEmbedCommand(args: {
  force: boolean;
  resume: boolean;
  runVectorIndex: (model: string | undefined, force: boolean, resume: boolean) => Promise<void>;
}): Promise<void> {
  await args.runVectorIndex(undefined, args.force, args.resume);
}

export async function executeEmbedCommand(args: {
  force: boolean;
  resume: boolean;
  runVectorIndex: (model: string | undefined, force: boolean, resume: boolean) => Promise<void>;
  stderr?: NodeJS.WritableStream;
}): Promise<number> {
  const err = args.stderr ?? process.stderr;
  try {
    await runEmbedCommand(args);
    return 0;
  } catch (e: any) {
    err.write(`Error: ${e?.message || e}\n`);
    return 1;
  }
}
