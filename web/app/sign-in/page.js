import { DEV_SIGN_IN } from '@/lib/server/config.js';
import SignInForm from './sign-in-form.js';

export const metadata = { title: 'Sign in · Studio' };

export default async function SignInPage({ searchParams }) {
  const { next = '/projects' } = await searchParams;
  return (
    <main className="auth-page">
      <div className="card auth-card">
        <h1>Sign in to Studio</h1>
        {DEV_SIGN_IN ? (
          <>
            <p className="muted">
              Accounts come from the marketplace. Until that sign-in is connected, use a developer
              token: run <code className="mono">npm run dev:token</code> in the API folder and paste
              it here.
            </p>
            <SignInForm next={next} />
          </>
        ) : (
          <p className="muted">Sign in through the marketplace to open the Studio.</p>
        )}
      </div>
    </main>
  );
}
