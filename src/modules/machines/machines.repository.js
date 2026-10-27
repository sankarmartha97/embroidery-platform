const COLUMNS = `id, user_id, nickname, machine_brand, machine_model, preferred_format,
  hoops_json, machine_profile_id, is_default, created_at`;

function parseHoops(value) {
  // JSON columns: parse defensively on read.
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function toMachine(row) {
  return {
    id: row.id,
    userId: row.user_id,
    nickname: row.nickname,
    machineBrand: row.machine_brand,
    machineModel: row.machine_model,
    preferredFormat: row.preferred_format,
    hoops: parseHoops(row.hoops_json),
    machineProfileId: row.machine_profile_id,
    isDefault: Boolean(row.is_default),
    createdAt: row.created_at,
  };
}

export function createMachinesRepository(db) {
  return {
    async listByUser(userId, limit = 20) {
      const [rows] = await db.execute(
        `SELECT ${COLUMNS} FROM design_user_machines
          WHERE user_id = ?
          ORDER BY is_default DESC, created_at ASC, id ASC
          LIMIT ${Number(limit)}`,
        [userId],
      );
      return rows.map(toMachine);
    },

    /** Locks the user's machine rows so concurrent registrations can't pass the limit. */
    async countByUserForUpdate(userId) {
      const [rows] = await db.execute(
        `SELECT id FROM design_user_machines WHERE user_id = ? LIMIT 1000 FOR UPDATE`,
        [userId],
      );
      return rows.length;
    },

    async clearDefault(userId) {
      await db.execute(
        `UPDATE design_user_machines SET is_default = FALSE WHERE user_id = ? AND is_default = TRUE`,
        [userId],
      );
    },

    async insert(machine) {
      await db.execute(
        `INSERT INTO design_user_machines
           (id, user_id, nickname, machine_brand, machine_model, preferred_format,
            hoops_json, machine_profile_id, is_default)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          machine.id,
          machine.userId,
          machine.nickname ?? null,
          machine.machineBrand,
          machine.machineModel,
          machine.preferredFormat,
          JSON.stringify(machine.hoops),
          machine.machineProfileId ?? null,
          machine.isDefault,
        ],
      );
    },
  };
}
