// Draft autosave (06-ui-ux/studio-editor.md): debounced 2 s after the last change and at least
// every 30 s while dirty. Status: Saved · Saving… · Offline (retrying) · Conflict. Optimistic
// concurrency with If-Match: a 409 DRAFT_CONFLICT stops saving until the user decides.

export const STATUS = Object.freeze({
  SAVED: 'saved',
  DIRTY: 'dirty',
  SAVING: 'saving',
  OFFLINE: 'offline',
  CONFLICT: 'conflict',
  INVALID: 'invalid',
});

export const STATUS_LABEL = Object.freeze({
  saved: 'Saved',
  dirty: 'Unsaved changes',
  saving: 'Saving…',
  offline: 'Offline (retrying)',
  conflict: 'Conflict',
  invalid: 'Not saved: fix the highlighted issues',
});

/**
 * @param {object} o
 * @param {(document: object, revision: number) => Promise<{ draftRevision: number }>} o.save
 *   rejects with { status, code, details } on HTTP errors, or a plain Error offline
 * @param {number} o.revision current draftRevision
 * @param {(state: object) => void} [o.onChange]
 */
export function createAutosave({
  save,
  revision,
  onChange = () => {},
  debounceMs = 2000,
  maxWaitMs = 30_000,
  retryMs = 5000,
  timers = globalThis,
}) {
  let state = { status: STATUS.SAVED, revision, error: null };
  let latest = null; // newest unsaved document
  let dirty = false;
  let saving = false;
  let debounce = null;
  let maxWait = null;
  let retry = null;

  const set = (patch) => {
    state = { ...state, ...patch };
    onChange(state);
  };
  const clear = (t) => t && timers.clearTimeout(t);
  const clearAll = () => {
    clear(debounce);
    clear(maxWait);
    clear(retry);
    debounce = maxWait = retry = null;
  };

  async function flush() {
    clearAll();
    if (!dirty || saving || state.status === STATUS.CONFLICT) return;
    saving = true;
    dirty = false;
    const document = latest;
    set({ status: STATUS.SAVING, error: null });
    try {
      const { draftRevision } = await save(document, state.revision);
      saving = false;
      set({ revision: draftRevision, status: dirty ? STATUS.DIRTY : STATUS.SAVED });
      if (dirty) schedule();
    } catch (err) {
      saving = false;
      dirty = true; // the document still needs saving
      if (err?.status === 409 && err.code === 'DRAFT_CONFLICT') {
        set({ status: STATUS.CONFLICT, error: err });
      } else if (err?.status === 422) {
        set({ status: STATUS.INVALID, error: err });
      } else {
        // Network failure, 5xx or 429: keep the edits and try again.
        set({ status: STATUS.OFFLINE, error: err });
        retry = timers.setTimeout(flush, retryMs);
      }
    }
  }

  function schedule() {
    clear(debounce);
    debounce = timers.setTimeout(flush, debounceMs);
    if (!maxWait) maxWait = timers.setTimeout(flush, maxWaitMs);
  }

  return {
    getState: () => state,
    /** Call with the new document after every change. */
    edit(document) {
      latest = document;
      dirty = true;
      if (state.status === STATUS.CONFLICT) return;
      if (!saving && state.status !== STATUS.OFFLINE) set({ status: STATUS.DIRTY, error: null });
      if (!saving) schedule();
    },
    /** Saves now (e.g. before running a job or leaving the page). */
    flush,
    /** After "reload theirs": the server copy is current; nothing to save. */
    reset(newRevision) {
      clearAll();
      dirty = false;
      latest = null;
      set({ status: STATUS.SAVED, revision: newRevision, error: null });
    },
    /** After "save mine": continue from the server's current revision and save at once. */
    overrideRevision(newRevision) {
      set({ status: STATUS.DIRTY, revision: newRevision, error: null });
      return flush();
    },
    hasUnsavedChanges: () => dirty || saving,
    dispose: clearAll,
  };
}
