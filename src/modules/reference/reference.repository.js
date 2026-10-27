const PROFILE_COLUMNS = `id, owner_user_id, name, format_code, hoop_width_mm, hoop_height_mm,
  min_stitch_length_mm, max_stitch_length_mm, max_jump_length_mm, trim_jump_threshold_mm, max_colors`;

function toProfile(row) {
  return {
    id: row.id,
    name: row.name,
    format: row.format_code,
    hoopWidthMm: Number(row.hoop_width_mm),
    hoopHeightMm: Number(row.hoop_height_mm),
    minStitchLengthMm: Number(row.min_stitch_length_mm),
    maxStitchLengthMm: Number(row.max_stitch_length_mm),
    maxJumpLengthMm: row.max_jump_length_mm === null ? null : Number(row.max_jump_length_mm),
    trimJumpThresholdMm:
      row.trim_jump_threshold_mm === null ? null : Number(row.trim_jump_threshold_mm),
    maxColors: row.max_colors,
    isSystemPreset: row.owner_user_id === null,
  };
}

export function createReferenceRepository(db) {
  return {
    /** System presets plus the caller's own active profiles. */
    async listMachineProfiles(userId) {
      const [rows] = await db.execute(
        `SELECT ${PROFILE_COLUMNS}
           FROM design_machine_profiles
          WHERE is_active = TRUE AND (owner_user_id IS NULL OR owner_user_id = ?)
          ORDER BY owner_user_id IS NOT NULL, name
          LIMIT 200`,
        [userId],
      );
      return rows.map(toProfile);
    },
  };
}
