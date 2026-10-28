'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { apiFetch, newIdempotencyKey } from '@/lib/api.js';

/** Duplicates a project (or one of its versions) and opens the copy in the Studio. */
export default function DuplicateButton({ projectId, versionId, title, className = 'btn' }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(null);

  async function duplicate() {
    setPending(true);
    setError(null);
    try {
      const { data } = await apiFetch(`/design-projects/${projectId}/duplicate`, {
        method: 'POST',
        body: versionId ? { versionId } : {},
        headers: { 'Idempotency-Key': newIdempotencyKey() },
      });
      router.push(`/studio/${data.id}`);
    } catch (err) {
      setError(err.status === 403 ? 'Designers only.' : err.message);
      setPending(false);
    }
  }

  return (
    <>
      <button
        className={className}
        onClick={duplicate}
        disabled={pending}
        aria-label={title ? `Duplicate ${title}` : 'Duplicate'}
      >
        {pending ? 'Duplicating…' : 'Duplicate'}
      </button>
      {error && (
        <span role="alert" className="error-text small">
          {error}
        </span>
      )}
    </>
  );
}
