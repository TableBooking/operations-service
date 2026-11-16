import { createPrivateKey, createPublicKey } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const source = process.argv[2];
const destination = resolve(process.argv[3] ?? './keys/auth-public.pem');
if (!source) {
  console.error('Usage: npm run keys:public -- <path-to-existing-auth-private.pem> [public-output-path]');
  process.exit(1);
}
try {
  const privateKey = createPrivateKey(readFileSync(source));
  if (privateKey.asymmetricKeyType !== 'rsa' || (privateKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) {
    throw new Error('Auth key must be RSA with at least 2048 bits');
  }
  const publicPem = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' });
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, publicPem, { flag: 'wx' });
  console.log(`Public key exported: ${destination}`);
} catch (error) {
  console.error(error?.code === 'EEXIST'
    ? 'Public output already exists; no file was overwritten.'
    : 'Cannot export public key. Check the source path and RSA key format.');
  process.exitCode = 1;
}
