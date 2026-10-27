// design_artifacts. Worker writes are idempotent on (job_id, artifact_type, format_code).

const COLUMNS = `id, project_version_id, job_id, artifact_type, format_code, storage_key, sha256,
  file_size_bytes, stitch_count, color_count, trim_count, jump_count, width_mm, height_mm,
  engine_name, engine_version, validation_status, created_at`;

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

    async findById(id) {
      const [rows] = await db.execute(
        `SELECT ${COLUMNS} FROM design_artifacts WHERE id = ? AND deleted_at IS NULL`,
        [id],
      );
      return rows[0] ? toArtifact(rows[0]) : null;
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
