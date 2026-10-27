import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';
import { migrate } from '../../src/db/migrator.js';

export const DATABASE_URL = process.env.DATABASE_URL;
export const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../migrations',
);

if (!DATABASE_URL || !new URL(DATABASE_URL).pathname.endsWith('_test')) {
  throw new Error(
    'Integration tests need DATABASE_URL pointing at a *_test database (see .env.test).',
  );
}

/** Drops and recreates the test database, then migrates it from empty. */
export async function resetDatabase() {
  const url = new URL(DATABASE_URL);
  const name = url.pathname.slice(1);
  url.pathname = '/';
  const admin = await mysql.createConnection({ uri: url.toString() });
  await admin.query(`DROP DATABASE IF EXISTS \`${name}\``);
  await admin.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
  await admin.end();
  return migrate({ databaseUrl: DATABASE_URL, dir: MIGRATIONS_DIR, createUsersStub: true });
}

export function createTestPool() {
  return mysql.createPool({ uri: DATABASE_URL, connectionLimit: 5, timezone: 'Z' });
}

export async function insertUsers(pool, ...ids) {
  for (const id of ids) await pool.execute('INSERT IGNORE INTO users (id) VALUES (?)', [id]);
}
