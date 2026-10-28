'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/lib/api.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Sharing (FS-7.10, S8-04), owner only. Invites use a user id until the marketplace user
 * directory exists (OQ-03); FS-7.10 invites by email. Removing access takes effect at once.
 */
export default function ShareDialog({ projectId, onClose }) {
  const dialog = useRef(null);
  const [people, setPeople] = useState(null);
  const [userId, setUserId] = useState('');
  const [role, setRole] = useState('viewer');
  const [canExport, setCanExport] = useState(false);
  const [pending, setPending] = useState(null);
  const [error, setError] = useState(null);
  const base = `/design-projects/${projectId}/collaborators`;

  const fetchPeople = useCallback(async () => (await apiFetch(base)).data.data, [base]);
  const load = async () => setPeople(await fetchPeople());

  useEffect(() => {
    const el = dialog.current;
    if (!el.open) el.showModal();
    const onCancel = (e) => {
      e.preventDefault();
      onClose();
    };
    el.addEventListener('cancel', onCancel);
    fetchPeople()
      .then(setPeople)
      .catch((err) => setError(err.message));
    return () => el.removeEventListener('cancel', onCancel);
  }, [fetchPeople, onClose]);

  async function act(key, request) {
    setPending(key);
    setError(null);
    try {
      await request();
      await load();
      return true;
    } catch (err) {
      setError(err.details?.[0] ? `${err.message} (${err.details[0].issue})` : err.message);
      return false;
    } finally {
      setPending(null);
    }
  }

  async function invite(e) {
    e.preventDefault();
    const ok = await act('invite', () =>
      apiFetch(base, { method: 'POST', body: { userId: userId.trim(), role, canExport } }),
    );
    if (ok) setUserId('');
  }

  const change = (person, patch) =>
    act(person.userId, () =>
      apiFetch(`${base}/${person.userId}`, { method: 'PATCH', body: patch }),
    );

  return (
    <dialog ref={dialog} className="modal share-dialog" aria-labelledby="share-title">
      <h2 id="share-title">Share this project</h2>
      <p className="muted small">
        People you add see this project under “Shared with me”. Editors can change the design;
        export lets them download machine files.
      </p>

      <form className="share-invite" onSubmit={invite}>
        <label className="field grow">
          <span>User id</span>
          <input
            className="input mono"
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
            placeholder="0190f0a0-…"
            required
          />
        </label>
        <label className="field">
          <span>Role</span>
          <select className="select" value={role} onChange={(e) => setRole(e.target.value)}>
            <option value="viewer">Viewer</option>
            <option value="editor">Editor</option>
          </select>
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={canExport}
            onChange={(e) => setCanExport(e.target.checked)}
          />
          Can export
        </label>
        <button
          className="btn btn-primary"
          disabled={Boolean(pending) || !UUID.test(userId.trim())}
        >
          {pending === 'invite' ? 'Adding…' : 'Add'}
        </button>
      </form>

      {error && (
        <p role="alert" className="error-text">
          {error}
        </p>
      )}

      {people === null ? (
        <p className="muted">Loading…</p>
      ) : people.length === 0 ? (
        <p className="muted">Only you can see this project.</p>
      ) : (
        <ul className="share-list">
          {people.map((p) => (
            <li key={p.userId} className="share-row" data-testid="collaborator">
              <span className="mono small share-user">{p.userId}</span>
              <select
                className="select"
                value={p.role}
                onChange={(e) => change(p, { role: e.target.value })}
                disabled={Boolean(pending)}
                aria-label={`Role of ${p.userId}`}
              >
                <option value="viewer">Viewer</option>
                <option value="editor">Editor</option>
              </select>
              <label className="check">
                <input
                  type="checkbox"
                  checked={p.canExport}
                  onChange={(e) => change(p, { canExport: e.target.checked })}
                  disabled={Boolean(pending)}
                />
                Export
              </label>
              <button
                className="btn"
                onClick={() =>
                  act(p.userId, () => apiFetch(`${base}/${p.userId}`, { method: 'DELETE' }))
                }
                disabled={Boolean(pending)}
                aria-label={`Remove ${p.userId}`}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="modal-actions">
        <button className="btn" onClick={onClose}>
          Close
        </button>
      </div>
    </dialog>
  );
}
