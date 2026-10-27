import mysql from 'mysql2/promise';
import { env } from '../config/env.js';
import { transaction } from './transaction.js';

export const pool = mysql.createPool({
  uri: env.DATABASE_URL,
  connectionLimit: env.DB_POOL_SIZE,
  timezone: 'Z',
  dateStrings: false,
  supportBigNumbers: true,
});

export function withTransaction(fn) {
  return transaction(pool, fn);
}
