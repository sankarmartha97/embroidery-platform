-- Idempotent project duplication (04-api/conventions.md): POST /design-projects/{id}/duplicate
-- takes an optional Idempotency-Key. A retry with the same key returns the copy made the first
-- time; the same key with a different request → 409 IDEMPOTENCY_KEY_REUSED. Keys are per user,
-- and the copy's owner is the caller, so the key is unique per owner.
-- Backward compatible (expand): nullable, existing rows keep NULL (NULLs never collide).

ALTER TABLE design_projects
  ADD COLUMN duplicate_idempotency_key VARCHAR(128) NULL
    COMMENT 'Idempotency-Key of the duplicate request that created this project',
  ADD COLUMN duplicate_request_sha256 CHAR(64) NULL
    COMMENT 'SHA-256 of the canonical duplicate request (source project id + body); compared on replay',
  ADD UNIQUE KEY uq_projects_duplicate_idempotency (owner_user_id, duplicate_idempotency_key);
