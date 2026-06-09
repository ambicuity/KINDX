/**
 * cli/tui/app.ts — TUI event loop. Wires raw stdin → reducer → renderer.
 *
 * Search execution is provided by the caller so this module never reaches
 * into the engine directly: the entrypoint in engine/kindx.ts hands in a
 * `runSearch(query, mode, collection)` callback that returns hit data.
 */

import {
  enterAltScreen,
  exitAltScreen,
  enableRawMode,
  installCleanup,
  onResize,
  tryReadCaps,
  writeOut,
  moveTo,
} from "./tty.js";
import { render } from "./view.js";
import { reduce, applyHits, setLoading, INITIAL_STATE, type SearchHitState, type SearchMode, type TuiState } from "./state.js";

export interface TuiSearchFn {
  (q: string, opts: { mode: SearchMode; collection: string | null }): Promise<SearchHitState[]>;
}

export interface TuiAppOptions {
  initialQuery?: string;
  initialCollection?: string | null;
  runSearch: TuiSearchFn;
  /** When provided, replaces process.stdin/stdout for tests. */
  testHooks?: { onState?: (s: TuiState) => void };
}

export async function runTui(opts: TuiAppOptions): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write(
      "kindx tui requires an interactive terminal.\n" +
      "  fix: run `kindx search <query>` or `kindx query <query>` non-interactively\n",
    );
    return 2;
  }

  let state: TuiState = {
    ...INITIAL_STATE,
    query: opts.initialQuery ?? "",
    collection: opts.initialCollection ?? null,
  };
  let caps = tryReadCaps();

  enterAltScreen();
  const restoreRaw = enableRawMode();
  const removeResize = onResize((c) => { caps = c; redraw(); });
  const removeCleanup = installCleanup(() => {
    removeResize();
    restoreRaw();
    exitAltScreen();
  });

  function redraw(): void {
    const screen = render(state, caps);
    writeOut(moveTo(1, 1) + "\x1b[2J" + screen);
    opts.testHooks?.onState?.(state);
  }
  redraw();

  let searchSeq = 0;
  async function maybeSearch(): Promise<void> {
    if (state.query.trim().length < 2) {
      state = applyHits(state, []);
      redraw();
      return;
    }
    const mySeq = ++searchSeq;
    state = setLoading(state, true);
    redraw();
    let hits: SearchHitState[] = [];
    try {
      hits = await opts.runSearch(state.query, { mode: state.mode, collection: state.collection });
    } catch (err) {
      state = { ...state, message: `search failed: ${(err as Error).message}` };
    }
    if (mySeq !== searchSeq) return; // stale result, ignore
    state = applyHits(state, hits);
    redraw();
  }

  await new Promise<void>((resolve) => {
    let queryAtLastTrigger = "";
    let debounceTimer: NodeJS.Timeout | null = null;
    const scheduleSearch = (): void => {
      if (state.query === queryAtLastTrigger) return;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        queryAtLastTrigger = state.query;
        void maybeSearch();
      }, 120);
    };

    process.stdin.on("keypress", (str, key) => {
      if (!key) return;
      const before = state;

      if (key.ctrl && key.name === "c") {
        state = reduce(state, { kind: "ctl", ch: "c" });
      } else if (key.name === "return" || key.name === "enter") {
        state = reduce(state, { kind: "enter" });
      } else if (key.name === "backspace") {
        state = reduce(state, { kind: "backspace" });
        scheduleSearch();
      } else if (key.name === "up") {
        state = reduce(state, { kind: "up" });
      } else if (key.name === "down") {
        state = reduce(state, { kind: "down" });
      } else if (key.name === "escape") {
        state = reduce(state, { kind: "name", name: "escape" });
      } else if (key.name === "tab") {
        state = reduce(state, { kind: "tab" });
      } else if (str && str.length === 1 && key.name !== "return") {
        state = reduce(state, { kind: "char", ch: str });
        scheduleSearch();
      }

      if (state.exited) {
        if (debounceTimer) clearTimeout(debounceTimer);
        resolve();
        return;
      }
      if (state !== before) redraw();
    });

    if (state.query.length >= 2) scheduleSearch();
  });

  removeCleanup();
  removeResize();
  restoreRaw();
  exitAltScreen();
  return 0;
}
