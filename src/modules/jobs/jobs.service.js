import { createHash } from 'node:crypto';
import { availableFormats } from '../../config/formats.js';
import { transaction } from '../../db/transaction.js';
import { errors } from '../../http/errors.js';
import { canonicalJson } from '../../lib/document/validate-document.js';
import { newId } from '../../lib/ids.js';
import { createArtifactsRepository } from '../artifacts/index.js';
import {
  canCreateExport,
  canCreateJob,
  canEditDraft,
  createVersionsRepository,
  loadReadableProject,
} from '../projects/index.js';
import { createReferenceRepository } from '../reference/index.js';
import { closeChildren, enqueueJob } from './jobs.chain.js';
import { createJobsRepository } from './jobs.repository.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);
const NEEDS_STITCH_DATA = new Set(['simulate', 'validate', 'export']);

function toResponse(job, outputArtifactIds) {
  return {
    id: job.id,
    projectId: job.projectId,
    jobType: job.jobType,
    status: job.status,
    progress: job.progress,
    projectVersionId: job.projectVersionId,
    inputArtifactId: job.inputArtifactId,
    parentJobId: job.parentJobId,
    targetFormat: job.targetFormat,
    engineName: job.engineName,
    engineVersion: job.engineVersion,
    attemptCount: job.attemptCount,
    error: job.errorCode ? { code: job.errorCode, summary: job.errorSummary } : null,
    outputArtifactIds,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
  };
}

const invalid = (path, issue) => errors.validation([{ path, issue }]);

function parseIdempotencyKey(raw) {
  const key = raw?.trim();
  if (!key || key.length > 128) {
    throw errors.badRequest('Idempotency-Key header (1–128 characters) is required.');
  }
  return key;
}

/** Same key + same request → same job. The fingerprint covers the project and the body. */
function fingerprint(projectId, input) {
  return createHash('sha256')
    .update(canonicalJson({ projectId, ...input }))
    .digest('hex');
}

const isDuplicateKey = (err) => err?.code === 'ER_DUP_ENTRY';

export function createJobsService({ db, engineName, allowUngatedFormats }) {
  async function respond(job) {
    const outputs = await createArtifactsRepository(db).listByJob(job.id);
    return toResponse(
      job,
      outputs.map((a) => a.id),
    );
  }

  /** A replay with the same key returns the original job, or 409 if the body differs. */
  async function replay(actor, key, requestSha256) {
    const existing = await createJobsRepository(db).findByIdempotencyKey(actor.userId, key);
    if (!existing) return null;
    if (existing.requestSha256 !== requestSha256) throw errors.idempotencyKeyReused();
    return existing;
  }

  /** Field rules per job type, then the stitch-data input (or the digitizeIfMissing chain). */
  async function resolveInput(input) {
    if (input.jobType === 'export') {
      if (!input.targetFormat) throw invalid('/targetFormat', 'is required for export jobs');
      const formats = availableFormats({ allowUngated: allowUngatedFormats }).map((f) => f.code);
      if (!formats.includes(input.targetFormat)) {
        throw errors.unsupportedFormat(input.targetFormat, '/targetFormat');
      }
    } else if (input.targetFormat !== undefined) {
      throw invalid('/targetFormat', 'is only used by export jobs');
    }

    if (!NEEDS_STITCH_DATA.has(input.jobType)) {
      if (input.inputArtifactId !== undefined) {
        throw invalid('/inputArtifactId', 'is not used by digitize jobs');
      }
      return { inputArtifactId: null, chain: false };
    }

    const artifacts = createArtifactsRepository(db);
    if (input.inputArtifactId) {
      const artifact = await artifacts.findById(input.inputArtifactId);
      if (
        !artifact ||
        artifact.artifactType !== 'stitch_data' ||
        artifact.projectVersionId !== input.versionId
      ) {
        throw invalid('/inputArtifactId', 'is not stitch data of this version');
      }
      return { inputArtifactId: artifact.id, chain: false };
    }
    if (!input.digitizeIfMissing) throw errors.stitchDataRequired();
    const existing = await artifacts.latestStitchData(input.versionId);
    return existing
      ? { inputArtifactId: existing.id, chain: false }
      : { inputArtifactId: null, chain: true };
  }

  async function resolveProfile(actor, project, machineProfileId) {
    const reference = createReferenceRepository(db);
    if (machineProfileId) {
      const profile = await reference.findMachineProfile(machineProfileId, actor.userId);
      if (!profile) throw invalid('/machineProfileId', 'is not an available machine profile');
      return profile;
    }
    if (project.machineProfileId) {
      return reference.findMachineProfile(project.machineProfileId, project.ownerUserId);
    }
    return null;
  }

  async function loadJob(actor, jobId) {
    if (!UUID.test(jobId)) throw errors.notFound();
    const job = await createJobsRepository(db).findById(jobId);
    if (!job) throw errors.notFound();
    const access = await loadReadableProject(db, actor, job.projectId);
    return { job, ...access };
  }

  return {
    /** @returns {Promise<{ job: object, created: boolean }>} */
    async create(actor, projectId, input, rawKey) {
      const key = parseIdempotencyKey(rawKey);
      const { project, collaborator } = await loadReadableProject(db, actor, projectId);
      const allowed =
        input.jobType === 'export'
          ? canCreateExport(actor, project, collaborator)
          : canCreateJob(actor, project, collaborator);
      if (!allowed) throw errors.forbidden();

      const requestSha256 = fingerprint(projectId, input);
      const replayed = await replay(actor, key, requestSha256);
      if (replayed) return { job: await respond(replayed), created: false };

      const version = await createVersionsRepository(db).findById(input.versionId);
      if (!version || version.projectId !== projectId) {
        throw invalid('/versionId', 'is not a version of this project');
      }
      const { inputArtifactId, chain } = await resolveInput(input);
      const profile = await resolveProfile(actor, project, input.machineProfileId);

      const base = {
        projectVersionId: version.id,
        requestedBy: actor.userId,
        engineName,
        machineProfileId: profile?.id ?? null,
        machineProfile: profile,
      };
      const job = {
        ...base,
        id: newId(),
        jobType: input.jobType,
        inputArtifactId,
        targetFormat: input.targetFormat ?? null,
        settings: input.settings ?? null,
        idempotencyKey: key,
        requestSha256,
      };

      try {
        await transaction(db, async (conn) => {
          const jobs = createJobsRepository(conn);
          if (chain) {
            // The digitize parent runs first; the job below waits for its stitch data.
            const parent = { ...base, id: newId(), jobType: 'digitize', idempotencyKey: newId() };
            await jobs.insert(parent);
            await enqueueJob(conn, parent.id, actor.correlationId);
            job.parentJobId = parent.id;
          }
          // Job row and queue message commit together (IT-01).
          await jobs.insert(job);
          if (!chain) await enqueueJob(conn, job.id, actor.correlationId);
        });
      } catch (err) {
        // A concurrent request with the same key won the insert.
        if (!isDuplicateKey(err)) throw err;
        const winner = await replay(actor, key, requestSha256);
        if (!winner) throw err;
        return { job: await respond(winner), created: false };
      }
      return { job: await respond(await createJobsRepository(db).findById(job.id)), created: true };
    },

    async get(actor, jobId) {
      const { job } = await loadJob(actor, jobId);
      return respond(job);
    },

    /** Queued jobs are cancelled at once; running jobs stop at their next heartbeat. */
    async cancel(actor, jobId) {
      const { job, project, collaborator } = await loadJob(actor, jobId);
      if (job.requestedBy !== actor.userId && !canEditDraft(actor, project, collaborator)) {
        throw errors.forbidden();
      }
      if (TERMINAL.has(job.status)) {
        throw errors.invalidState(`The job has already ${job.status}.`);
      }
      await transaction(db, async (conn) => {
        const jobs = createJobsRepository(conn);
        await jobs.requestCancel(jobId);
        if (await jobs.markCancelledQueued(jobId)) {
          await closeChildren(conn, jobId, {
            status: 'cancelled',
            code: 'CANCELLED',
            summary: 'Cancelled by user',
          });
        }
      });
      return respond(await createJobsRepository(db).findById(jobId));
    },
  };
}
