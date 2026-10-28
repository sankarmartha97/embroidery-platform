# Embroidery Platform

API, workers, QA tools and the Studio web app (`web/`) for the Embroidery Design Library & Digitizing Platform. The specification lives in the sibling repository [`embroidery-platform-docs`](../embroidery-platform-docs/README.md); this code follows its [developer guide](../embroidery-platform-docs/10-developer-guide/README.md).

**Status:** sprint S6, part of S7 (duplicate API, export dialog) and the first Studio web app (`web/`, see its [README](web/README.md)). The API serves health, reference data, "My Machine", projects (create, list, read, update, draft autosave with `If-Match`, immutable versions, duplicate) jobs (create with `Idempotency-Key`, get, cancel, `digitizeIfMissing` chaining) and artifacts (list, signed download URLs with an audit row per decision, stitch data for the simulator). The worker runs digitize, validate and export jobs with a deterministic test engine and stores verified artifacts in S3; a scheduled reconciler recovers jobs whose worker died. Validate jobs check stitch data against the machine profile with engine-neutral rules, and job creation and download URLs have their own rate limits. Publications and rights come later.

## Quick start

Requirements: Node 22, Docker.

```bash
cp .env.example .env
npm ci
docker compose up -d                 # MySQL 8 (port 3307) + LocalStack SQS/S3 (port 4566)
npm run dev:token -- --setup         # local signing keys; paste the printed lines into .env
npm run db:migrate
npm run dev                          # API on http://localhost:3000
npm run dev:worker                   # outbox relay + SQS consumer
```

Call the API with a local token:

```bash
TOKEN=$(npm run -s dev:token)        # 12-hour token for the default dev user
docker compose exec mysql mysql -uemb -pemb embroidery \
  -e "INSERT IGNORE INTO users (id) VALUES ('0190f0a0-0000-7000-8000-00000000de11')"
curl -H "Authorization: Bearer $TOKEN" localhost:3000/api/v1/me/machines
```

The `users` table is a local stub. In real environments it belongs to the existing marketplace (OQ-03), and tokens come from its auth server (assumption A5).

## Scripts

| Script                                 | What it does                                                                         |
| -------------------------------------- | ------------------------------------------------------------------------------------ |
| `npm run dev` / `npm run dev:worker`   | API / worker with file watching                                                      |
| `npm run db:migrate`                   | Applies `migrations/*.sql` in order; refuses if an applied file changed              |
| `npm test`                             | Unit tests (no database)                                                             |
| `npm run test:integration`             | Integration tests against real MySQL and LocalStack (`docker compose up -d` first)   |
| `npm run lint`                         | ESLint (including the module-boundary and env rules) and Prettier check              |
| `npm run harness -- file.dst file.jef` | Independent format parser: stitches, jumps, colours, extents, header checks          |
| `npm run dev:token`                    | Local stand-in for marketplace auth                                                  |
| `npm run contracts:sync`               | Copies `openapi.yaml` and the document JSON Schema from the docs repo                |
| `npm run reconcile`                    | One stuck-job reconcile pass (a scheduled task every 5 minutes in real environments) |

## Layout

```
src/
  app.js  server.js          express app factory (no listen) · listen + graceful shutdown
  config/                    env.js (the only reader of process.env) · formats.js (format registry)
  db/                        pool, transactions, forward-only migrator
  http/                      auth (JWT), correlation id, error envelope, validation (OpenAPI), rate limit
  modules/<name>/            routes · service · repository · policy · index.js (public surface)
    health/ identity/ reference/ machines/ projects/ jobs/ artifacts/ (repositories only)
  lib/document/              project document validator (S2-15), SVG path parser, canonical hash
  outbox/                    transactional outbox repository, leader-locked relay, publishers
  aws/                       SQS client, S3 artifact store (re-reads and verifies SHA-256)
workers/
  main.js consumer.js        SQS consumer loop + relay
  job-runner.js              claim, heartbeat, cancel, timeout, upload, retry/fail (S3-04)
  job-errors.js              job error codes, retry policy, user-safe summaries
  validation/                engine-neutral stitch-data rules (S6-01), reusable by any engine adapter
  reconciler.js reconcile.js stuck-job reconciler (S4-03) and its scheduled entry point
  handlers/                  message type → handler; digitize / validate / export / simulate
  engines/                   DigitizingEngine interface · fake/ (deterministic test engine)
tools/format-harness/        independent DST/JEF readers (QA)
web/                         Studio web app (Next.js): sign-in, projects, editor shell, canvas, autosave, jobs
migrations/                  copied from the docs repo; never edit an applied migration
contracts/                   openapi.yaml + project-document.schema.json (source: docs repo)
test/unit · test/integration · test/fixtures/reference
```

Rules enforced in code review and by ESLint: code outside `modules/<x>/` imports only `modules/<x>/index.js`; only `config/env.js` reads environment variables; SQL lives only in repositories and always uses placeholders; services call the policy before reading or writing.

## Foundations sprint: what's done

| Task ([delivery plan](../embroidery-platform-docs/11-backlog/delivery-plan.md)) | Status                   | Evidence                                                                                                    |
| ------------------------------------------------------------------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------- |
| S1-01 Repo skeleton, boundary rule, Prettier                                    | Done                     | `npm run lint` passes; boundary rule fires on a violation                                                   |
| S1-05 Docker Compose + CI pipeline                                              | Done                     | `docker-compose.yml`, `.github/workflows/ci.yml` (not yet run on GitHub)                                    |
| S1-08 Migration runner + first migrations                                       | Done                     | Schema builds from empty: 14 + 2 tables, ≥ 36 foreign keys, seeds load                                      |
| S1-09 App factory, error envelope, correlation id, env config                   | Done                     | Error / 404 / 500 contract tests                                                                            |
| S1-10 Auth middleware (JWT)                                                     | Done against a local key | Valid / expired / wrong issuer / wrong audience / bad signature tests. **Real marketplace JWKS pending A5** |
| S1-16 Independent format parser harness                                         | DST + JEF done           | Matches pyembroidery in both directions (fixtures in `test/fixtures/reference`). **PES not yet**            |
| S1-17 Integration test harness                                                  | Done                     | DB reset + migrate per suite; LocalStack queue fixtures                                                     |
| S2-03 `DigitizingEngine` interface + FakeEngine                                 | Done                     | Deterministic (SHA-256 test); its DST/JEF output reads back correctly                                       |
| S2-06 Outbox / idempotency test scaffolding                                     | Outbox done              | Commit, rollback, retry and leader-lock tests. Idempotency keys arrive with the jobs API                    |
| S2-13 Policy module                                                             | Done                     | Allow + deny tests for every rule in 04-api/authorization.md                                                |
| S2-14 Outbox table + relay (leader lock)                                        | Done                     | Outbox → SQS → consumer integration test                                                                    |
| Extra: "My Machine" API (`/me/machines`)                                        | Done                     | End-to-end tests on real MySQL                                                                              |

Not started (other owners or blocked): S1-02/S2-10 document schema sign-off, S1-04/S1-06 engine POC, S1-07 marketplace schema (OQ-03/OQ-04), S1-11/S1-12 web app and canvas.

## Sprint S3: what's done

| Task                                                                     | Status                 | Evidence                                                                                                                                                                    |
| ------------------------------------------------------------------------ | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S2-15 Server-side document validator                                     | Done                   | Schema + unique ids + thread references + path parsing + closed-path rules + canvas bounds (after transform, along curves) + 200k point limit. `test/unit/document.test.js` |
| S3-03 Projects API: CRUD, autosave (If-Match), versions, snapshot dedupe | Done (duplicate is S7) | IT-09 and IT-10 green; concurrent saves → one 200 + one 409; concurrent snapshots → one version                                                                             |
| S3-04 Worker loop: receive, claim, heartbeat, cancel check               | Done                   | FakeEngine job runs outbox → SQS → worker → S3. IT-02, IT-04, IT-06, IT-11 green, plus retries, timeout and lost-ownership tests                                            |
| S3-07 Integration tests: projects and versions                           | Done                   | `test/integration/projects.test.js` (22 tests)                                                                                                                              |

Not done in S3: S3-01/S3-11 real engine mapping (blocked on Gate 1), S3-02 IaC, S3-08 golden corpus runner.

## Sprint S4: what's done

| Task                                                                            | Status            | Evidence                                                                                                                                                                 |
| ------------------------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| S4-02 Jobs API: create (idempotency), get, cancel, `digitizeIfMissing` chaining | Done              | IT-07, IT-08, IT-11, IT-12 green, plus replay, per-user keys, concurrent same-key requests, 422 rules and the authorization matrix (`test/integration/jobs-api.test.js`) |
| S4-03 Reconciler for stuck jobs                                                 | Done (stuck jobs) | IT-03 green: requeue with a fresh message, attempt 2 succeeds; fails after `max_attempts`; deadline check; leader lock                                                   |
| S4-06 IT-01…IT-05 complete                                                      | Done              | IT-01 (job + outbox in one transaction, sent once), IT-02, IT-03, IT-04, IT-05 (DLQ after max receives, on LocalStack)                                                   |

Schema change: migration `202612140900__job_request_fingerprint.sql` adds `digitizing_jobs.request_sha256`, so a reused key with a different body can be detected. It was added to the docs repository first and copied here.

Not done in S4: S4-01/S4-07 real engine adapter and stitch-outs (blocked on Gate 1), S4-04/S4-05 autosave UI and properties panel (need the web app).

## Sprint S5: what's done

| Task                                                          | Status               | Evidence                                                                                                                                             |
| ------------------------------------------------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| S5-03 Artifacts: key scheme, upload, checksum re-verify, rows | Done (S3–S4)         | IT-06 green; keys `artifacts/{projectId}/{versionId}/{artifactId}.{ext}`                                                                             |
| S5-04 Download URL: authz, entitlement stub, export events    | Done                 | SEC-T03 (403 `ENTITLEMENT_REQUIRED`, denial recorded) and SEC-T04 (URL TTL 300 s; LocalStack now enforces signatures, an expired URL gets 403) green |
| S5-05 Audit events                                            | Done for what exists | Download decisions in `design_export_events`; staff access to others' projects as `audit` log lines                                                  |
| S5-06 Stitch-data fetch for simulator                         | Done                 | `GET /artifacts/{id}/stitch-data`: gzip JSON, content-hash ETag, 304, readers only. Added to `openapi.yaml` in the docs first                        |
| S5-11 IDOR matrix: projects, jobs, artifacts                  | Done                 | SEC-T01, SEC-T02, SEC-T05 green; the matrix fails if a contract route with an id has no row                                                          |

Also: `GET /design-projects/{id}/artifacts` (list with `versionId` / `type` filters). Not done in S5: S5-01/S5-10/S5-13 format writers, parser CI for writers and stitch-outs (real engine, Gate 1), S5-02 IaC, S5-07/08/09 and S5-12 (web app).

## Sprint S6: what's done

| Task                                                                                                     | Status               | Evidence                                                                                                                                                                                   |
| -------------------------------------------------------------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| S6-01 Validation subset: OUT_OF_HOOP, STITCH_TOO_LONG/SHORT, TOO_MANY_COLORS, EMPTY_DESIGN, MISSING_TRIM | Done, engine-neutral | `workers/validation/stitch-rules.js` runs on stitch data, so any engine can reuse it; FakeEngine uses it. A unit test per rule; issues carry object ids (`test/unit/stitch-rules.test.js`) |
| S6-03 Engine version recorded on every artifact                                                          | Done (since S3)      | `engine_name` / `engine_version` on every artifact row                                                                                                                                     |
| S6-04 Validate job + report artifact                                                                     | Done                 | The report names the machine profile; the stitch data gets `validationStatus` and `validationReportArtifactId`                                                                             |
| S6-05 Machine-profiles + machine-formats endpoints                                                       | Done                 | Contract tests check every implemented route against `openapi.yaml` (`test/integration/contract.test.js`). Response schemas for both were added to the docs first                          |
| S6-06 Rate limits (jobs, download URLs)                                                                  | Done                 | SEC-T09 green: separate per-user buckets (`RATE_LIMIT_JOBS_MAX`, `RATE_LIMIT_DOWNLOADS_MAX`)                                                                                               |

Found by the contract tests: `/me/machines` returned `"nickname": null`, which the contract does not allow; it is now omitted when unset.

Not done in S6: S6-02 observability in `dev` (needs the cloud environment), S6-08/S6-09 simulator and job chips and S6-11 E2E (web app), S6-10/S6-12 golden corpus on the real engine (Gate 1).

## Sprint S7: what's done

| Task                                                | Status           | Evidence                                                                                                                                                                                                                      |
| --------------------------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S7-05 Projects list + duplicate API                 | Done             | `POST /design-projects/{id}/duplicate`: copies a chosen version (or the draft) into a private project with version 1 (`reason='duplicate'`); rights are not copied. Contract, IDOR matrix and 6 integration tests green       |
| S7-01 Export dialog + issues panel (click → object) | Done (core flow) | Machine, format (native pre-selected), hoop fit, pre-export validation (errors block, warnings need "Export anyway"), staged progress and Cancel. Clicking an issue glides the camera to the object (320 ms). e2e covers both |

Schema change: migration `202702010900__project_duplicate_idempotency.sql` stores the duplicate request's `Idempotency-Key` and fingerprint on the copy, so a retry returns the same copy and a reused key with a different body is 409. It was added to the docs repository first and copied here.

Not done in S7: S7-02 simulator selection and "out of date" (needs the simulator, S6-08), S7-03 worker load test and S7-07 k6 load (need a sized environment), S7-04/S7-06 bug-fix buffers, S7-08/S7-09/S7-10 Gate 2 report, physical stitch-outs and review (people and machines). Export options from FS-8.6 (trims as jumps or commands, max stitch length override, file name) wait for the real engine.

## Studio web app (first cut)

| Task                                                               | Status                      | Evidence                                                                                                                                |
| ------------------------------------------------------------------ | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| S1-11 Studio app shell, routing, auth session, design tokens       | Done (dev sign-in until A5) | httpOnly session cookie, same-origin API proxy; production build hides dev sign-in                                                      |
| S1-12 Canvas: mm coordinates, zoom/pan, rulers, grid, hoop outline | Done                        | Camera unit tests; e2e: `1` = 100 % (96 dpi), `0` fits the hoop                                                                         |
| S2-17 Undo/redo command stack                                      | Done                        | ≥ 200 steps, unit tests; e2e undo restores the saved value                                                                              |
| S4-04 Autosave, status indicator, conflict modal                   | Done                        | Autosave unit tests (debounce, max wait, offline retry, conflict, invalid); e2e two-writer conflict → "Reload their copy"               |
| S6-09 Job chips + progress polling                                 | Done                        | e2e: Validate shows issues by object; Export downloads the DST                                                                          |
| S3-05 Drawing: rectangle, ellipse, polygon                         | Done                        | `web/test/shapes.test.js` checks drawn shapes with the API's own validator; e2e draws each with the mouse and checks the saved document |
| S3-06 Pen / Bézier tool                                            | Done                        | Open and closed paths, corner and smooth nodes, node editing (e2e drags a corner and checks the saved path)                             |
| S3-09 Playwright E2E skeleton                                      | Done                        | `web/e2e/studio.spec.js` runs in CI against the full stack and fails on browser console errors                                          |

Also added for the Studio: `GET /artifacts/{id}/report` (the issues panel; in the docs contract first, covered by the IDOR matrix and contract tests). Partly done: S2-16 (selection, arrow-key nudge and numeric position; no drag handles yet). Not started: text, SVG import, the simulator (S6-08).

## Known limits

- **FakeEngine is not a production engine.** It turns every object into running stitches, and its DST/JEF writers have not passed the [production enablement gate](../embroidery-platform-docs/05-digitizing-engine/format-support.md#production-enablement-gate). Every format is `productionEnabled: false`.
- **Roles** come from `DEV_ROLE_ASSIGNMENTS` until the marketplace role source is connected (A5). Production refuses non-empty assignments.
- **Rate limits** are per API task (in memory). Fleet-wide limits belong at the edge (WAF).
- **Idempotency on other POSTs:** the optional `Idempotency-Key` on project and version creation is accepted but not stored (no table for it; version snapshots are already deduplicated by SHA-256). Job creation, where it is required, and project duplication are fully idempotent.
- **The reconciler handles stuck jobs only.** Orphaned S3 objects and outbox lag (also its job in 09-devops) are not done yet. The alarm on DLQ depth is CloudWatch infrastructure.
- **Simulate** calls `renderSimulation` expecting `{ buffer, formatCode }`; that shape is provisional until the real engine is chosen. FakeEngine does not render, so simulate jobs fail with `UNSUPPORTED_STITCH_TYPE`.
- **Entitlements are a stub** (`DEV_ENTITLEMENTS`, refused in production) until the marketplace integration (S10-01, OQ-04). Customers download only machine files and previews of the version in the **approved publication**; publications have no API yet, so tests insert them directly.
- **Audit events** other than downloads are structured log lines (`"audit": true`), relying on the log archive for retention; there is no audit table in the schema. Publication decisions, rights verification and role changes are audited when those features exist.
- **Validation rules:** a colour is a colour block (colour changes + 1); a short stitch is measured only between two consecutive needle penetrations (the first stitch after a jump is a normal needle-down); `STITCH_TOO_LONG` is a warning when the target writer splits long stitches (FakeEngine's do). Thresholds come from the machine profile; DENSITY_TOO_HIGH and EXCESSIVE_JUMPS are not in this subset.
- **Interpretations to confirm:** collaborators need `can_export` to download machine files ("per above" in 04-api/authorization.md read as the export rule); viewers may still download previews, stitch data and reports. Customers cannot list a project's artifacts (they get download URLs by artifact id). only the owner may change `visibility` (sharing is the owner's call); anyone who can read a project and has a designer role may duplicate it into a project of their own (a viewer included), and a "My Machine" profile of another user is dropped from the copy; archived projects are read-only (409); a missing `If-Match` or `Idempotency-Key` is 400. For jobs: `inputArtifactId` is required for simulate/validate/export unless `digitizeIfMissing` is true, which reuses the version's newest stitch data or chains a digitize job; a chained job ends with its parent's error or cancellation; the requester or anyone who can edit the project may cancel; a crashed worker is reported as `ENGINE_TIMEOUT`; retryable codes get a "try again later" summary on their final failure, because the table's text says "retrying".
- Numbers such as the 10-machine limit and 30–600 mm hoop range are placeholders from the [feature specifications](../embroidery-platform-docs/01-product/feature-specifications.md).
