// Same-origin proxy to the API. The browser never holds the token: it is read from the httpOnly
// session cookie here and sent as a bearer token. Only listed headers pass in either direction.
import { API_ORIGIN } from '@/lib/server/config.js';
import { getToken } from '@/lib/server/session.js';

const REQUEST_HEADERS = [
  'accept',
  'content-type',
  'if-match',
  'if-none-match',
  'idempotency-key',
  'x-correlation-id',
];
const RESPONSE_HEADERS = [
  'content-type',
  'etag',
  'cache-control',
  'location',
  'retry-after',
  'ratelimit-limit',
  'ratelimit-remaining',
  'ratelimit-reset',
  'x-correlation-id',
];

async function proxy(request, { params }) {
  const { path } = await params;
  const url = new URL(request.url);
  const target = `${API_ORIGIN}/api/v1/${path.map(encodeURIComponent).join('/')}${url.search}`;

  const headers = new Headers();
  for (const name of REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  const token = await getToken();
  if (token) headers.set('authorization', `Bearer ${token}`);

  const hasBody = !['GET', 'HEAD'].includes(request.method);
  let upstream;
  try {
    upstream = await fetch(target, {
      method: request.method,
      headers,
      body: hasBody ? await request.arrayBuffer() : undefined,
      cache: 'no-store',
      redirect: 'manual',
    });
  } catch {
    return Response.json(
      {
        error: {
          code: 'UPSTREAM_UNAVAILABLE',
          message: 'The API is not reachable.',
          correlationId: null,
        },
      },
      { status: 502 },
    );
  }

  // fetch() has already decoded any Content-Encoding, so the body is sent as plain bytes.
  const out = new Headers();
  for (const name of RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) out.set(name, value);
  }
  const body =
    upstream.status === 204 || upstream.status === 304 ? null : await upstream.arrayBuffer();
  return new Response(body, { status: upstream.status, headers: out });
}

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
export const dynamic = 'force-dynamic';
