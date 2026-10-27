-- Idempotent job creation (04-api/conventions.md): the same Idempotency-Key with a different
-- request body must return 409 IDEMPOTENCY_KEY_REUSED. The job row stores the SHA-256 of the
-- canonical request so a replay can be compared with the original.
-- Backward compatible (expand): nullable, existing rows keep NULL.

ALTER TABLE digitizing_jobs
  ADD COLUMN request_sha256 CHAR(64) NULL
    COMMENT 'SHA-256 of the canonical create request (project id + body); compared on Idempotency-Key replay';
