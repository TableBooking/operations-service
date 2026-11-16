import dataSource from './data-source.js';
import { operationsSeedSql } from './seed.js';

const command = process.argv[2];
if (!['check', 'migrate', 'seed'].includes(command)) {
  throw new Error('Use database/cli.js check|migrate|seed (or npm run db:check/db:migrate/db:seed)');
}

try {
  await dataSource.initialize();
  if (command === 'migrate') {
    // A project owner provisions the schema once. The dedicated service login
    // needs ownership of this schema, not CREATE privileges on the database.
    // TypeORM needs it before creating the migration history table.
    const [schema] = await dataSource.query("SELECT nspowner = (SELECT oid FROM pg_roles WHERE rolname = current_user) AS owned FROM pg_namespace WHERE nspname = 'operations'");
    if (!schema?.owned) throw new Error('Provision the operations schema for this login first; see README');
    const applied = await dataSource.runMigrations({ transaction: 'all' });
    console.log(`Operations migrations applied: ${applied.length}`);
  } else if (command === 'seed') {
    if (await dataSource.showMigrations()) throw new Error('Run db:migrate before db:seed');
    await dataSource.transaction(async (manager) => {
      await manager.query('SET LOCAL search_path TO operations, pg_catalog');
      await manager.query(operationsSeedSql);
    });
    console.log('Operations demo seed applied (existing rows preserved)');
  } else {
    const runner = dataSource.createQueryRunner();
    try {
      const connection = await runner.connect();
      const stream = connection.connection.stream;
      const [result] = await runner.query(
        "SELECT to_regclass('operations.reservations') IS NOT NULL AS migrated, (SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()) AS backendTls",
      );
      // pg_stat_ssl describes the pooler's backend session, not this client's
      // TLS socket. Report the verified application transport separately.
      console.log(JSON.stringify({ database: 'connected', schema: 'operations',
        clientTls: stream.encrypted === true, certificateVerified: stream.authorized === true, ...result }));
      if (!result.migrated) process.exitCode = 1;
    } finally { await runner.release(); }
  }
} catch (error) {
  // Avoid printing the connection URL or raw SQL driver errors with secrets/PII.
  const code = typeof error === 'object' && error && 'code' in error ? String(error.code) : 'CONFIG_OR_DATABASE_ERROR';
  const hints: Record<string, string> = {
    '28P01': 'Database authentication failed. Check the database password in .env and URL-encode reserved characters.',
    SELF_SIGNED_CERT_IN_CHAIN: 'Configure DB_SSL_CA_PATH with the Supabase CA certificate; keep TLS verification enabled.',
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'Check the CA certificate configured in DB_SSL_CA_PATH.',
    ENOTFOUND: 'Database hostname could not be resolved. Check the connection host and network.',
    ETIMEDOUT: 'Database connection timed out. Check network access and Supabase project status.',
  };
  console.error(`Database command failed (${code}). ${hints[code] ?? 'Check network, credentials, TLS CA and schema ownership. Migration requires a fresh operations schema.'}`);
  process.exitCode = 1;
} finally {
  if (dataSource.isInitialized) await dataSource.destroy();
}
