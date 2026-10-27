'use client';

import { useActionState } from 'react';
import { devSignIn } from './actions.js';

export default function SignInForm({ next }) {
  const [state, action, pending] = useActionState(devSignIn, null);
  return (
    <form action={action} className="stack">
      <input type="hidden" name="next" value={next} />
      <label className="field">
        <span>Developer token</span>
        <textarea
          name="token"
          className="input mono"
          rows={4}
          required
          autoComplete="off"
          spellCheck={false}
        />
      </label>
      {state?.error && (
        <p role="alert" className="error-text">
          {state.error}
        </p>
      )}
      <button className="btn btn-primary" disabled={pending}>
        {pending ? 'Checking…' : 'Sign in'}
      </button>
    </form>
  );
}
