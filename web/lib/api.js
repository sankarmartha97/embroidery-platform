// Browser API client. Requests go to this app's /api/v1 proxy, which adds the session token
// server-side, so page scripts never see the token.

export class ApiError extends Error {
  constructor(status, body) {
    const error = body?.error ?? {};
    super(error.message ?? `Request failed (${status})`);
    this.name = 'ApiError';
    this.status = status;
    this.code = error.code ?? 'UNKNOWN';
    this.details = error.details ?? [];
    this.correlationId = error.correlationId ?? null;
  }
}

/**
 * @returns {Promise<{ data: any, headers: Headers, status: number }>}
 * Throws ApiError for HTTP errors and calls onUnauthenticated on 401 (session expired).
 */
export async function apiFetch(
  path,
  { method = 'GET', body, headers = {}, fetchImpl = fetch, onUnauthenticated = goToSignIn } = {},
) {
  const res = await fetchImpl(`/api/v1${path}`, {
    method,
    headers: {
      Accept: 'application/json',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    if (res.status === 401) onUnauthenticated();
    throw new ApiError(res.status, data);
  }
  return { data, headers: res.headers, status: res.status };
}

function goToSignIn() {
  if (typeof window === 'undefined') return;
  const next = encodeURIComponent(window.location.pathname + window.location.search);
  window.location.assign(`/sign-in?next=${next}`);
}

/** A fresh Idempotency-Key per user action (job creation requires one). */
export const newIdempotencyKey = () => crypto.randomUUID();
