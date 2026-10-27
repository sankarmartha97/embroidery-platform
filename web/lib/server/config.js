// Server-only settings for the web app. Never imported by client components.

export const API_ORIGIN = process.env.API_ORIGIN ?? 'http://127.0.0.1:3000';
export const SESSION_COOKIE = 'emb_session';
export const IS_PROD = process.env.NODE_ENV === 'production';

// Real sign-in comes from the existing marketplace (assumption A5). Until then a developer
// pastes a token from `npm run dev:token`. Never available in production builds.
export const DEV_SIGN_IN = !IS_PROD && process.env.ENABLE_DEV_SIGN_IN !== 'false';
