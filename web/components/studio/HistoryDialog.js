'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import DuplicateButton from '@/app/projects/duplicate-button.js';
import { apiFetch } from '@/lib/api.js';

const REASON = {
  manual: 'Saved',
  checkpoint: 'Checkpoint',
  pre_job: 'Before a job',
  submission: 'Submitted',
  duplicate: 'Duplicated',
};

/**
 * Version history (FS-7.9, S8-01): save a named version, restore any version as the draft (a new
 * head; the server keeps the current draft as a checkpoint), or duplicate it into a new project.
 * `onSave(label)` and `onRestore(version)` come from the Studio, which owns the draft.
 */
export default function HistoryDialog({ projectId, canEdit, onSave, onRestore, onClose }) {
  const dialog = useRef(null);
  const [versions, setVersions] = useState(null);
  const [cursor, setCursor] = useState(null);
  const [label, setLabel] = useState('');
  const [pending, setPending] = useState(null);
  const [error, setError] = useState(null);

  const fetchPage = useCallback(
    async (after) => {
      const query = after ? `?cursor=${encodeURIComponent(after)}` : '';
      return (await apiFetch(`/design-projects/${projectId}/versions${query}`)).data;
    },
    [projectId],
  );
  const show = (data, append) => {
    setVersions((current) => (append ? [...(current ?? []), ...data.data] : data.data));
    setCursor(data.page?.nextCursor ?? null);
  };
  const load = async (after) => show(await fetchPage(after), Boolean(after));

  useEffect(() => {
    const el = dialog.current;
    if (!el.open) el.showModal();
    const onCancel = (e) => {
      e.preventDefault();
      onClose();
    };
    el.addEventListener('cancel', onCancel);
    fetchPage()
      .then((data) => show(data, false))
      .catch((err) => setError(err.message));
    return () => el.removeEventListener('cancel', onCancel);
  }, [fetchPage, onClose]);

  async function act(key, action) {
    setPending(key);
    setError(null);
    try {
      await action();
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setPending(null);
    }
  }

  return (
    <dialog ref={dialog} className="modal history-dialog" aria-labelledby="history-title">
      <h2 id="history-title">Version history</h2>

      {canEdit && (
        <form
          className="history-save"
          onSubmit={(e) => {
            e.preventDefault();
            act('save', async () => {
              await onSave(label.trim() || undefined);
              setLabel('');
            });
          }}
        >
          <input
            className="input"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            maxLength={120}
            placeholder="Name this version (optional)"
            aria-label="Version name"
          />
          <button className="btn btn-primary" disabled={Boolean(pending)}>
            {pending === 'save' ? 'Saving…' : 'Save version'}
          </button>
        </form>
      )}

      {error && (
        <p role="alert" className="error-text">
          {error}
        </p>
      )}

      {versions === null ? (
        <p className="muted">Loading…</p>
      ) : versions.length === 0 ? (
        <p className="muted">No versions yet. Versions are saved before every job, or here.</p>
      ) : (
        <ol className="version-list">
          {versions.map((v) => (
            <li key={v.id} className="version-row" data-testid="version-row">
              <span className="version-head">
                <strong className="num">v{v.versionNumber}</strong>
                <span>{v.label ?? REASON[v.reason] ?? v.reason}</span>
              </span>
              <span className="small muted">
                {v.label && `${REASON[v.reason] ?? v.reason} · `}
                <time dateTime={v.createdAt}>{new Date(v.createdAt).toLocaleString('en-GB')}</time>
              </span>
              <span className="version-actions">
                {canEdit && (
                  <button
                    className="btn"
                    disabled={Boolean(pending)}
                    onClick={() => act(v.id, () => onRestore(v))}
                    aria-label={`Restore version ${v.versionNumber}`}
                  >
                    {pending === v.id ? 'Restoring…' : 'Restore'}
                  </button>
                )}
                <DuplicateButton
                  projectId={projectId}
                  versionId={v.id}
                  title={`version ${v.versionNumber}`}
                />
              </span>
            </li>
          ))}
        </ol>
      )}
      {cursor && (
        <button className="btn" onClick={() => load(cursor).catch((err) => setError(err.message))}>
          Show older versions
        </button>
      )}

      <div className="modal-actions">
        <button className="btn" onClick={onClose}>
          Close
        </button>
      </div>
    </dialog>
  );
}
