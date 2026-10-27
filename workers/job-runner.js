import { gunzipSync } from 'node:zlib';
import { sha256 } from '../src/lib/hash.js';
import { transaction } from '../src/db/transaction.js';
import { newId } from '../src/lib/ids.js';
import { createArtifactsRepository } from '../src/modules/artifacts/index.js';
import { closeChildren, createJobsRepository, releaseChildren } from '../src/modules/jobs/index.js';
import { createVersionsRepository } from '../src/modules/projects/index.js';
import { RetryLater } from './consumer.js';
import { EngineError } from './engines/digitizing-engine.js';
import { digitize } from './handlers/digitize.js';
import { exportFile } from './handlers/export.js';
import { simulate } from './handlers/simulate.js';
import { validateStitches } from './handlers/validate.js';
import { classify, shouldRetry, StorageError, summaryFor } from './job-errors.js';

const HANDLERS = { digitize, simulate, validate: validateStitches, export: exportFile };

/** Event text: only messages the platform wrote; unknown errors are named, never echoed. */
const eventMessage = (err) =>
  err instanceof EngineError || err instanceof StorageError ? err.message : err?.name;

/** Seconds before a requeued job's message becomes visible again: 30 s, 60 s, … capped at 5 min. */
export const defaultRetryDelay = (attempt) => Math.min(30 * 2 ** (attempt - 1), 300);

/**
 * Runs one digitizing job (delivery plan S3-04): claim, heartbeat, cancel check, engine call,
 * upload with checksum verification, then one transaction for artifacts + final status.
 *
 * Outcomes: 'succeeded' | 'failed' | 'cancelled' | 'duplicate' | 'lost'. A transient failure
 * puts the job back to queued and throws RetryLater, so the queue redelivers the message.
 */
export function createJobRunner({
  pool,
  engine,
  store,
  timeoutMs,
  heartbeatMs,
  workerId,
  retryDelay = defaultRetryDelay,
}) {
  const jobs = createJobsRepository(pool);
  const engineInfo = engine.describe();

  async function loadStitchData(job) {
    const input = job.inputArtifactId
      ? await createArtifactsRepository(pool).findById(job.inputArtifactId)
      : null;
    if (
      !input ||
      input.artifactType !== 'stitch_data' ||
      input.projectVersionId !== job.projectVersionId
    ) {
      throw new EngineError('INVALID_DOCUMENT', 'input is not stitch data of this version');
    }
    let raw;
    try {
      raw = await store.get(input.storageKey);
    } catch (err) {
      throw new StorageError(`stitch data read failed: ${err.name}`);
    }
    if (sha256(raw) !== input.sha256) throw new StorageError('stitch data checksum mismatch');
    return JSON.parse(gunzipSync(raw).toString('utf8'));
  }

  async function execute(job, attempt, signal) {
    const version = await createVersionsRepository(pool).findWithDocument(job.projectVersionId);
    const machineProfile = job.machineProfile ?? version.document.machineProfile ?? null;
    const stitchData = job.jobType === 'digitize' ? null : await loadStitchData(job);
    await jobs.setProgress(job.id, attempt, 10);
    const outputs = await HANDLERS[job.jobType]({
      job,
      version,
      stitchData,
      engine,
      machineProfile,
      signal,
    });
    if (signal.aborted) throw new EngineError('CANCELLED', 'aborted after engine returned');
    await jobs.setProgress(job.id, attempt, 80);
    return outputs;
  }

  async function upload(job, outputs) {
    const stored = [];
    for (const output of outputs) {
      const id = newId();
      const storageKey = `artifacts/${job.projectId}/${job.projectVersionId}/${id}.${output.ext}`;
      let result;
      try {
        result = await store.put(storageKey, output.body, {
          contentType: output.contentType,
          contentEncoding: output.contentEncoding,
        });
      } catch (err) {
        throw new StorageError(`upload failed: ${err.name}`);
      }
      if (!result.verified) throw new StorageError('upload checksum mismatch');
      // Everything except the file itself is artifact metadata (type, format, stats).
      const meta = { ...output };
      for (const key of ['body', 'ext', 'contentType', 'contentEncoding']) delete meta[key];
      stored.push({
        ...meta,
        id,
        projectVersionId: job.projectVersionId,
        jobId: job.id,
        storageKey,
        sha256: result.sha256,
        fileSizeBytes: result.size,
        engineName: engineInfo.name,
        engineVersion: engineInfo.version,
      });
    }
    return stored;
  }

  /**
   * Artifacts, final status and (for digitize) the release of chained jobs commit together.
   * @returns {Promise<boolean>} false if the job was taken from this worker meanwhile
   */
  async function commitSuccess(job, attempt, artifacts, correlationId) {
    return transaction(pool, async (conn) => {
      const repo = createArtifactsRepository(conn);
      const stored = [];
      for (const artifact of artifacts) stored.push(await repo.insertForJob(artifact));
      const ok = await createJobsRepository(conn).markSucceeded(job.id, attempt, { workerId });
      if (!ok) throw new LostJob();
      const stitchData = stored.find((a) => a.artifactType === 'stitch_data');
      if (stitchData) await releaseChildren(conn, job.id, stitchData.id, correlationId);
      return true;
    }).catch((err) => {
      if (err instanceof LostJob) return false;
      throw err;
    });
  }

  /** A final status plus the same outcome for chained jobs still waiting on this one. */
  function finish(jobId, mark, childOutcome) {
    return transaction(pool, async (conn) => {
      if (await mark(createJobsRepository(conn))) {
        await closeChildren(conn, jobId, { ...childOutcome, workerId });
      }
    });
  }
  const CANCELLED = { status: 'cancelled', code: 'CANCELLED', summary: 'Cancelled by user' };

  return {
    async run(jobId, { log, signal: shutdownSignal, extendVisibility, correlationId } = {}) {
      const job = await jobs.findById(jobId);
      if (!job) throw new Error(`job ${jobId} not found`); // left for the DLQ

      if (job.status === 'queued' && job.cancelRequested) {
        await finish(jobId, (repo) => repo.markCancelledQueued(jobId, { workerId }), CANCELLED);
        log?.info({ jobId }, 'job cancelled before start');
        return 'cancelled';
      }

      const attempt = await jobs.claim(jobId, {
        timeoutMs,
        engineVersion: engineInfo.version,
        workerId,
      });
      if (attempt === null) {
        log?.info({ jobId, status: job.status }, 'job not claimable; duplicate delivery skipped');
        return 'duplicate';
      }
      log?.info({ jobId, attempt, jobType: job.jobType }, 'job claimed');

      const cancel = new AbortController();
      const timeout = AbortSignal.timeout(timeoutMs);
      const signal = AbortSignal.any([cancel.signal, timeout, shutdownSignal].filter(Boolean));
      const visibilitySeconds = Math.ceil((heartbeatMs * 3) / 1000);
      const beat = setInterval(async () => {
        try {
          const hb = await jobs.heartbeat(jobId, attempt);
          if (!hb.owned) cancel.abort('lost');
          else if (hb.cancelRequested) cancel.abort('cancel');
          await extendVisibility?.(visibilitySeconds);
        } catch (err) {
          log?.warn({ err, jobId }, 'heartbeat failed');
        }
      }, heartbeatMs);
      beat.unref?.();

      try {
        const outputs = await execute(job, attempt, signal);
        const artifacts = await upload(job, outputs);
        if (!(await commitSuccess(job, attempt, artifacts, correlationId))) {
          log?.warn({ jobId, attempt }, 'job was taken from this worker; result discarded');
          return 'lost';
        }
        log?.info({ jobId, attempt, artifacts: artifacts.length }, 'job succeeded');
        return 'succeeded';
      } catch (err) {
        if (cancel.signal.reason === 'lost') {
          log?.warn({ jobId, attempt }, 'job was taken from this worker; stopped');
          return 'lost';
        }
        if (
          cancel.signal.reason === 'cancel' ||
          (classify(err) === 'CANCELLED' && !timeout.aborted && !shutdownSignal?.aborted)
        ) {
          await finish(
            jobId,
            (repo) => repo.markCancelledRunning(jobId, attempt, { workerId }),
            CANCELLED,
          );
          log?.info({ jobId, attempt }, 'job cancelled while running');
          return 'cancelled';
        }
        if (shutdownSignal?.aborted && !timeout.aborted) {
          await jobs.requeue(jobId, attempt, { message: 'worker shutting down', workerId });
          throw new RetryLater(0, 'worker shutting down');
        }

        const code = timeout.aborted ? 'ENGINE_TIMEOUT' : classify(err);
        const summary = summaryFor(code);
        // Diagnostics go to restricted logs; the job row gets only the user-safe summary.
        log?.warn({ err, jobId, attempt, code }, 'job attempt failed');
        if (shouldRetry(code, attempt, job.maxAttempts)) {
          await jobs.requeue(jobId, attempt, {
            code,
            summary,
            message: eventMessage(err),
            workerId,
          });
          throw new RetryLater(retryDelay(attempt), code);
        }
        const final = { status: 'failed', code, summary: summaryFor(code, { final: true }) };
        await finish(
          jobId,
          (repo) =>
            repo.markFailed(jobId, attempt, { ...final, message: eventMessage(err), workerId }),
          final,
        );
        return 'failed';
      } finally {
        clearInterval(beat);
      }
    },
  };
}

class LostJob extends Error {}
