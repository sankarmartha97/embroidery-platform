'use client';

const LABEL = { digitize: 'Digitize', validate: 'Validate', export: 'Export' };
const STATUS = {
  queued: 'Queued',
  running: 'Running',
  succeeded: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

/** Job progress chip (06-ui-ux/studio-editor.md, Job UX). Failures show the user-safe summary. */
export default function JobChip({ job, label }) {
  const running = job.status === 'running' || job.status === 'queued';
  const title = [
    job.error?.summary,
    job.id && `Job ${job.id}`,
    job.correlationId && `Correlation id ${job.correlationId}`,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <span
      className={`job-chip job-${job.status}`}
      role="status"
      title={title}
      data-testid={`job-${label}`}
    >
      <span className="job-dot" aria-hidden="true" />
      {LABEL[label]}: {STATUS[job.status] ?? job.status}
      {running && job.progress > 0 && <span className="num"> {job.progress}%</span>}
      {job.status === 'failed' && job.error?.summary && (
        <span className="job-error"> · {job.error.summary}</span>
      )}
    </span>
  );
}
