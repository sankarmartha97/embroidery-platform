'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch, newIdempotencyKey } from '@/lib/api.js';
import { RIGHTS_TYPES, submitChecklist } from '@/lib/publishing.js';

const EMPTY_RIGHTS = {
  rightsType: 'owned',
  rightsHolderName: '',
  sourceReference: '',
  commercialUseAllowed: true,
  modificationAllowed: false,
  redistributionAllowed: false,
};

/**
 * Submit for review (screen S8; FS-6.3, FS-6.4, S9-02): pick a version, declare rights, accept
 * the creator terms. The checklist mirrors the server rules (rights for the design, a passing
 * export of the version); the server checks them again.
 */
export default function SubmitDialog({ projectId, onSubmitted, onClose }) {
  const dialog = useRef(null);
  const [versions, setVersions] = useState(null);
  const [versionId, setVersionId] = useState('');
  const [rights, setRights] = useState([]);
  const [artifacts, setArtifacts] = useState(null);
  const [form, setForm] = useState(EMPTY_RIGHTS);
  const [declaring, setDeclaring] = useState(false);
  const [terms, setTerms] = useState(false);
  const [pending, setPending] = useState(null);
  const [error, setError] = useState(null);
  const base = `/design-projects/${projectId}`;

  const fetchArtifacts = useCallback(
    async (id) => (await apiFetch(`${base}/artifacts?versionId=${id}`)).data.data,
    [base],
  );

  useEffect(() => {
    const el = dialog.current;
    if (!el.open) el.showModal();
    const onCancel = (e) => {
      e.preventDefault();
      onClose();
    };
    el.addEventListener('cancel', onCancel);
    Promise.all([apiFetch(`${base}/versions?limit=100`), apiFetch(`${base}/rights`)])
      .then(([v, r]) => {
        setVersions(v.data.data);
        setVersionId(v.data.data[0]?.id ?? '');
        setRights(r.data.data);
        if (!r.data.data.some((d) => d.assetId === null)) setDeclaring(true);
      })
      .catch((err) => setError(err.message));
    return () => el.removeEventListener('cancel', onCancel);
  }, [base, onClose]);

  useEffect(() => {
    if (!versionId) return;
    let live = true;
    fetchArtifacts(versionId)
      .then((list) => live && setArtifacts(list))
      .catch((err) => live && setError(err.message));
    return () => {
      live = false;
    };
  }, [versionId, fetchArtifacts]);

  const checklist = submitChecklist({ rights, artifacts, terms });

  async function declare(e) {
    e.preventDefault();
    setPending('rights');
    setError(null);
    try {
      const body = { rightsType: form.rightsType };
      for (const key of ['rightsHolderName', 'sourceReference']) {
        if (form[key].trim()) body[key] = form[key].trim();
      }
      for (const key of ['commercialUseAllowed', 'modificationAllowed', 'redistributionAllowed']) {
        body[key] = form[key];
      }
      const { data } = await apiFetch(`${base}/rights`, { method: 'POST', body });
      setRights((current) => [...current, data]);
      setForm(EMPTY_RIGHTS);
      setDeclaring(false);
    } catch (err) {
      setError(err.details?.length ? `${err.message} ${detailText(err.details)}` : err.message);
    } finally {
      setPending(null);
    }
  }

  async function submit() {
    setPending('submit');
    setError(null);
    try {
      const { data } = await apiFetch(`${base}/submit`, {
        method: 'POST',
        body: { versionId, acceptCreatorTerms: true },
        headers: { 'Idempotency-Key': newIdempotencyKey() },
      });
      onSubmitted(data);
    } catch (err) {
      setError(err.message);
      setPending(null);
    }
  }

  const type = RIGHTS_TYPES.find((t) => t.id === form.rightsType);
  const set = (key) => (e) =>
    setForm((f) => ({
      ...f,
      [key]: e.target.type === 'checkbox' ? e.target.checked : e.target.value,
    }));

  return (
    <dialog ref={dialog} className="modal submit-dialog" aria-labelledby="submit-title">
      <h2 id="submit-title">Submit for review</h2>
      <p className="muted small">
        A moderator reviews the exact version you submit. You can keep editing; later changes need a
        new submission.
      </p>

      <label className="field">
        <span>Version</span>
        <select
          className="select"
          value={versionId}
          onChange={(e) => {
            setArtifacts(null);
            setVersionId(e.target.value);
          }}
          disabled={!versions?.length}
        >
          {versions?.length === 0 && <option value="">No versions yet</option>}
          {versions?.map((v) => (
            <option key={v.id} value={v.id}>
              v{v.versionNumber}
              {v.label ? ` · ${v.label}` : ''}
            </option>
          ))}
        </select>
      </label>

      <section className="submit-section" aria-labelledby="rights-title">
        <h3 id="rights-title">Rights</h3>
        {rights.length > 0 && (
          <ul className="rights-list">
            {rights.map((r) => (
              <li key={r.id} className="small" data-testid="rights-row">
                <strong>{RIGHTS_TYPES.find((t) => t.id === r.rightsType)?.label}</strong>
                {r.assetId ? ' · asset' : ' · whole design'}
                {r.rightsHolderName && ` · ${r.rightsHolderName}`}
                <span className={`rights-status rights-${r.verificationStatus}`}>
                  {r.verificationStatus}
                </span>
              </li>
            ))}
          </ul>
        )}
        {declaring ? (
          <form className="rights-form" onSubmit={declare}>
            <label className="field">
              <span>Where does the artwork come from?</span>
              <select className="select" value={form.rightsType} onChange={set('rightsType')}>
                {RIGHTS_TYPES.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                  </option>
                ))}
              </select>
            </label>
            {type.needsHolder && (
              <label className="field">
                <span>Rights holder</span>
                <input
                  className="input"
                  value={form.rightsHolderName}
                  onChange={set('rightsHolderName')}
                  maxLength={200}
                  required
                />
              </label>
            )}
            {type.needsSource && (
              <label className="field">
                <span>{type.sourceLabel}</span>
                <input
                  className="input"
                  value={form.sourceReference}
                  onChange={set('sourceReference')}
                  maxLength={500}
                  required
                />
              </label>
            )}
            <div className="rights-flags">
              <label className="check">
                <input
                  type="checkbox"
                  checked={form.commercialUseAllowed}
                  onChange={set('commercialUseAllowed')}
                />
                Commercial use allowed
              </label>
              <label className="check">
                <input
                  type="checkbox"
                  checked={form.modificationAllowed}
                  onChange={set('modificationAllowed')}
                />
                Modification allowed
              </label>
              <label className="check">
                <input
                  type="checkbox"
                  checked={form.redistributionAllowed}
                  onChange={set('redistributionAllowed')}
                />
                Redistribution allowed
              </label>
            </div>
            <div className="rights-actions">
              {rights.length > 0 && (
                <button type="button" className="btn" onClick={() => setDeclaring(false)}>
                  Cancel
                </button>
              )}
              <button className="btn" disabled={Boolean(pending)}>
                {pending === 'rights' ? 'Saving…' : 'Declare rights'}
              </button>
            </div>
          </form>
        ) : (
          <button className="btn" onClick={() => setDeclaring(true)}>
            Add a declaration
          </button>
        )}
      </section>

      <ul className="checklist" aria-label="Before you submit">
        {checklist.items.map((item) => (
          <li key={item.id} className={item.ok ? 'check-ok' : 'check-missing'}>
            <span aria-hidden="true">{item.ok ? '✓' : '○'}</span> {item.label}
          </li>
        ))}
      </ul>

      <label className="check">
        <input type="checkbox" checked={terms} onChange={(e) => setTerms(e.target.checked)} />I
        accept the creator terms and confirm the rights above are true.
      </label>

      {error && (
        <p role="alert" className="error-text">
          {error}
        </p>
      )}

      <div className="modal-actions">
        <button className="btn" onClick={onClose}>
          Close
        </button>
        <button
          className="btn btn-primary"
          onClick={submit}
          disabled={!checklist.ready || !versionId || Boolean(pending)}
        >
          {pending === 'submit' ? 'Submitting…' : 'Submit for review'}
        </button>
      </div>
    </dialog>
  );
}

const detailText = (details) => details.map((d) => `${d.path} ${d.issue}.`).join(' ');
