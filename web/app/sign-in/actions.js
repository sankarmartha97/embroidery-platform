'use server';

import { redirect } from 'next/navigation';
import { API_ORIGIN, DEV_SIGN_IN } from '@/lib/server/config.js';
import { setSession } from '@/lib/server/session.js';

/** Dev sign-in: checks the pasted token against the API, then stores it in the cookie. */
export async function devSignIn(_previous, formData) {
  if (!DEV_SIGN_IN) return { error: 'Developer sign-in is disabled.' };
  const token = String(formData.get('token') ?? '').trim();
  const next = safeNext(String(formData.get('next') ?? ''));
  if (!token) return { error: 'Paste a token first.' };

  let res;
  try {
    res = await fetch(`${API_ORIGIN}/api/v1/machine-formats`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store',
    });
  } catch {
    return { error: `The API is not reachable at ${API_ORIGIN}. Is it running?` };
  }
  if (res.status === 401) return { error: 'The API rejected this token. Create a new one.' };
  if (!res.ok) return { error: `Unexpected API response (${res.status}).` };

  await setSession(token);
  redirect(next);
}

/** Only same-site relative paths, never another origin. */
function safeNext(next) {
  return next.startsWith('/') && !next.startsWith('//') ? next : '/projects';
}
