import { redirect } from 'next/navigation';
import { clearSession } from '@/lib/server/session.js';

export async function POST() {
  await clearSession();
  redirect('/sign-in');
}
