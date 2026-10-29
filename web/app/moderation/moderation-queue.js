'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { apiFetch } from '@/lib/api.js';
import { RIGHTS_TYPES } from '@/lib/publishing.js';

// FS-11.1 rejection reason codes.
const REJECT_CODES = [
  'IP_INFRINGEMENT',
  'LOW_QUALITY',
  'MISLEADING_PHOTOS',
  'METADATA',
  'DUPLICATE',
  'PROHIBITED_CONTENT',
  'OTHER',
];
const VALIDATION = { passed: 'Passed', warning: 'Warnings', failed: 'Failed', pending: 'Pending' };

/** Queue items with Approve, Request changes (reason required) and Reject (code + note). */
export default function ModerationQueue({ items, canDecide }) {
  if (items.length === 0) return <p className="muted empty">Nothing here.</p>;
  return (
    <ul className="moderation-list">
      {items.map((item) => (
        <QueueItem key={item.id} item={item} canDecide={canDecide} />
      ))}
    </ul>
  );
}

function QueueItem({ item, canDecide }) {
  const router = useRouter();
  const [mode, setMode] = useState(null); // 'request_changes' | 'reject' | null
  const [reason, setReason] = useState('');
  const [code, setCode] = useState(REJECT_CODES[0]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(null);

  async function decide(decision) {
    setPending(true);
    setError(null);
    const text =
      decision === 'reject' ? `${code}${reason.trim() ? `: ${reason.trim()}` : ''}` : reason.trim();
    try {
      await apiFetch(`/design-publications/${item.id}/review`, {
        method: 'POST',
        body: decision === 'approve' ? { decision } : { decision, reason: text },
      });
      router.refresh();
    } catch (err) {
      setError(err.message);
      setPending(false);
    }
  }

  return (
    <li className="card moderation-item" data-testid="queue-item">
      <div className="moderation-head">
        <h2 className="project-title">{item.project.title}</h2>
        <span className={`validation-badge validation-${item.validationStatus ?? 'pending'}`}>
          Validation: {VALIDATION[item.validationStatus] ?? 'none'}
        </span>
      </div>
      <p className="small muted">
        v{item.versionNumber} · submitted{' '}
        <time dateTime={item.submittedAt}>
          {new Date(item.submittedAt).toLocaleString('en-GB')}
        </time>{' '}
        by <span className="mono">{item.project.ownerUserId}</span>
      </p>
      {item.project.description && <p>{item.project.description}</p>}
      <ul className="rights-list">
        {item.rights.length === 0 && <li className="small error-text">No rights declared.</li>}
        {item.rights.map((r) => (
          <li key={r.id} className="small">
            <strong>
              {RIGHTS_TYPES.find((t) => t.id === r.rightsType)?.label ?? r.rightsType}
            </strong>
            {r.rightsHolderName && ` · ${r.rightsHolderName}`}
            {r.sourceReference && ` · ${r.sourceReference}`} · commercial use{' '}
            {r.commercialUseAllowed ? 'allowed' : 'not allowed'}
            <span className={`rights-status rights-${r.verificationStatus}`}>
              {r.verificationStatus}
            </span>
          </li>
        ))}
      </ul>
      {item.decisionReason && <p className="small">Reason: {item.decisionReason}</p>}

      <div className="moderation-actions">
        <Link href={`/studio/${item.projectId}`} className="btn">
          Open in Studio
        </Link>
        {canDecide && !mode && (
          <>
            <button className="btn" onClick={() => setMode('request_changes')} disabled={pending}>
              Request changes
            </button>
            <button className="btn" onClick={() => setMode('reject')} disabled={pending}>
              Reject
            </button>
            <button
              className="btn btn-primary"
              onClick={() => decide('approve')}
              disabled={pending}
            >
              Approve
            </button>
          </>
        )}
      </div>

      {mode && (
        <form
          className="moderation-decision"
          onSubmit={(e) => {
            e.preventDefault();
            decide(mode);
          }}
        >
          {mode === 'reject' && (
            <label className="field">
              <span>Reason code</span>
              <select className="select" value={code} onChange={(e) => setCode(e.target.value)}>
                {REJECT_CODES.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </label>
          )}
          <label className="field">
            <span>{mode === 'reject' ? 'Note for the designer' : 'What should change?'}</span>
            <textarea
              className="input"
              rows={3}
              maxLength={900}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              required={mode === 'request_changes'}
            />
          </label>
          <div className="moderation-actions">
            <button type="button" className="btn" onClick={() => setMode(null)} disabled={pending}>
              Cancel
            </button>
            <button className="btn btn-primary" disabled={pending}>
              {mode === 'reject' ? 'Reject' : 'Send request'}
            </button>
          </div>
        </form>
      )}
      {error && (
        <p role="alert" className="error-text">
          {error}
        </p>
      )}
    </li>
  );
}
