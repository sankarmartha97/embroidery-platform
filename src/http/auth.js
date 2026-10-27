import { createRemoteJWKSet, importSPKI, jwtVerify } from 'jose';
import { errors } from './errors.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Verifies JWTs issued by the existing marketplace (04-api/authentication.md):
 * signature, exp, iss and aud on every request. Only `sub` (the user id) is trusted.
 */
export async function createTokenVerifier({ issuer, audience, jwksUrl, publicKeyPem, algorithms }) {
  let key;
  if (jwksUrl) key = createRemoteJWKSet(new URL(jwksUrl));
  else if (publicKeyPem) key = await importSPKI(publicKeyPem.replace(/\\n/g, '\n'), algorithms[0]);
  else throw new Error('Set AUTH_JWKS_URL or AUTH_JWT_PUBLIC_KEY to verify tokens.');

  return async function verifyToken(token) {
    const { payload } = await jwtVerify(token, key, { issuer, audience, algorithms });
    if (typeof payload.sub !== 'string' || !UUID.test(payload.sub)) {
      throw new Error('Token subject is not a user id');
    }
    return { userId: payload.sub.toLowerCase() };
  };
}

/** Sets req.actor = { userId, roles, correlationId }. Roles are loaded server-side, never from claims. */
export function authenticate({ verifyToken, rolesProvider }) {
  return async function authMiddleware(req, _res, next) {
    const header = req.get('authorization') ?? '';
    const [scheme, token] = header.split(' ');
    if (scheme?.toLowerCase() !== 'bearer' || !token) return next(errors.unauthenticated());

    let identity;
    try {
      identity = await verifyToken(token);
    } catch {
      return next(errors.unauthenticated());
    }

    const roles = await rolesProvider.getRoles(identity.userId);
    req.log = req.log.child({ userId: identity.userId });
    const log = req.log;
    req.actor = Object.freeze({
      userId: identity.userId,
      roles: new Set(roles),
      correlationId: req.correlationId,
      /**
       * Audit event (07-security-licensing/platform-controls.md). Written as a structured log
       * line with `audit: true`; logs are archived for audit retention (09-devops).
       */
      audit(type, details = {}) {
        log.info({ audit: true, auditType: type, actorId: identity.userId, ...details }, 'audit');
      },
    });
    next();
  };
}
