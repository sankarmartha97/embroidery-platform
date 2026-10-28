'use client';

import { useEffect, useRef, useState } from 'react';
import { hoopFit, nativeFormat, preExportCheck, stageLabel } from '@/lib/exporting.js';

const RUNNING = new Set(['queued', 'running']);
const mm = (v) => `${Math.round(v * 10) / 10}`;

/**
 * Export dialog (FS-8.6, FS-8.7; 06-ui-ux/screen-specifications.md S7): machine, format and hoop,
 * then a pre-export validation. Errors block the export, warnings need "Export anyway". Progress
 * shows the stage, and Cancel stops the running job.
 *
 * `runJob(jobType, { machineProfileId, targetFormat, onUpdate })` snapshots the draft and runs the
 * job to the end; `readReport(job)` and `download(job)` use its output.
 */
export default function ExportDialog({
  document,
  formats,
  profiles,
  profileId,
  runJob,
  cancelJob,
  readReport,
  download,
  onShowIssues,
  onClose,
}) {
  const dialog = useRef(null);
  const [machineId, setMachineId] = useState(() => profileId ?? profiles[0]?.id ?? '');
  const profile = profiles.find((p) => p.id === machineId) ?? null;
  const [format, setFormat] = useState(() => nativeFormat(formats, profile));
  // setup → checking → review (blocked | confirm) → exporting → (closed) | failed
  const [phase, setPhase] = useState('setup');
  const [check, setCheck] = useState(null);
  const [job, setJob] = useState(null);
  const [error, setError] = useState(null);
  const busy = phase === 'checking' || phase === 'exporting';
  const fit = hoopFit(document, profile);

  useEffect(() => {
    const el = dialog.current;
    if (!el.open) el.showModal();
  }, []);

  // Esc closes only while nothing runs; a running job needs Cancel.
  useEffect(() => {
    const el = dialog.current;
    const onCancel = (e) => {
      e.preventDefault();
      if (!busy) onClose();
    };
    el.addEventListener('cancel', onCancel);
    return () => el.removeEventListener('cancel', onCancel);
  }, [busy, onClose]);

  function pickMachine(id) {
    setMachineId(id);
    setFormat(
      nativeFormat(
        formats,
        profiles.find((p) => p.id === id),
      ),
    );
    setPhase('setup');
    setCheck(null);
  }

  function fail(done) {
    setError({
      message: done.error?.summary ?? 'The job did not finish.',
      code: done.error?.code,
      support: done.correlationId ?? done.id,
    });
    setPhase('failed');
  }

  async function run(jobType, options) {
    setJob(null);
    return runJob(jobType, {
      machineProfileId: machineId,
      ...options,
      onUpdate: (j) => setJob({ ...j, jobType }),
    });
  }

  async function exportNow() {
    setPhase('exporting');
    const done = await run('export', { targetFormat: format });
    if (done.status === 'succeeded') {
      await download(done);
      onClose();
    } else if (done.status === 'cancelled') {
      setPhase('setup');
    } else {
      fail(done);
    }
  }

  async function start() {
    setError(null);
    setPhase('checking');
    try {
      const done = await run('validate');
      if (done.status === 'cancelled') return setPhase('setup');
      if (done.status !== 'succeeded') return fail(done);
      const report = await readReport(done);
      const result = { ...preExportCheck(report), report };
      setCheck(result);
      if (result.decision === 'export') await exportNow();
      else setPhase('review');
    } catch (err) {
      setError({ message: err.message, code: err.code, support: err.correlationId });
      setPhase('failed');
    }
  }

  async function exportAnyway() {
    try {
      await exportNow();
    } catch (err) {
      setError({ message: err.message, code: err.code, support: err.correlationId });
      setPhase('failed');
    }
  }

  const canStart = Boolean(profile && format) && fit?.fits !== false;
  const progress = job && RUNNING.has(job.status) ? (job.progress ?? 0) : job ? 100 : 0;

  return (
    <dialog
      ref={dialog}
      className="modal export-dialog"
      aria-labelledby="export-title"
      data-testid="export-dialog"
    >
      <h2 id="export-title">Export</h2>

      <div className="export-grid">
        <label className="field export-wide">
          <span>Machine</span>
          <select
            className="select"
            value={machineId}
            onChange={(e) => pickMachine(e.target.value)}
            disabled={busy}
          >
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.format})
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Format</span>
          <select
            className="select"
            value={format}
            onChange={(e) => setFormat(e.target.value)}
            disabled={busy}
          >
            {formats.map((f) => (
              <option key={f.code} value={f.code}>
                {f.code} · {f.name}
              </option>
            ))}
          </select>
          <span className="small muted">Only enabled formats are listed.</span>
        </label>
        <div className="field">
          <span>Hoop</span>
          <output className="export-hoop num" aria-label="Hoop">
            {profile ? `${mm(profile.hoopWidthMm)} × ${mm(profile.hoopHeightMm)} mm` : '—'}
          </output>
          {fit && (
            <span className={`small ${fit.fits ? 'muted' : 'error-text'}`} role="status">
              {fit.fits
                ? `Design ${mm(fit.width)} × ${mm(fit.height)} mm fits.`
                : `Design ${mm(fit.width)} × ${mm(fit.height)} mm is larger than this hoop.`}
            </span>
          )}
        </div>
      </div>

      <div className="card export-summary" role="status" data-testid="export-summary">
        {phase === 'setup' && (
          <span className="muted">
            {fit
              ? 'Export checks the design against this machine first.'
              : 'The design is empty. Draw something to export.'}
          </span>
        )}
        {busy && job && (
          <div className="export-progress">
            <div className="export-progress-head small">
              <span>{stageLabel(job, format)}</span>
              <span className="num">{progress}%</span>
            </div>
            <div
              className="prog"
              role="progressbar"
              aria-valuenow={progress}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <i style={{ width: `${progress}%` }} />
            </div>
          </div>
        )}
        {busy && !job && <span className="muted">Saving a version…</span>}
        {phase === 'review' && check?.decision === 'blocked' && (
          <span className="error-text">
            ✕ {check.errors} {check.errors === 1 ? 'error blocks' : 'errors block'} the export. Fix{' '}
            {check.errors === 1 ? 'it' : 'them'} in the Issues panel.
          </span>
        )}
        {phase === 'review' && check?.decision === 'confirm' && (
          <span>
            <strong>
              {check.warnings} {check.warnings === 1 ? 'warning' : 'warnings'}.
            </strong>{' '}
            <span className="muted">The file can still be stitched; check the Issues panel.</span>
          </span>
        )}
        {phase === 'failed' && error && (
          <span className="error-text" role="alert">
            {error.message}
            {error.support && (
              <span className="mono small muted"> · Support code {error.support}</span>
            )}
          </span>
        )}
      </div>

      <div className="modal-actions">
        {busy ? (
          <button
            className="btn"
            onClick={() => job?.id && RUNNING.has(job.status) && cancelJob(job)}
            disabled={!job?.id || !RUNNING.has(job.status)}
          >
            Cancel
          </button>
        ) : (
          <button className="btn" onClick={onClose}>
            Close
          </button>
        )}
        {phase === 'review' && (
          <button className="btn" onClick={() => onShowIssues(check.report)}>
            Show issues
          </button>
        )}
        {phase === 'review' && check?.decision === 'confirm' && (
          <button className="btn btn-primary" onClick={exportAnyway}>
            Export anyway
          </button>
        )}
        {(phase === 'setup' || phase === 'failed') && (
          <button className="btn btn-primary" onClick={start} disabled={!canStart}>
            {phase === 'failed' ? 'Try again' : 'Export'}
          </button>
        )}
      </div>
    </dialog>
  );
}
