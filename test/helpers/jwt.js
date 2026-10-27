import { exportSPKI, generateKeyPair, SignJWT } from 'jose';
import { createTokenVerifier } from '../../src/http/auth.js';

export const ISSUER = 'https://auth.test/';
export const AUDIENCE = 'embroidery-api';

/** A signing key pair plus a verifier configured like production (PEM public key). */
export async function createAuthKit() {
  const { publicKey, privateKey } = await generateKeyPair('ES256');
  const other = await generateKeyPair('ES256');
  const verifyToken = await createTokenVerifier({
    issuer: ISSUER,
    audience: AUDIENCE,
    publicKeyPem: await exportSPKI(publicKey),
    algorithms: ['ES256'],
  });

  async function sign(sub, { exp = '5m', iss = ISSUER, aud = AUDIENCE, key = privateKey } = {}) {
    return new SignJWT({})
      .setProtectedHeader({ alg: 'ES256' })
      .setSubject(sub)
      .setIssuer(iss)
      .setAudience(aud)
      .setIssuedAt()
      .setExpirationTime(exp)
      .sign(key);
  }

  return { verifyToken, sign, otherPrivateKey: other.privateKey };
}
