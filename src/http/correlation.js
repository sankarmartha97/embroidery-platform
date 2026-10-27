import { randomUUID } from 'node:crypto';

const SAFE_ID = /^[A-Za-z0-9._-]{1,64}$/;

/** Accept X-Correlation-Id or generate one; echo it and attach it to every log line. */
export function correlation(logger) {
  return function correlationMiddleware(req, res, next) {
    const incoming = req.get('x-correlation-id');
    req.correlationId = incoming && SAFE_ID.test(incoming) ? incoming : randomUUID();
    res.set('X-Correlation-Id', req.correlationId);
    req.log = logger.child({ correlationId: req.correlationId });
    next();
  };
}
