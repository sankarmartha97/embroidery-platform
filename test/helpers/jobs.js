// Seeds projects, versions and jobs directly through the repositories (the jobs API is S4).
import { canonicalize } from '../../src/lib/document/validate-document.js';
import { newId } from '../../src/lib/ids.js';
import { createJobsRepository } from '../../src/modules/jobs/index.js';
import { createVersionsRepository } from '../../src/modules/projects/index.js';
import { heartDocument } from './documents.js';

/** A project with one version. `document` is stored as given (it may be invalid on purpose). */
export async function seedVersion(pool, ownerUserId, document = heartDocument()) {
  const projectId = newId();
  await pool.execute(
    `INSERT INTO design_projects (id, owner_user_id, title, draft_document_json, draft_schema_version)
     VALUES (?, ?, 'Seeded', ?, 1)`,
    [projectId, ownerUserId, JSON.stringify(document)],
  );
  const versionId = newId();
  let json;
  let sha;
  try {
    ({ json, sha256: sha } = canonicalize(document));
  } catch {
    json = JSON.stringify(document);
    sha = '0'.repeat(64);
  }
  await createVersionsRepository(pool).insert({
    id: versionId,
    projectId,
    versionNumber: 1,
    documentSchemaVersion: 1,
    documentJson: json,
    documentSha256: sha,
    reason: 'manual',
    createdBy: ownerUserId,
    createdAt: new Date(),
  });
  return { projectId, versionId };
}

export async function insertJob(pool, fields) {
  const job = {
    id: newId(),
    engineName: 'fake',
    jobType: 'digitize',
    idempotencyKey: newId(),
    ...fields,
  };
  await createJobsRepository(pool).insert(job);
  return job;
}

export async function jobRow(pool, id) {
  const [[row]] = await pool.execute(
    `SELECT status, attempt_count, progress, error_code, error_summary, engine_version,
            cancel_requested, started_at, finished_at
       FROM digitizing_jobs WHERE id = ?`,
    [id],
  );
  return row;
}
