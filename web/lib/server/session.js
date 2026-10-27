import { cookies } from 'next/headers';
import { API_ORIGIN, IS_PROD, SESSION_COOKIE } from './config.js';

/** The session token from the httpOnly cookie, or null. */
export async function getToken() {
  return (await cookies()).get(SESSION_COOKIE)?.value ?? null;
}

export async function setSession(token, maxAgeSeconds = 12 * 60 * 60) {
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: IS_PROD,
    sameSite: 'lax',
    path: '/',
    maxAge: maxAgeSeconds,
  });
}

export async function clearSession() {
  (await cookies()).delete(SESSION_COOKIE);
}

/**
 * API call from a server component with the session token.
 * @returns {Promise<{ status: number, data: any }>}
 */
export async function serverApi(path) {
  const token = await getToken();
  if (!token) return { status: 401, data: null };
  const res = await fetch(`${API_ORIGIN}/api/v1${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    cache: 'no-store',
  });
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : null };
}
