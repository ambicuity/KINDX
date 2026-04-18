export async function runQueryCommand(args: {
  query: string;
  opts: unknown;
  runQuerySearch: (query: string, opts: unknown) => Promise<void>;
}): Promise<void> {
  const { query, opts, runQuerySearch } = args;
  if (!query) {
    throw new Error("Usage: kindx query [options] <query>");
  }
  await runQuerySearch(query, opts);
}

export async function executeQueryCommand(args: {
  query: string;
  opts: unknown;
  runQuerySearch: (query: string, opts: unknown) => Promise<void>;
  stderr?: NodeJS.WritableStream;
}): Promise<number> {
  const err = args.stderr ?? process.stderr;
  try {
    await runQueryCommand({
      query: args.query,
      opts: args.opts,
      runQuerySearch: args.runQuerySearch,
    });
    return 0;
  } catch (e: any) {
    err.write(`Error: ${e?.message || e}\n`);
    return 1;
  }
}
