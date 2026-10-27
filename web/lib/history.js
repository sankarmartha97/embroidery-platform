// Undo/redo command stack (S2-17: at least 200 steps per session). Immutable: each step stores
// the whole document, which shares unchanged objects with the previous step.

export const HISTORY_LIMIT = 200;

export function createHistory(present) {
  return { past: [], present, future: [] };
}

/** Records a new state; a redo branch is discarded. Oldest steps fall off past the limit. */
export function record(history, next, limit = HISTORY_LIMIT) {
  if (next === history.present) return history;
  const past = [...history.past, history.present];
  return {
    past: past.length > limit ? past.slice(past.length - limit) : past,
    present: next,
    future: [],
  };
}

export function undo(history) {
  if (history.past.length === 0) return history;
  return {
    past: history.past.slice(0, -1),
    present: history.past.at(-1),
    future: [history.present, ...history.future],
  };
}

export function redo(history) {
  if (history.future.length === 0) return history;
  return {
    past: [...history.past, history.present],
    present: history.future[0],
    future: history.future.slice(1),
  };
}

/** Replaces everything (e.g. after "reload theirs"): no undo across a reload. */
export const reset = (present) => createHistory(present);
