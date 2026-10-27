'use client';

import { useEffect, useRef, useState } from 'react';

/** Autosave conflict (06-ui-ux/studio-editor.md): reload theirs, or save mine as a new version. */
export default function ConflictModal({ onReload, onSaveMine }) {
  const dialog = useRef(null);
  const [pending, setPending] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    const el = dialog.current;
    if (!el.open) el.showModal();
    const block = (e) => e.preventDefault(); // a decision is required
    el.addEventListener('cancel', block);
    return () => el.removeEventListener('cancel', block);
  }, []);

  async function choose(which, action) {
    setPending(which);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(err.message);
      setPending(null);
    }
  }

  return (
    <dialog
      ref={dialog}
      className="modal"
      aria-labelledby="conflict-title"
      aria-describedby="conflict-text"
    >
      <h2 id="conflict-title">This project changed in another tab or device</h2>
      <p id="conflict-text" className="muted">
        Your latest edits were not saved, because someone saved a newer copy. Choose which copy to
        keep.
      </p>
      {error && (
        <p role="alert" className="error-text">
          {error}
        </p>
      )}
      <div className="modal-actions">
        <button
          className="btn"
          disabled={Boolean(pending)}
          onClick={() => choose('reload', onReload)}
        >
          {pending === 'reload' ? 'Reloading…' : 'Reload their copy'}
        </button>
        <button
          className="btn btn-primary"
          disabled={Boolean(pending)}
          onClick={() => choose('mine', onSaveMine)}
        >
          {pending === 'mine' ? 'Saving…' : 'Save mine as a new version'}
        </button>
      </div>
    </dialog>
  );
}
