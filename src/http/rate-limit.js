import { errors } from './errors.js';

/**
 * Fixed-window limiter keyed by user id, else client IP (04-api/conventions.md).
 * In-memory, so limits are per API task. Edge limits (AWS WAF) cover the fleet-wide case;
 * replace the store if per-user limits must be exact across tasks.
 */
export function rateLimit({ windowMs, max, keyPrefix = 'global' }) {
  const hits = new Map();
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) if (entry.resetAt <= now) hits.delete(key);
  }, windowMs);
  sweep.unref();

  return function rateLimitMiddleware(req, res, next) {
    const who = req.actor?.userId ?? `ip:${req.ip}`;
    const key = `${keyPrefix}:${who}`;
    const now = Date.now();
    let entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(key, entry);
    }
    entry.count += 1;

    const resetSeconds = Math.ceil((entry.resetAt - now) / 1000);
    res.set('RateLimit-Limit', String(max));
    res.set('RateLimit-Remaining', String(Math.max(0, max - entry.count)));
    res.set('RateLimit-Reset', String(resetSeconds));

    if (entry.count > max) {
      res.set('Retry-After', String(resetSeconds));
      return next(errors.rateLimited());
    }
    next();
  };
}
