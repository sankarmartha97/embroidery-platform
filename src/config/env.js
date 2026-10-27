// The only file that reads process.env. Everything else imports `env`.
// Required variables are validated at boot; the process exits with a clear message if one is missing.

function str(name, { required = false, fallback } = {}) {
  const value = process.env[name];
  if (value === undefined || value === '') {
    if (required && fallback === undefined) missing.push(name);
    return fallback;
  }
  return value;
}

function int(name, fallback) {
  const raw = str(name, { fallback: String(fallback) });
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) invalid.push(`${name} must be an integer`);
  return value;
}

function bool(name, fallback) {
  const raw = str(name, { fallback: String(fallback) });
  return raw === 'true' || raw === '1';
}

function json(name, fallback) {
  const raw = str(name);
  if (raw === undefined) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    invalid.push(`${name} must be valid JSON`);
    return fallback;
  }
}

const missing = [];
const invalid = [];

const nodeEnv = str('NODE_ENV', { fallback: 'development' });

export const env = Object.freeze({
  NODE_ENV: nodeEnv,
  IS_PROD: nodeEnv === 'production',
  PORT: int('PORT', 3000),
  LOG_LEVEL: str('LOG_LEVEL', { fallback: 'info' }),

  DATABASE_URL: str('DATABASE_URL', { required: true }),
  DB_POOL_SIZE: int('DB_POOL_SIZE', 10),
  DB_CREATE_USERS_STUB: bool('DB_CREATE_USERS_STUB', false),

  AUTH_JWT_ISSUER: str('AUTH_JWT_ISSUER', { required: true }),
  AUTH_JWT_AUDIENCE: str('AUTH_JWT_AUDIENCE', { required: true }),
  AUTH_JWKS_URL: str('AUTH_JWKS_URL'),
  AUTH_JWT_PUBLIC_KEY: str('AUTH_JWT_PUBLIC_KEY'),
  AUTH_JWT_ALGORITHMS: str('AUTH_JWT_ALGORITHMS', { fallback: 'RS256,ES256' })
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  DEV_ROLE_ASSIGNMENTS: json('DEV_ROLE_ASSIGNMENTS', {}),

  RATE_LIMIT_WINDOW_MS: int('RATE_LIMIT_WINDOW_MS', 60_000),
  RATE_LIMIT_MAX: int('RATE_LIMIT_MAX', 600),
  // Tighter per-user buckets (04-api/conventions.md): job creation and download URLs.
  RATE_LIMIT_JOBS_MAX: int('RATE_LIMIT_JOBS_MAX', 30),
  RATE_LIMIT_DOWNLOADS_MAX: int('RATE_LIMIT_DOWNLOADS_MAX', 60),

  AWS_REGION: str('AWS_REGION', { fallback: 'eu-west-1' }),
  AWS_ENDPOINT_URL: str('AWS_ENDPOINT_URL'),
  SQS_QUEUE_URL_EMB_JOBS: str('SQS_QUEUE_URL_EMB_JOBS'),
  S3_BUCKET_ARTIFACTS: str('S3_BUCKET_ARTIFACTS'),

  // Downloads (07-security-licensing/storage-access.md): signed URLs expire in at most 5 minutes.
  DOWNLOAD_URL_TTL_SECONDS: int('DOWNLOAD_URL_TTL_SECONDS', 300),
  // Key for hashing client IPs in download audit rows (never store raw IPs).
  IP_HASH_SECRET: str('IP_HASH_SECRET', {
    fallback: nodeEnv === 'production' ? undefined : 'dev-only-ip-hash-secret',
    required: nodeEnv === 'production',
  }),
  // Entitlement stub until the marketplace integration (OQ-04, S10-01): JSON
  // { "<userId>": [{ "projectId": "...", "basis": "purchase" | "subscription", "ref": "..." }] }
  DEV_ENTITLEMENTS: json('DEV_ENTITLEMENTS', {}),

  // Name recorded on new jobs; the worker's engine must match (ADR-0005: 'fake' until Gate 1).
  DIGITIZING_ENGINE: str('DIGITIZING_ENGINE', { fallback: 'fake' }),

  // Worker: wall-time limit per job attempt, heartbeat interval, and an id for job events.
  JOB_TIMEOUT_MS: int('JOB_TIMEOUT_MS', 600_000),
  JOB_HEARTBEAT_MS: int('JOB_HEARTBEAT_MS', 15_000),
  WORKER_ID: str('WORKER_ID'),
  // Reconciler: a running job whose heartbeat is older than this is treated as stuck.
  RECONCILER_STALE_MS: int('RECONCILER_STALE_MS', 120_000),

  FORMATS_ALLOW_UNGATED: bool('FORMATS_ALLOW_UNGATED', false),
});

if (env.IS_PROD && env.DB_CREATE_USERS_STUB) {
  invalid.push('DB_CREATE_USERS_STUB must not be enabled in production');
}
if (env.IS_PROD && env.FORMATS_ALLOW_UNGATED) {
  invalid.push('FORMATS_ALLOW_UNGATED must not be enabled in production');
}
if (env.DOWNLOAD_URL_TTL_SECONDS < 1 || env.DOWNLOAD_URL_TTL_SECONDS > 300) {
  invalid.push('DOWNLOAD_URL_TTL_SECONDS must be between 1 and 300');
}
if (env.IS_PROD && Object.keys(env.DEV_ENTITLEMENTS).length > 0) {
  invalid.push('DEV_ENTITLEMENTS must be empty in production');
}
if (env.IS_PROD && Object.keys(env.DEV_ROLE_ASSIGNMENTS).length > 0) {
  invalid.push('DEV_ROLE_ASSIGNMENTS must be empty in production');
}

if (missing.length || invalid.length) {
  const lines = [
    ...missing.map((name) => `  - missing required variable ${name}`),
    ...invalid.map((msg) => `  - ${msg}`),
  ];
  console.error(`Invalid configuration:\n${lines.join('\n')}\nSee .env.example.`);
  process.exit(1);
}
