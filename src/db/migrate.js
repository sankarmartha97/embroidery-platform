// CLI: npm run db:migrate
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { migrate } from './migrator.js';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../migrations');

try {
  const { applied } = await migrate({
    databaseUrl: env.DATABASE_URL,
    dir,
    createUsersStub: env.DB_CREATE_USERS_STUB,
    log: (msg) => logger.info(msg),
  });
  logger.info({ applied }, applied.length ? 'migrations applied' : 'schema up to date');
} catch (err) {
  logger.error({ err }, 'migration failed');
  process.exitCode = 1;
}
