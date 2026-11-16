export interface Environment {
  NODE_ENV: 'development' | 'test' | 'production';
  HOST: string;
  PORT: number;
  DATABASE_URL: string;
  DB_SCHEMA: 'operations';
  DB_SSL: boolean;
  DB_SSL_CA_PATH?: string;
  DB_POOL_MAX: number;
  DB_CONNECT_TIMEOUT_MS: number;
  JWT_PUBLIC_KEY_PATH: string;
  JWT_ISSUER: string;
  JWT_AUDIENCE: string;
  RABBITMQ_URL: string;
  RABBITMQ_EXCHANGE: string;
  RABBITMQ_QUEUE: string;
}

export function parseEnvironment(input: Record<string, string | undefined>): Environment {
  const required = (name: string): string => {
    const value = input[name]?.trim();
    if (!value) throw new Error(`${name} is required; see .env.example`);
    return value;
  };
  const integer = (name: string, fallback: number, min: number, max: number): number => {
    const text = input[name] ?? String(fallback);
    const value = Number(text);
    if (!/^\d+$/.test(text) || !Number.isSafeInteger(value) || value < min || value > max) {
      throw new Error(`${name} must be an integer from ${min} to ${max}`);
    }
    return value;
  };
  const nodeEnv = input.NODE_ENV ?? 'development';
  if (!['development', 'test', 'production'].includes(nodeEnv)) throw new Error('NODE_ENV is invalid');
  const databaseUrl = required('DATABASE_URL');
  let db: URL;
  try { db = new URL(databaseUrl); } catch { throw new Error('DATABASE_URL must be a PostgreSQL URL'); }
  if (!['postgres:', 'postgresql:'].includes(db.protocol) || !db.username || !db.password || db.pathname.length < 2) {
    throw new Error('DATABASE_URL must contain a PostgreSQL username, password and database');
  }
  if (/PROJECT_REF|URL_ENCODED_PASSWORD|YOUR_PASSWORD|\[.*\]/i.test(databaseUrl)) {
    throw new Error('Replace DATABASE_URL placeholders using Supabase Connect > Session pooler');
  }
  // node-postgres connection-string TLS flags can override the explicit ssl
  // object (and its CA). Keep TLS in one place to preserve verification.
  if ([...db.searchParams.keys()].some((key) => /^ssl/i.test(key))) {
    throw new Error('Remove SSL query parameters from DATABASE_URL; configure DB_SSL and DB_SSL_CA_PATH');
  }
  const dbSslText = input.DB_SSL ?? 'true';
  if (!['true', 'false'].includes(dbSslText)) throw new Error('DB_SSL must be true or false');
  const dbSsl = dbSslText === 'true';
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(db.hostname);
  if (!dbSsl && (!loopback || nodeEnv === 'production')) throw new Error('DB_SSL=false is allowed only for local development PostgreSQL');
  if ((db.hostname.endsWith('.supabase.com') || db.hostname.endsWith('.supabase.co')) && db.port === '6543') {
    throw new Error('Use Supabase Session pooler port 5432 for this persistent service and migrations');
  }
  if ((input.DB_SCHEMA ?? 'operations') !== 'operations') throw new Error('DB_SCHEMA must be operations');
  const rabbitUrl = required('RABBITMQ_URL');
  try {
    if (!['amqp:', 'amqps:'].includes(new URL(rabbitUrl).protocol)) throw new Error();
  } catch { throw new Error('RABBITMQ_URL must be an AMQP URL'); }
  return {
    NODE_ENV: nodeEnv as Environment['NODE_ENV'],
    HOST: input.HOST ?? '0.0.0.0',
    PORT: integer('PORT', 3003, 1, 65535),
    DATABASE_URL: databaseUrl,
    DB_SCHEMA: 'operations',
    DB_SSL: dbSsl,
    DB_SSL_CA_PATH: input.DB_SSL_CA_PATH?.trim() || undefined,
    DB_POOL_MAX: integer('DB_POOL_MAX', 5, 1, 20),
    DB_CONNECT_TIMEOUT_MS: integer('DB_CONNECT_TIMEOUT_MS', 5000, 100, 60000),
    JWT_PUBLIC_KEY_PATH: input.JWT_PUBLIC_KEY_PATH ?? './keys/auth-public.pem',
    JWT_ISSUER: input.JWT_ISSUER ?? 'restaurant-auth',
    JWT_AUDIENCE: input.JWT_AUDIENCE ?? 'restaurant-api',
    RABBITMQ_URL: rabbitUrl,
    RABBITMQ_EXCHANGE: input.RABBITMQ_EXCHANGE ?? 'restaurant.events',
    RABBITMQ_QUEUE: input.RABBITMQ_QUEUE ?? 'operations.requests.q',
  };
}
