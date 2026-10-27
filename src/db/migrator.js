import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import mysql from 'mysql2/promise';

const FILE_PATTERN = /^(\d{12})__[a-z0-9_]+\.sql$/;

/**
 * Forward-only SQL migrations (03-database/migration-strategy.md).
 * Files apply in name order. An applied file must never change: its checksum is recorded.
 * MySQL DDL commits implicitly, so a failed file stops the run and is not recorded.
 */
export async function migrate({ databaseUrl, dir, createUsersStub = false, log = () => {} }) {
  const conn = await mysql.createConnection({ uri: databaseUrl, multipleStatements: true });
  try {
    await conn.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version     CHAR(12)     PRIMARY KEY,
        filename    VARCHAR(200) NOT NULL,
        checksum    CHAR(64)     NOT NULL,
        applied_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

    if (createUsersStub) {
      // Local/test only. In real environments `users` belongs to the existing marketplace (OQ-03).
      await conn.query('CREATE TABLE IF NOT EXISTS users (id CHAR(36) PRIMARY KEY) ENGINE=InnoDB');
    }

    const files = (await readdir(dir)).filter((f) => FILE_PATTERN.test(f)).sort();
    const [rows] = await conn.query('SELECT version, filename, checksum FROM schema_migrations');
    const applied = new Map(rows.map((r) => [r.version, r]));
    const done = [];

    for (const filename of files) {
      const version = filename.match(FILE_PATTERN)[1];
      const sql = await readFile(path.join(dir, filename), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const previous = applied.get(version);

      if (previous) {
        if (previous.checksum !== checksum) {
          throw new Error(
            `Migration ${filename} changed after it was applied. Never edit an applied migration; add a new one.`,
          );
        }
        continue;
      }

      log(`applying ${filename}`);
      await conn.query(sql);
      await conn.query(
        'INSERT INTO schema_migrations (version, filename, checksum) VALUES (?, ?, ?)',
        [version, filename, checksum],
      );
      done.push(filename);
    }
    return { applied: done };
  } finally {
    await conn.end();
  }
}
