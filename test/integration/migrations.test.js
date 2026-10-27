// S1-08 done-when: `npm run db:migrate` builds the schema from empty.
import assert from 'node:assert/strict';
import { cp, mkdtemp, appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { migrate } from '../../src/db/migrator.js';
import { createTestPool, DATABASE_URL, MIGRATIONS_DIR, resetDatabase } from '../helpers/db.js';

describe('migrations', () => {
  let pool;
  let firstRun;
  before(async () => {
    firstRun = await resetDatabase();
    pool = createTestPool();
  });
  after(() => pool.end());

  it('builds the full schema from an empty database', async () => {
    assert.equal(firstRun.applied.length, 3);
    const [tables] = await pool.query(
      `SELECT table_name AS t FROM information_schema.tables WHERE table_schema = DATABASE()`,
    );
    const names = new Set(tables.map((r) => r.t));
    for (const t of [
      'design_projects',
      'digitizing_jobs',
      'design_artifacts',
      'outbox_messages',
      'design_user_machines',
      'design_stitch_outcomes',
      'schema_migrations',
    ]) {
      assert.ok(names.has(t), `missing table ${t}`);
    }
    const [[{ fks }]] = await pool.query(
      `SELECT COUNT(*) AS fks FROM information_schema.referential_constraints WHERE constraint_schema = DATABASE()`,
    );
    assert.ok(fks >= 36, `expected at least 36 foreign keys, got ${fks}`);
  });

  it('loads the seed reference data', async () => {
    const [[{ n }]] = await pool.query(
      'SELECT COUNT(*) AS n FROM design_machine_profiles WHERE owner_user_id IS NULL',
    );
    assert.equal(n, 5);
  });

  it('is idempotent', async () => {
    const again = await migrate({
      databaseUrl: DATABASE_URL,
      dir: MIGRATIONS_DIR,
      createUsersStub: true,
    });
    assert.deepEqual(again.applied, []);
  });

  it('refuses to run when an applied migration has been edited', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'emb-mig-'));
    try {
      await cp(MIGRATIONS_DIR, dir, { recursive: true });
      await appendFile(path.join(dir, '202611020905__seed_reference_data.sql'), '\n-- edited\n');
      await assert.rejects(
        migrate({ databaseUrl: DATABASE_URL, dir }),
        /changed after it was applied/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
