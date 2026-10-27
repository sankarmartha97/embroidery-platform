// Error envelope (04-api/conventions.md): { error: { code, message, correlationId, details? } }
// Codes are stable and documented in 04-api/error-codes.md.

export class AppError extends Error {
  constructor(code, httpStatus, message, details) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
  }
}

export const errors = {
  badRequest: (message = 'Malformed request.') => new AppError('BAD_REQUEST', 400, message),
  unauthenticated: () => new AppError('UNAUTHENTICATED', 401, 'Authentication required.'),
  forbidden: () => new AppError('FORBIDDEN', 403, 'You are not allowed to do this.'),
  notFound: () => new AppError('NOT_FOUND', 404, 'Not found.'),
  invalidState: (message) => new AppError('INVALID_STATE', 409, message),
  draftConflict: (currentRevision) =>
    new AppError(
      'DRAFT_CONFLICT',
      409,
      'The draft was changed elsewhere. Reload it before saving again.',
      [{ path: '/If-Match', issue: `current draftRevision is ${currentRevision}` }],
    ),
  validation: (details, message = 'Request validation failed.') =>
    new AppError('VALIDATION_FAILED', 422, message, details),
  unsupportedFormat: (format) =>
    new AppError('UNSUPPORTED_FORMAT', 422, `Format ${format} is not supported.`, [
      { path: '/preferredFormat', issue: 'must be one of /machine-formats' },
    ]),
  rateLimited: () => new AppError('RATE_LIMITED', 429, 'Too many requests. Try again later.'),
};

export function notFoundHandler(_req, _res, next) {
  next(errors.notFound());
}

/** Maps errors to the envelope. Unknown errors become 500 INTERNAL; the stack goes to logs only. */
export function createErrorHandler(logger) {
  return function errorHandler(err, req, res, _next) {
    let appError = err;
    if (!(err instanceof AppError)) {
      if (err?.type === 'entity.parse.failed') appError = errors.badRequest('Malformed JSON.');
      else if (err?.type === 'entity.too.large')
        appError = errors.badRequest('Request body too large.');
      else appError = new AppError('INTERNAL', 500, 'Something went wrong. Try again later.');
    }

    const log = req.log ?? logger;
    if (appError.httpStatus >= 500) log.error({ err }, 'unhandled error');
    else log.info({ code: appError.code, status: appError.httpStatus }, 'request rejected');

    const body = {
      error: {
        code: appError.code,
        message: appError.message,
        correlationId: req.correlationId,
      },
    };
    if (appError.details) body.error.details = appError.details;
    res.status(appError.httpStatus).json(body);
  };
}
