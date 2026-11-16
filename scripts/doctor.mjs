import { spawnSync } from 'node:child_process';
import { createPublicKey } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { parseEnvironment } from '../src/config/environment.ts';

let failures = 0;
function report(name, ok, detail) {
  console.log(`${ok ? 'OK' : 'FAIL'} ${name}: ${detail}`);
  if (!ok) failures++;
}
function docker(args) {
  return spawnSync('docker', args, { encoding: 'utf8', timeout: 12000, windowsHide: true });
}
const major = Number(process.versions.node.split('.')[0]);
report('Node', major === 24, process.versions.node);
report('Dependencies', existsSync('node_modules/@nestjs/core/package.json') && existsSync('node_modules/typeorm/package.json'), 'run npm install once, then npm ci');
let env;
try {
  env = parseEnvironment({ ...(existsSync('.env') ? parseEnv(readFileSync('.env', 'utf8')) : {}), ...process.env });
  report('Environment', true, `service port ${env.PORT}; database schema operations; TLS ${env.DB_SSL}`);
} catch (error) { report('Environment', false, error.message); }
if (env) {
  try {
    const pem = readFileSync(env.JWT_PUBLIC_KEY_PATH, 'utf8');
    const key = createPublicKey(pem);
    report('JWT public key', pem.trim().startsWith('-----BEGIN PUBLIC KEY-----') && key.asymmetricKeyType === 'rsa' && key.asymmetricKeyDetails.modulusLength >= 2048, 'RS256 public key only');
  } catch { report('JWT public key', false, 'request the public key from Auth or run keys:public'); }
}
const version = docker(['version', '--format', '{{.Server.Version}}']);
report('Docker Engine', version.status === 0 && !!version.stdout?.trim(), version.status === 0 ? version.stdout.trim() : 'unreachable or denied; open Docker Desktop and use a session with Docker access');
const compose = docker(['compose', 'version', '--short']);
report('Docker Compose', compose.status === 0, compose.status === 0 ? compose.stdout.trim() : 'not accessible');
const manifest = docker(['compose', 'config', '--quiet']);
report('Compose manifest', manifest.status === 0, manifest.status === 0 ? 'valid' : 'run docker compose config to inspect');
console.log('Gateway: http://localhost:8080; Operations: http://localhost:3003');
console.log('Run db:check separately after creating Supabase. This doctor does not mutate DB or start containers.');
process.exitCode = failures ? 1 : 0;
