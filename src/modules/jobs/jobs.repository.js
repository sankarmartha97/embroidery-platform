// digitizing_jobs + design_job_events.
// Status machine (03-database/data-dictionary.md): queued→running→succeeded/failed;
// queued/running→cancelled; running→queued only on a transient retry.
// Every update of a running job is fenced on (status = 'running', attempt_count = attempt), so
// a worker that lost the job (e.g. the reconciler requeued it) cannot overwrite the result.

const COLUMNS = `j.id, j.project_version_id, j.input_artifact_id, j.parent_job_id, j.requested_by,
  j.engine_name, j.engine_version, j.job_type, j.target_format, j.machine_profile_id,
  j.machine_profile_json, j.settings_json, j.status, j.cancel_requested, j.progress,
  j.attempt_count, j.max_attempts, j.idempotency_key, j.error_code, j.error_summary,
  j.request_sha256, j.heartbeat_at, j.deadline_at, j.started_at, j.finished_at, j.created_at`;

const parseJson = (v) =>
  v === null || v === undefined ? null : typeof v === 'string' ? JSON.parse(v) : v;

function toJob(row) {
  return {
    id: row.id,
    projectVersionId: row.project_version_id,
    projectId: row.project_id,
    inputArtifactId: row.input_artifact_id,
    parentJobId: row.parent_job_id,
    requestedBy: row.requested_by,
    engineName: row.engine_name,
    engineVersion: row.engine_version,
    jobType: row.job_type,
    targetFormat: row.target_format,
    machineProfileId: row.machine_profile_id,
    machineProfile: parseJson(row.machine_profile_json),
    settings: parseJson(row.settings_json),
    status: row.status,
    cancelRequested: Boolean(row.cancel_requested),
    progress: row.progress,
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    idempotencyKey: row.idempotency_key,
    requestSha256: row.request_sha256,
    errorCode: row.error_code,
    errorSummary: row.error_summary,
    heartbeatAt: row.heartbeat_at,
    deadlineAt: row.deadline_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    createdAt: row.created_at,
  };
}

export function createJobsRepository(db) {
  async function addEvent({ jobId, fromStatus, toStatus, attempt, errorCode, message, workerId }) {
    await db.execute(
      `INSERT INTO design_job_events
         (job_id, from_status, to_status, attempt, error_code, message, worker_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        jobId,
        fromStatus ?? null,
        toStatus,
        attempt,
        errorCode ?? null,
        message ? String(message).slice(0, 1000) : null,
        workerId ?? null,
      ],
    );
  }

  /** Runs a fenced update of a running job; true when this worker still owned it. */
  async function updateRunning(id, attempt, setSql, params) {
    const [res] = await db.execute(
      `UPDATE digitizing_jobs SET ${setSql}
        WHERE id = ? AND status = 'running' AND attempt_count = ?`,
      [...params, id, attempt],
    );
    return res.affectedRows === 1;
  }

  return {
    addEvent,

    async insert(job) {
      await db.execute(
        `INSERT INTO digitizing_jobs
           (id, project_version_id, input_artifact_id, parent_job_id, requested_by, engine_name,
            job_type, target_format, machine_profile_id, machine_profile_json, settings_json,
            max_attempts, idempotency_key, request_sha256)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          job.id,
          job.projectVersionId,
          job.inputArtifactId ?? null,
          job.parentJobId ?? null,
          job.requestedBy,
          job.engineName,
          job.jobType,
          job.targetFormat ?? null,
          job.machineProfileId ?? null,
          job.machineProfile ? JSON.stringify(job.machineProfile) : null,
          job.settings ? JSON.stringify(job.settings) : null,
          job.maxAttempts ?? 3,
          job.idempotencyKey,
          job.requestSha256 ?? null,
        ],
      );
      await addEvent({ jobId: job.id, toStatus: 'queued', attempt: 0 });
    },

    /** The job with its project id (for artifact keys), or null. */
    async findById(id) {
      const [rows] = await db.execute(
        `SELECT ${COLUMNS}, v.project_id
           FROM digitizing_jobs j
           JOIN design_project_versions v ON v.id = j.project_version_id
          WHERE j.id = ?`,
        [id],
      );
      return rows[0] ? toJob(rows[0]) : null;
    },

    /**
     * queued → running, attempt + 1. Returns the new attempt number, or null if the job was not
     * claimable (already claimed, finished, or cancel requested).
     */
    async claim(id, { timeoutMs, engineVersion, workerId }) {
      const [res] = await db.execute(
        `UPDATE digitizing_jobs
            SET status = 'running', attempt_count = attempt_count + 1, progress = 0,
                engine_version = ?, error_code = NULL, error_summary = NULL,
                started_at = COALESCE(started_at, CURRENT_TIMESTAMP(3)),
                heartbeat_at = CURRENT_TIMESTAMP(3),
                deadline_at = CURRENT_TIMESTAMP(3) + INTERVAL ? MICROSECOND
          WHERE id = ? AND status = 'queued' AND cancel_requested = FALSE`,
        [engineVersion, timeoutMs * 1000, id],
      );
      if (res.affectedRows !== 1) return null;
      const [[row]] = await db.execute(`SELECT attempt_count FROM digitizing_jobs WHERE id = ?`, [
        id,
      ]);
      await addEvent({
        jobId: id,
        fromStatus: 'queued',
        toStatus: 'running',
        attempt: row.attempt_count,
        workerId,
      });
      return row.attempt_count;
    },

    /** Heartbeat. Returns { owned, cancelRequested }. */
    async heartbeat(id, attempt) {
      const owned = await updateRunning(id, attempt, 'heartbeat_at = CURRENT_TIMESTAMP(3)', []);
      const [[row]] = await db.execute(
        `SELECT cancel_requested FROM digitizing_jobs WHERE id = ?`,
        [id],
      );
      return { owned, cancelRequested: Boolean(row?.cancel_requested) };
    },

    setProgress(id, attempt, progress) {
      return updateRunning(id, attempt, 'progress = ?', [progress]);
    },

    async markSucceeded(id, attempt, { workerId }) {
      const ok = await updateRunning(
        id,
        attempt,
        `status = 'succeeded', progress = 100, finished_at = CURRENT_TIMESTAMP(3)`,
        [],
      );
      if (ok) {
        await addEvent({
          jobId: id,
          fromStatus: 'running',
          toStatus: 'succeeded',
          attempt,
          workerId,
        });
      }
      return ok;
    },

    async markFailed(id, attempt, { code, summary, message, workerId }) {
      const ok = await updateRunning(
        id,
        attempt,
        `status = 'failed', error_code = ?, error_summary = ?, finished_at = CURRENT_TIMESTAMP(3)`,
        [code, summary],
      );
      if (ok) {
        await addEvent({
          jobId: id,
          fromStatus: 'running',
          toStatus: 'failed',
          attempt,
          errorCode: code,
          message,
          workerId,
        });
      }
      return ok;
    },

    /** running → queued for a transient failure; the queue redelivers the message. */
    async requeue(id, attempt, { code, summary, message, workerId }) {
      const ok = await updateRunning(
        id,
        attempt,
        `status = 'queued', error_code = ?, error_summary = ?, heartbeat_at = NULL, deadline_at = NULL`,
        [code ?? null, summary ?? null],
      );
      if (ok) {
        await addEvent({
          jobId: id,
          fromStatus: 'running',
          toStatus: 'queued',
          attempt,
          errorCode: code,
          message,
          workerId,
        });
      }
      return ok;
    },

    async markCancelledRunning(id, attempt, { workerId }) {
      const ok = await updateRunning(
        id,
        attempt,
        `status = 'cancelled', error_code = 'CANCELLED', error_summary = ?, finished_at = CURRENT_TIMESTAMP(3)`,
        ['Cancelled by user'],
      );
      if (ok) {
        await addEvent({
          jobId: id,
          fromStatus: 'running',
          toStatus: 'cancelled',
          attempt,
          errorCode: 'CANCELLED',
          workerId,
        });
      }
      return ok;
    },

    /** A queued job whose cancellation was requested before any worker claimed it. */
    async markCancelledQueued(id, { workerId } = {}) {
      const [res] = await db.execute(
        `UPDATE digitizing_jobs
            SET status = 'cancelled', error_code = 'CANCELLED', error_summary = 'Cancelled by user',
                finished_at = CURRENT_TIMESTAMP(3)
          WHERE id = ? AND status = 'queued'`,
        [id],
      );
      if (res.affectedRows !== 1) return false;
      const [[row]] = await db.execute(`SELECT attempt_count FROM digitizing_jobs WHERE id = ?`, [
        id,
      ]);
      await addEvent({
        jobId: id,
        fromStatus: 'queued',
        toStatus: 'cancelled',
        attempt: row.attempt_count,
        errorCode: 'CANCELLED',
        workerId,
      });
      return true;
    },

    /** The caller's job created with this Idempotency-Key, or null (keys are per user). */
    async findByIdempotencyKey(userId, key) {
      const [rows] = await db.execute(
        `SELECT ${COLUMNS}, v.project_id
           FROM digitizing_jobs j
           JOIN design_project_versions v ON v.id = j.project_version_id
          WHERE j.requested_by = ? AND j.idempotency_key = ?`,
        [userId, key],
      );
      return rows[0] ? toJob(rows[0]) : null;
    },

    /** Jobs chained on `parentId` (digitizeIfMissing) that are still waiting for it. */
    async listWaitingChildren(parentId) {
      const [rows] = await db.execute(
        `SELECT id FROM digitizing_jobs
          WHERE parent_job_id = ? AND status = 'queued' AND input_artifact_id IS NULL
          FOR UPDATE`,
        [parentId],
      );
      return rows.map((r) => r.id);
    },

    async setInputArtifact(id, artifactId) {
      await db.execute(
        `UPDATE digitizing_jobs SET input_artifact_id = ?
          WHERE id = ? AND status = 'queued' AND input_artifact_id IS NULL`,
        [artifactId, id],
      );
    },

    /** Ends a queued job that will never run (its parent failed or was cancelled). */
    async closeQueued(id, { status, code, summary, message, workerId }) {
      const [res] = await db.execute(
        `UPDATE digitizing_jobs
            SET status = ?, error_code = ?, error_summary = ?, finished_at = CURRENT_TIMESTAMP(3)
          WHERE id = ? AND status = 'queued'`,
        [status, code, summary, id],
      );
      if (res.affectedRows === 1) {
        await addEvent({
          jobId: id,
          fromStatus: 'queued',
          toStatus: status,
          attempt: 0,
          errorCode: code,
          message,
          workerId,
        });
      }
      return res.affectedRows === 1;
    },

    /**
     * Running jobs whose worker looks dead: heartbeat older than `staleMs`, or past the deadline.
     * @returns {Promise<{ id: string, attemptCount: number, maxAttempts: number }[]>}
     */
    async listStuck(staleMs, limit = 100) {
      const [rows] = await db.execute(
        `SELECT id, attempt_count, max_attempts FROM digitizing_jobs
          WHERE status = 'running'
            AND (heartbeat_at < CURRENT_TIMESTAMP(3) - INTERVAL ? MICROSECOND
                 OR deadline_at < CURRENT_TIMESTAMP(3))
          ORDER BY heartbeat_at
          LIMIT ${Number(limit)}`,
        [staleMs * 1000],
      );
      return rows.map((r) => ({
        id: r.id,
        attemptCount: r.attempt_count,
        maxAttempts: r.max_attempts,
      }));
    },

    async requestCancel(id) {
      await db.execute(`UPDATE digitizing_jobs SET cancel_requested = TRUE WHERE id = ?`, [id]);
    },

    async listEvents(id) {
      const [rows] = await db.execute(
        `SELECT from_status, to_status, attempt, error_code FROM design_job_events
          WHERE job_id = ? ORDER BY id`,
        [id],
      );
      return rows.map((r) => ({
        from: r.from_status,
        to: r.to_status,
        attempt: r.attempt,
        errorCode: r.error_code,
      }));
    },
  };
}
