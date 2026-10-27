import { EngineError } from './engines/digitizing-engine.js';

// Job error codes (05-digitizing-engine/validation-and-errors.md). `retry` is how many attempts
// in total a code may use: 1 = never retried, 2 = "once", Infinity = up to the job's max_attempts.
// Summaries are user-safe; details go to restricted logs only.
export const JOB_ERRORS = Object.freeze({
  INVALID_DOCUMENT: { retry: 1, summary: 'Design has invalid data; fix highlighted objects' },
  UNSUPPORTED_STITCH_TYPE: { retry: 1, summary: "This stitch type isn't supported yet" },
  UNSUPPORTED_PARAMETER: {
    retry: 1,
    summary: "A stitch setting in this design isn't supported yet",
  },
  VALIDATION_FAILED: { retry: 1, summary: 'Design breaks machine limits; see issues' },
  ENGINE_TIMEOUT: { retry: Infinity, summary: 'Took too long; retrying' },
  ENGINE_UNAVAILABLE: { retry: Infinity, summary: 'Digitizing service temporarily unavailable' },
  ENGINE_RATE_LIMITED: { retry: Infinity, summary: 'Busy; retrying' },
  ENGINE_INTERNAL: { retry: 2, summary: 'Unexpected engine error' },
  STORAGE_ERROR: { retry: Infinity, summary: 'Temporary storage problem' },
  CANCELLED: { retry: 1, summary: 'Cancelled by user' },
});

/** A storage failure (upload, checksum mismatch, read). Always retryable. */
export class StorageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StorageError';
    this.code = 'STORAGE_ERROR';
  }
}

/** Maps any thrown error to a known job error code. Unknown errors count as ENGINE_INTERNAL. */
export function classify(err) {
  if ((err instanceof EngineError || err instanceof StorageError) && JOB_ERRORS[err.code]) {
    return err.code;
  }
  if (err?.$metadata || err?.name?.startsWith?.('S3')) return 'STORAGE_ERROR';
  return 'ENGINE_INTERNAL';
}

/** Whether a failed attempt should be retried. */
export function shouldRetry(code, attempt, maxAttempts) {
  return attempt < Math.min(JOB_ERRORS[code].retry, maxAttempts);
}
