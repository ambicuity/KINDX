# Self-explanatory CLI

## Context

The KINDX dispatcher today is *abrupt* when the user gets something wrong:

- `kindx qury "auth"` → `Unknown command: qury` (no "did you mean?")
- `kindx collection --help` → nothing prints (the inline usage block only fires on `kindx collection help` or unknown subcommand)
- `kindx arch` (removed in v1.3) → generic `Unknown command: arch`, no pointer to the migration path
- `kindx query "auth" --color | less -R` → no ANSI (the `--color` flag is parsed but `useColor` is a module-level constant computed from `process.stdout.isTTY` at import time, so the flag never wins)

Each is a small papercut, but they all sit on the highest-frequency surface — the first ten seconds of a new user's session, or the moment an experienced user fat-fingers something. We've already invested in `KindxError` (code/why/fix envelopes), a polished progress reporter, and clickable result blocks. Closing these four gaps brings the dispatcher's first-touch UX in line with the rest of the CLI.

Outcome we want, with concrete examples:

```text
$ kindx qury "auth"
Unknown command: qury
  Did you mean: query?
Run 'kindx --help' for usage.

$ kindx collection --help
Usage: kindx collection <subcommand> [options]

Subcommands:
  add <name> --path <dir> --pattern <glob>   Add a new collection
  list                                       List configured collections
  rm <name>                                  Remove a collection
  rename <old> <new>                         Rename a collection

Run 'kindx collection <sub> --help' for per-subcommand details.

$ kindx arch
The 'kindx arch' command was removed in v1.3.
  See: docs/troubleshooting.md#arch-removed
  Migration: experiments/arch/ contains the relocated code.

$ kindx query "auth" --color | less -R
…cyan kindx://… preserved through the pipe…
```

## Decisions

Confirmed during brainstorming:

1. **Typo correction** uses the existing `levenshtein()` function in `engine/repository/docid.ts:9`. Threshold = 2 edits; up to 3 suggestions; aliases included alongside primary names.
2. **`kindx arch`** gets one explicit `case "arch":` arm above `default:` in the main dispatcher. Exit code 2 (so scripts that branch on exit code can distinguish "removed/migrated" from "unknown"). Plain stderr message + pointer to a new `docs/troubleshooting.md#arch-removed` anchor.
3. **`--color` fix** converts module-level `useColor` from `const` to `let`, computed inside `main()` via `resolveOutputMode()` with the parsed `--color` / `--no-color` flags. This unblocks `--color | less -R` and matches the resolver's documented precedence. Trade-off: mutating module state is ugly, but threading `color` through ~15 call sites is much more churn in an already-large `kindx.ts`.
4. **Per-subcommand `--help`** is modeled in the registry. `CommandSpec` gains a `subcommands?: SubcommandSpec[]` field. `engine/cli/help.ts` gains `renderSubcommandList(cmd)` and `renderSubcommandHelp(cmd, sub)`. Each multi-subcommand command's existing help branch calls the renderer instead of inlining usage strings.

## Design

### Component 1 — Typo correction

In `engine/kindx.ts` `default:` case of the main `switch (cli.command)` (currently at `:4863`):

- Build a list of valid command names + aliases from `COMMANDS` in `engine/cli/registry.ts`. We don't have an explicit alias map yet — we'll add one alongside `COMMANDS` so this stays declarative.
- Compute Levenshtein distance against each, keep those with `0 < d ≤ 2`, sort ascending, take top 3.
- Emit one of:
  - 0 matches → unchanged "Unknown command" line + "run --help"
  - 1 match → `  Did you mean: <name>?`
  - 2–3 matches → `  Did you mean one of: <n1>, <n2>, <n3>?`

Reuse, don't re-implement: `levenshtein(a, b, maxDistance)` already exists in `engine/repository/docid.ts:9` and has the optimization we need (`maxDistance` bound prevents quadratic blow-up on long inputs).

Unit tests in a new `specs/cli/typo-correction.test.ts`:
- Common typos: `qury` → `query`, `serach` → `search`, `colection` → `collection`, `mc` → `mcp`
- No-match cases: empty string, very-long-junk, exact-match returns nothing
- Aliases included in the suggestion set

### Component 2 — `kindx arch` migration catch

One `case "arch":` arm in the dispatcher (above `default:`). Three-line stderr output, exit code 2. Add a new `## Migration: `kindx arch` removed` section to `docs/troubleshooting.md` so the link target exists.

No tests required (mechanical, low-value to unit-test); covered by the dispatcher behavior smoke check.

### Component 3 — `--color` propagation

In `engine/kindx.ts`:

- Line 222: `const useColor = ...` → `let useColor = ...` (module-level default preserved for code paths that touch `useColor` before `main()` runs — e.g., the top-level error handler at line 3658).
- In `main()`, immediately after `parseCLI()` and before `setReporterFormatHint()`:

```ts
const resolved = resolveOutputMode({
  format: cli.values.format as string | undefined,
  color: cli.values.color as boolean | undefined,
  noColor: cli.values["no-color"] as boolean | undefined,
  json: cli.values.json as boolean | undefined,
  plain: cli.values.plain as boolean | undefined,
});
useColor = resolved.color;
```

Tests already cover `resolveOutputMode()` precedence; the new behavior is checked by an end-to-end smoke: pipe `kindx query "x" --color` to `cat -v` and assert ESC bytes appear.

### Component 4 — Per-subcommand help registry

**Type extension in `engine/cli/registry.ts`:**

```ts
export interface SubcommandSpec {
  name: string;                                       // "add", "list", "rm", "rename"
  summary: string;                                    // one-line description
  usage?: string;                                     // "<name> --path <dir> --pattern <glob>"
  flags?: { name: string; summary: string }[];
  examples?: string[];
}

export interface CommandSpec {
  // ...existing fields
  subcommands?: SubcommandSpec[];
}
```

Populated for: `collection`, `context`, `index`, `tenant`, `backup`, `memory`, `mcp`. Each existing inline usage block (e.g. `runIndexCommand`'s `case "help" | undefined`, `runTenantCommand`'s `case "help" | undefined`, `runBackupCommand`'s `Usage:` strings) is replaced by a call into the renderer.

**Renderer in `engine/cli/help.ts`:**

```ts
renderSubcommandList(commandName: string, opts: { color: boolean }): string
renderSubcommandHelp(commandName: string, subName: string, opts: { color: boolean }): string | null
```

`renderSubcommandList` renders the usage line + summary table + the "run `kindx <cmd> <sub> --help`" footer. `renderSubcommandHelp` renders the detail block (or returns `null` if the subcommand isn't registered, so the caller can fall back to the existing "unknown subcommand" path).

**Wiring**: top-level dispatcher (after `parseCLI()`, before main switch) intercepts `kindx <cmd> <sub> --help` and `kindx <cmd> --help`:

```ts
if (cli.values.help && cli.command) {
  const sub = cli.args[0];
  const out = sub
    ? renderSubcommandHelp(cli.command, sub, { color: useColor })
    : renderSubcommandList(cli.command, { color: useColor });
  if (out) { console.log(out); process.exit(0); }
}
```

Each multi-subcommand command file's existing `case "help" | undefined` branch becomes:

```ts
case "help":
case undefined:
  console.log(renderSubcommandList("<cmdname>", { color: useColor }));
  return 0;
```

Tests in `specs/cli/help.test.ts`:
- `renderSubcommandList("collection")` includes "add", "list", "rm", "rename" with summaries
- `renderSubcommandHelp("collection", "add")` shows the path/pattern flags
- `renderSubcommandHelp("collection", "nope")` returns `null`
- ANSI-stripping passes when `color: false`

### Critical files

To **modify**:
- `engine/kindx.ts` — `default:` case (typo correction); new `case "arch":` (migration catch); `useColor` `const`→`let` + resolver call in `main()`; help-flag interceptor before main switch; replace inline subcommand-help blocks for the four still-embedded dispatchers (`collection`, `context`, `memory`, `mcp`) with `renderSubcommandList()` calls.
- `engine/cli/registry.ts` — `SubcommandSpec` + `CommandSpec.subcommands`, populate for 7 commands (`collection`, `context`, `index`, `tenant`, `backup`, `memory`, `mcp`), add `COMMAND_ALIASES` list.
- `engine/cli/help.ts` — `renderSubcommandList`, `renderSubcommandHelp`.
- `engine/commands/{backup,index,tenant}-command.ts` — replace inline help strings in the extracted dispatchers with `renderSubcommandList()` calls.
- `docs/troubleshooting.md` — add `## Migration: kindx arch removed` section.

To **add**:
- `specs/cli/typo-correction.test.ts` — unit coverage for the suggestion picker.

### Backward compatibility

- Typo correction is additive — same exit code 1, just prints one extra line on failure.
- `kindx arch` previously exited with code 1 ("Unknown command"); now exits with code 2 ("removed/migrated"). Scripts that branch on `kindx arch && ...` see the same falsy-truth (both non-zero); scripts that distinguish 1 vs 2 will see the change, but anyone relying on a removed command's exit code is already broken.
- `--color` previously a no-op when piped — now actually forces ANSI. This is the change users wanted; downstream pipes that did NOT expect ANSI from a piped output were already broken on TTYs.
- Per-subcommand help renderer outputs *include* what the inline strings did; existing scripts grepping for "Usage:" still find it.

## Verification

1. **Typo correction smoke**:
   ```sh
   kindx qury "x" 2>&1 | head -3
   ```
   Expect: `Unknown command: qury` then `  Did you mean: query?`. Also try `kindx serach`, `kindx colection`, `kindx mc`.

2. **`arch` catch**:
   ```sh
   kindx arch; echo "exit:$?"
   ```
   Expect: 3-line stderr message + `exit:2`.

3. **`--color` through pipe**:
   ```sh
   kindx query "auth" --color -n 1 | cat -v | grep -c "^"
   ```
   Then `... | grep -c $'\x1b\\['` — non-zero means ANSI bytes present. Compare to `--no-color` (zero).

4. **Subcommand help**:
   ```sh
   kindx collection --help
   kindx collection add --help
   kindx context --help
   kindx backup --help
   kindx tenant --help
   ```
   Each must print the usage table (no empty output, no exit 1).

5. **Tests**:
   ```sh
   npx vitest run specs/cli/        # all 154+ tests pass; new tests added
   npx vitest run specs/command-handlers.test.ts specs/command-line.test.ts
   ```
   Existing command-handler tests for `collection`, `index`, `tenant`, `backup` must still pass (we only changed help-text rendering, not behavior).

6. **No regression on `--help` itself**: `kindx --help`, `kindx query --help`, `kindx embed --help` produce identical output to today (the new subcommand renderer is only called for commands that *have* subcommands).
