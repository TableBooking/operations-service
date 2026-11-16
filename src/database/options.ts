import { readFileSync } from 'node:fs';
import type { DataSourceOptions } from 'typeorm';
import type { Environment } from '../config/environment.js';
import { operationEntities } from './entities.js';
import { InitOperations1794268800000 } from './migrations/1794268800000-init-operations.js';
import { PendingCommandEnvelope1794700800000 } from './migrations/1794700800000-pending-command-envelope.js';

export function databaseOptions(env: Environment): DataSourceOptions {
  return {
    type: 'postgres',
    url: env.DATABASE_URL,
    schema: env.DB_SCHEMA,
    entities: operationEntities,
    migrations: [InitOperations1794268800000, PendingCommandEnvelope1794700800000],
    migrationsTableName: 'typeorm_migrations',
    migrationsTransactionMode: 'all',
    synchronize: false,
    migrationsRun: false,
    logging: false,
    ssl: env.DB_SSL ? {
      rejectUnauthorized: true,
      ...(env.DB_SSL_CA_PATH ? { ca: readFileSync(env.DB_SSL_CA_PATH, 'utf8') } : {}),
    } : false,
    extra: {
      max: env.DB_POOL_MAX,
      connectionTimeoutMillis: env.DB_CONNECT_TIMEOUT_MS,
      idleTimeoutMillis: 30000,
      statement_timeout: 10000,
      application_name: 'operation-service',
    },
  };
}
