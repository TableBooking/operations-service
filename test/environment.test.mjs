import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEnvironment } from '../src/config/environment.ts';

const valid = () => ({
  DATABASE_URL: 'postgresql://operations_user.ref:fake-test-password@aws-0-test.pooler.supabase.com:5432/postgres',
  RABBITMQ_URL: 'amqp://dev:dev@localhost:5672',
});

test('defaults match the existing gateway target and operations schema', () => {
  const config = parseEnvironment(valid());
  assert.equal(config.PORT, 3003);
  assert.equal(config.DB_SCHEMA, 'operations');
  assert.equal(config.DB_SSL, true);
  assert.equal(config.JWT_ISSUER, 'restaurant-auth');
  assert.equal(config.JWT_AUDIENCE, 'restaurant-api');
});
test('Supabase template must be replaced before startup', () => {
  assert.throws(() => parseEnvironment({ ...valid(), DATABASE_URL: 'postgresql://operations_user.PROJECT_REF:URL_ENCODED_PASSWORD@aws-0-REGION.pooler.supabase.com:5432/postgres' }), /placeholders/);
});
test('Supabase API URLs are not PostgreSQL connection URLs', () => {
  assert.throws(() => parseEnvironment({ ...valid(), DATABASE_URL: 'https://project.supabase.co' }), /PostgreSQL/);
});
test('remote DB cannot disable certificate-protected TLS', () => {
  assert.throws(() => parseEnvironment({ ...valid(), DB_SSL: 'false' }), /local development/);
});
test('development local PostgreSQL may disable TLS explicitly', () => {
  assert.equal(parseEnvironment({ ...valid(), DATABASE_URL: 'postgresql://dev:dev@localhost:5432/operations_db', DB_SSL: 'false' }).DB_SSL, false);
});
test('production cannot disable TLS on loopback either', () => {
  assert.throws(() => parseEnvironment({ ...valid(), NODE_ENV: 'production', DATABASE_URL: 'postgresql://dev:dev@localhost:5432/operations_db', DB_SSL: 'false' }), /local development/);
});
test('connection string cannot override TLS settings or CA', () => {
  for (const option of ['sslmode=require', 'sslmode=no-verify', 'sslrootcert=path', 'ssl=false']) {
    assert.throws(() => parseEnvironment({ ...valid(), DATABASE_URL: `${valid().DATABASE_URL}?${option}` }), /SSL query parameters/);
  }
});
test('persistent TypeORM service rejects Supabase transaction pooler', () => {
  assert.throws(() => parseEnvironment({ ...valid(), DATABASE_URL: valid().DATABASE_URL.replace(':5432/', ':6543/') }), /Session pooler/);
});
test('cannot accidentally use another service schema', () => {
  assert.throws(() => parseEnvironment({ ...valid(), DB_SCHEMA: 'public' }), /operations/);
});
test('reject invalid ports, pool size, booleans and broker protocol', () => {
  for (const values of [{ PORT: '8080x' }, { PORT: '0' }, { DB_POOL_MAX: '999' }, { DB_SSL: 'yes' }, { RABBITMQ_URL: 'https://localhost' }]) {
    assert.throws(() => parseEnvironment({ ...valid(), ...values }));
  }
});
test('validation errors do not echo the database password', () => {
  const password = 'do-not-leak-very-secret';
  try { parseEnvironment({ ...valid(), DATABASE_URL: `https://user:${password}@example.test` }); }
  catch (error) { assert.equal(error.message.includes(password), false); return; }
  assert.fail('invalid URL should be rejected');
});
