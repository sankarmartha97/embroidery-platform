// Local development only: a stand-in for the marketplace auth server (assumption A5).
// Usage: npm run dev:token -- [userId] [--setup]
//   --setup  creates tmp/dev-auth keys and prints the AUTH_JWT_PUBLIC_KEY line for .env
// Prints a 12-hour ES256 token for the user (default: a fixed dev user id).
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { exportPKCS8, exportSPKI, generateKeyPair, importPKCS8, SignJWT } from 'jose';

const DIR = 'tmp/dev-auth';
const args = process.argv.slice(2);
const userId = args.find((a) => !a.startsWith('--')) ?? '0190f0a0-0000-7000-8000-00000000de11';

if (!existsSync(`${DIR}/private.pem`)) {
  const { publicKey, privateKey } = await generateKeyPair('ES256', { extractable: true });
  await mkdir(DIR, { recursive: true });
  await writeFile(`${DIR}/private.pem`, await exportPKCS8(privateKey), { mode: 0o600 });
  await writeFile(`${DIR}/public.pem`, await exportSPKI(publicKey));
}

if (args.includes('--setup')) {
  const pem = (await readFile(`${DIR}/public.pem`, 'utf8')).trim().replace(/\n/g, '\\n');
  console.log('Add these to .env:\n');
  console.log('AUTH_JWT_ALGORITHMS=ES256');
  console.log(`AUTH_JWT_PUBLIC_KEY=${pem}`);
  process.exit(0);
}

const key = await importPKCS8(await readFile(`${DIR}/private.pem`, 'utf8'), 'ES256');
const token = await new SignJWT({})
  .setProtectedHeader({ alg: 'ES256' })
  .setSubject(userId)
  .setIssuer(process.env.AUTH_JWT_ISSUER ?? 'https://auth.example.com/')
  .setAudience(process.env.AUTH_JWT_AUDIENCE ?? 'embroidery-api')
  .setIssuedAt()
  .setExpirationTime('12h')
  .sign(key);
console.log(token);
