// design_artifacts. Worker writes are idempotent on (job_id, artifact_type, format_code).

const COLUMNS = `id, project_version_id, job_id, artifact_type, format_code, storage_key, sha256,
  file_size_bytes, stitch_count, color_count, trim_count, jump_count, width_mm, height_mm,
  engine_name, engine_version, validation_status, validation_report_artifact_id, created_at`;

const num = (v) => (v === null || v === undefined ? null : Number(v));

function toArtifact(row) {
  return {
    id: row.id,
    projectVersionId: row.project_version_id,
    jobId: row.job_id,
    artifactType: row.artifact_type,
    formatCode: row.format_code,
    storageKey: row.storage_key,
    sha256: row.sha256,
    fileSizeBytes: Number(row.file_size_bytes),
    stitchCount: row.stitch_count,
    colorCount: row.color_count,
    trimCount: row.trim_count,
    jumpCount: row.jump_count,
    widthMm: num(row.width_mm),
    heightMm: num(row.height_mm),
    engineName: row.engine_name,
    engineVersion: row.engine_version,
    validationStatus: row.validation_status,
    validationReportArtifactId: row.validation_report_artifact_id,
    createdAt: row.created_at,
  };
}

export function createArtifactsRepository(db) {
  return {
    /**
     * Inserts unless this job already produced an artifact of the same type and format
     * (a duplicate delivery or a retry). Returns the stored artifact either way.
     */
    async insertForJob(a) {
      await db.execute(
        `INSERT IGNORE INTO design_artifacts
           (id, project_version_id, job_id, artifact_type, format_code, storage_key, sha256,
            file_size_bytes, stitch_count, color_count, trim_count, jump_count, width_mm,
            height_mm, engine_name, engine_version, validation_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          a.id,
          a.projectVersionId,
          a.jobId,
          a.artifactType,
          a.formatCode,
          a.storageKey,
          a.sha256,
          a.fileSizeBytes,
          a.stitchCount ?? null,
          a.colorCount ?? null,
          a.trimCount ?? null,
          a.jumpCount ?? null,
          a.widthMm ?? null,
          a.heightMm ?? null,
          a.engineName ?? null,
          a.engineVersion ?? null,
          a.validationStatus ?? 'pending',
        ],
      );
      const [rows] = await db.execute(
        `SELECT ${COLUMNS} FROM design_artifacts
          WHERE job_id = ? AND artifact_type = ? AND format_code = ?`,
        [a.jobId, a.artifactType, a.formatCode],
      );
      return toArtifact(rows[0]);
    },

    /** Latest validation result on stitch data, with its report (S6-04). */
    async setValidation(id, status, reportArtifactId) {
      await db.execute(
        `UPDATE design_artifacts SET validation_status = ?, validation_report_artifact_id = ?
          WHERE id = ? AND artifact_type = 'stitch_data'`,
        [status, reportArtifactId, id],
      );
    },

    async findById(id) {
      const [rows] = await db.execute(
        `SELECT ${COLUMNS} FROM design_artifacts WHERE id = ? AND deleted_at IS NULL`,
        [id],
      );
      return rows[0] ? toArtifact(rows[0]) : null;
    },

    /** The newest stitch data of a version, or null (what digitizeIfMissing looks for). */
    async latestStitchData(projectVersionId) {
      const [rows] = await db.execute(
        `SELECT ${COLUMNS} FROM design_artifacts
          WHERE project_version_id = ? AND artifact_type = 'stitch_data' AND deleted_at IS NULL
          ORDER BY created_at DESC, id DESC LIMIT 1`,
        [projectVersionId],
      );
      return rows[0] ? toArtifact(rows[0]) : null;
    },

    /** A project's artifacts, newest first, optionally for one version and/or type. */
    async listByProject(projectId, { versionId, type, limit = 200 }) {
      const where = ['v.project_id = ?', 'a.deleted_at IS NULL'];
      const params = [projectId];
      if (versionId) {
        where.push('a.project_version_id = ?');
        params.push(versionId);
      }
      if (type) {
        where.push('a.artifact_type = ?');
        params.push(type);
      }
      const columns = COLUMNS.split(',')
        .map((c) => `a.${c.trim()}`)
        .join(', ');
      const [rows] = await db.execute(
        `SELECT ${columns}
           FROM design_artifacts a
           JOIN design_project_versions v ON v.id = a.project_version_id
          WHERE ${where.join(' AND ')}
          ORDER BY a.created_at DESC, a.id DESC
          LIMIT ${Number(limit)}`,
        params,
      );
      return rows.map(toArtifact);
    },

    /** The approved publication of a project: its version and marketplace listing, or null. */
    async findApprovedPublication(projectId) {
      const [rows] = await db.execute(
        `SELECT project_version_id, marketplace_listing_ref FROM design_publications
          WHERE project_id = ? AND status = 'approved'
          ORDER BY decided_at DESC LIMIT 1`,
        [projectId],
      );
      return rows[0]
        ? { versionId: rows[0].project_version_id, listingRef: rows[0].marketplace_listing_ref }
        : null;
    },

    async listByJob(jobId) {
      const [rows] = await db.execute(
        `SELECT ${COLUMNS} FROM design_artifacts
          WHERE job_id = ? AND deleted_at IS NULL ORDER BY created_at, id`,
        [jobId],
      );
      return rows.map(toArtifact);
    },
  };
}
