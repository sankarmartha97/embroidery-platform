import { errors } from './errors.js';

// Cursor pagination (04-api/conventions.md): ?cursor=&limit= (max 100) → { data, page: { nextCursor } }.
// Cursors are opaque to clients: base64url JSON of the last row's sort key.

export const DEFAULT_LIMIT = 25;
export const MAX_LIMIT = 100;

export function parseLimit(raw) {
  if (raw === undefined) return DEFAULT_LIMIT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) {
    throw errors.validation([
      { path: '/limit', issue: `must be an integer from 1 to ${MAX_LIMIT}` },
    ]);
  }
  return n;
}

export function encodeCursor(key) {
  return Buffer.from(JSON.stringify(key)).toString('base64url');
}

/** @param {(key: unknown) => boolean} isValid shape check for the decoded key */
export function decodeCursor(raw, isValid) {
  if (raw === undefined) return null;
  let key;
  try {
    key = JSON.parse(Buffer.from(String(raw), 'base64url').toString('utf8'));
  } catch {
    key = undefined;
  }
  if (!isValid(key)) throw errors.badRequest('Invalid cursor.');
  return key;
}

/** Rows were fetched with limit + 1; trims the extra row and builds the page info. */
export function toPage(rows, limit, keyOf) {
  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  return {
    data,
    page: { nextCursor: hasMore ? encodeCursor(keyOf(data[data.length - 1])) : null },
  };
}

/** Rejects a query value outside an enum with 422. */
export function parseEnum(name, raw, allowed, fallback) {
  if (raw === undefined) return fallback;
  if (!allowed.includes(raw)) {
    throw errors.validation([{ path: `/${name}`, issue: `must be one of ${allowed.join(', ')}` }]);
  }
  return raw;
}
