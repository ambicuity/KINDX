/**
 * cli/tui/state.ts — pure reducer for the TUI's view-state. Lifted out so
 * we can unit-test key-handling logic without spinning up a real terminal.
 */

export type TuiView = "search" | "details" | "status" | "memory" | "help";

export type SearchMode = "hybrid" | "lex" | "vec" | "hyde";

export interface SearchHitState {
  rank: number;
  displayPath: string;
  title?: string;
  score: number;
  snippet?: string;
}

export interface TuiState {
  view: TuiView;
  previousView: TuiView | null;
  query: string;
  cursor: number;          // selection index into hits
  hits: SearchHitState[];
  mode: SearchMode;
  collection: string | null; // null = any
  loading: boolean;
  message: string | null;  // single-line status/error
  exited: boolean;
}

export const INITIAL_STATE: TuiState = {
  view: "search",
  previousView: null,
  query: "",
  cursor: 0,
  hits: [],
  mode: "hybrid",
  collection: null,
  loading: false,
  message: null,
  exited: false,
};

const MODE_ORDER: SearchMode[] = ["hybrid", "lex", "vec", "hyde"];

export type KeyAction =
  | { kind: "char"; ch: string }
  | { kind: "backspace" }
  | { kind: "enter" }
  | { kind: "esc" }
  | { kind: "up" }
  | { kind: "down" }
  | { kind: "tab" }
  | { kind: "ctl"; ch: string }
  | { kind: "name"; name: string };

/**
 * Pure reducer. Given the current state and an action, return the next
 * state. Side effects (issuing searches, writing to terminal) live in the
 * app loop — never here — so tests can exercise the full state machine
 * without I/O.
 */
export function reduce(state: TuiState, action: KeyAction): TuiState {
  switch (state.view) {
    case "search":     return reduceSearch(state, action);
    case "details":    return reduceDetails(state, action);
    case "status":
    case "memory":
    case "help":       return reduceOverlay(state, action);
    default:           return state;
  }
}

function reduceSearch(state: TuiState, action: KeyAction): TuiState {
  if (action.kind === "char") {
    if (action.ch === "/" && state.query === "") {
      return state; // already focused on search
    }
    if (action.ch === "q" && state.query === "") {
      return { ...state, exited: true };
    }
    if (action.ch === "m" && state.query === "") {
      // cycle search mode when buffer is empty
      const idx = MODE_ORDER.indexOf(state.mode);
      const next = MODE_ORDER[(idx + 1) % MODE_ORDER.length];
      return { ...state, mode: next, message: `mode: ${next}` };
    }
    if (action.ch === "?" && state.query === "") {
      return { ...state, previousView: state.view, view: "help" };
    }
    if (action.ch === "r" && state.query === "") {
      return { ...state, message: "refreshing…" };
    }
    return { ...state, query: state.query + action.ch, cursor: 0 };
  }
  if (action.kind === "backspace") {
    return { ...state, query: state.query.slice(0, -1) };
  }
  if (action.kind === "up") {
    return { ...state, cursor: Math.max(0, state.cursor - 1) };
  }
  if (action.kind === "down") {
    const maxIdx = Math.max(0, state.hits.length - 1);
    return { ...state, cursor: Math.min(maxIdx, state.cursor + 1) };
  }
  if (action.kind === "enter") {
    if (state.hits.length === 0) return state;
    return { ...state, previousView: state.view, view: "details" };
  }
  if (action.kind === "name" && action.name === "escape") {
    if (state.query) return { ...state, query: "", cursor: 0 };
    return { ...state, exited: true };
  }
  if (action.kind === "ctl" && action.ch === "c") {
    return { ...state, exited: true };
  }
  return state;
}

function reduceDetails(state: TuiState, action: KeyAction): TuiState {
  if (action.kind === "name" && action.name === "escape") {
    return { ...state, view: state.previousView ?? "search", previousView: null };
  }
  if (action.kind === "char" && (action.ch === "q" || action.ch === "b")) {
    return { ...state, view: state.previousView ?? "search", previousView: null };
  }
  return state;
}

function reduceOverlay(state: TuiState, action: KeyAction): TuiState {
  if (action.kind === "name" && action.name === "escape") {
    return { ...state, view: state.previousView ?? "search", previousView: null };
  }
  if (action.kind === "char" && (action.ch === "q" || action.ch === "?")) {
    return { ...state, view: state.previousView ?? "search", previousView: null };
  }
  return state;
}

export function applyHits(state: TuiState, hits: SearchHitState[]): TuiState {
  return { ...state, hits, cursor: 0, loading: false };
}

export function setLoading(state: TuiState, loading: boolean): TuiState {
  return { ...state, loading };
}
