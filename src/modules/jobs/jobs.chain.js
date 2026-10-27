import { createOutboxRepository } from '../../outbox/outbox.repository.js';
import { createJobsRepository } from './jobs.repository.js';

// digitizeIfMissing chaining (02-architecture/async-processing.md). A chained job waits in
// `queued` with parent_job_id set and no input artifact, and has no queue message yet.
// Call these inside the transaction that finishes the parent.

/** Enqueues a job.queued message through the outbox (ADR-0002). */
export function enqueueJob(conn, jobId, correlationId) {
  return createOutboxRepository(conn).enqueue({
    aggregateType: 'digitizing_job',
    aggregateId: jobId,
    messageType: 'job.queued',
    destination: 'emb-jobs',
    payload: { jobId, correlationId: correlationId ?? null },
  });
}

/** Parent digitize succeeded: hand its stitch data to waiting children and queue them. */
export async function releaseChildren(conn, parentId, stitchDataArtifactId, correlationId) {
  const jobs = createJobsRepository(conn);
  const children = await jobs.listWaitingChildren(parentId);
  for (const id of children) {
    await jobs.setInputArtifact(id, stitchDataArtifactId);
    await enqueueJob(conn, id, correlationId);
  }
  return children.length;
}

/** Parent failed or was cancelled: waiting children end the same way, without running. */
export async function closeChildren(conn, parentId, { status, code, summary, workerId }) {
  const jobs = createJobsRepository(conn);
  const children = await jobs.listWaitingChildren(parentId);
  for (const id of children) {
    await jobs.closeQueued(id, {
      status,
      code,
      summary,
      message: `parent job ${parentId} ${status}`,
      workerId,
    });
  }
  return children.length;
}
