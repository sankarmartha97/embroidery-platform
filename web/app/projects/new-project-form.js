'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { apiFetch } from '@/lib/api.js';

export default function NewProjectForm({ profiles }) {
  const router = useRouter();
  const [title, setTitle] = useState('');
  const [profileId, setProfileId] = useState(profiles[0]?.id ?? '');
  const [error, setError] = useState(null);
  const [pending, setPending] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const { data } = await apiFetch('/design-projects', {
        method: 'POST',
        body: { title, ...(profileId ? { machineProfileId: profileId } : {}) },
      });
      router.push(`/studio/${data.id}`);
    } catch (err) {
      setError(
        err.status === 403 ? 'Your account cannot create projects (designers only).' : err.message,
      );
      setPending(false);
    }
  }

  return (
    <form className="card new-project" onSubmit={submit}>
      <label className="field grow">
        <span>Title</span>
        <input
          className="input"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          required
          maxLength={200}
        />
      </label>
      <label className="field">
        <span>Machine and hoop</span>
        <select className="select" value={profileId} onChange={(e) => setProfileId(e.target.value)}>
          <option value="">None yet</option>
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} ({p.hoopWidthMm} × {p.hoopHeightMm} mm)
            </option>
          ))}
        </select>
      </label>
      <button className="btn btn-primary" disabled={pending || !title.trim()}>
        {pending ? 'Creating…' : 'New project'}
      </button>
      {error && (
        <p role="alert" className="error-text full">
          {error}
        </p>
      )}
    </form>
  );
}
