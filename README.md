# Embroidery Platform

API, workers and QA tools for the Embroidery Design Library & Digitizing Platform. The specification lives in the sibling repository [`embroidery-platform-docs`](../embroidery-platform-docs/README.md); this code follows its [developer guide](../embroidery-platform-docs/10-developer-guide/README.md).

**Status:** foundations sprint (S1–S2). The API serves health, reference data and "My Machine". The outbox, queue and worker pipeline runs end to end with a deterministic test engine. Projects, jobs and artifacts come next (S3).

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

| Script                                 | What it does                                                                       |
| -------------------------------------- | ---------------------------------------------------------------------------------- |
| `npm run dev` / `npm run dev:worker`   | API / worker with file watching                                                    |
| `npm run db:migrate`                   | Applies `migrations/*.sql` in order; refuses if an applied file changed            |
| `npm test`                             | Unit tests (no database)                                                           |
| `npm run test:integration`             | Integration tests against real MySQL and LocalStack (`docker compose up -d` first) |
| `npm run lint`                         | ESLint (including the module-boundary and env rules) and Prettier check            |
| `npm run harness -- file.dst file.jef` | Independent format parser: stitches, jumps, colours, extents, header checks        |
| `npm run dev:token`                    | Local stand-in for marketplace auth                                                |
| `npm run contracts:sync`               | Copies `openapi.yaml` and the document JSON Schema from the docs repo              |

## Layout

```
src/
  app.js  server.js          express app factory (no listen) · listen + graceful shutdown
  config/                    env.js (the only reader of process.env) · formats.js (format registry)
  db/                        pool, transactions, forward-only migrator
  http/                      auth (JWT), correlation id, error envelope, validation (OpenAPI), rate limit
  modules/<name>/            routes · service · repository · policy · index.js (public surface)
    health/ identity/ reference/ machines/ projects/ (policy only)
  outbox/                    transactional outbox repository, leader-locked relay, publishers
workers/
  main.js consumer.js        SQS consumer loop + relay
  handlers/                  message type → handler
  engines/                   DigitizingEngine interface · fake/ (deterministic test engine)
tools/format-harness/        independent DST/JEF readers (QA)
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

Not started (other owners or blocked): S1-02/S2-10 document schema sign-off, S1-04/S1-06 engine POC, S1-07 marketplace schema (OQ-03/OQ-04), S1-11/S1-12 web app and canvas, S2-15 server-side document validator.

## Known limits

- **FakeEngine is not a production engine.** It turns every object into running stitches, and its DST/JEF writers have not passed the [production enablement gate](../embroidery-platform-docs/05-digitizing-engine/format-support.md#production-enablement-gate). Every format is `productionEnabled: false`.
- **Roles** come from `DEV_ROLE_ASSIGNMENTS` until the marketplace role source is connected (A5). Production refuses non-empty assignments.
- **Rate limits** are per API task (in memory). Fleet-wide limits belong at the edge (WAF).
- Numbers such as the 10-machine limit and 30–600 mm hoop range are placeholders from the [feature specifications](../embroidery-platform-docs/01-product/feature-specifications.md).
