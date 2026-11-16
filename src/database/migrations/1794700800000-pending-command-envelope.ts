import type { MigrationInterface, QueryRunner } from 'typeorm';
export class PendingCommandEnvelope1794700800000 implements MigrationInterface {
  name = 'PendingCommandEnvelope1794700800000';
  async up(queryRunner: QueryRunner) {
    await queryRunner.query('ALTER TABLE operations.pending_cancellations ADD COLUMN IF NOT EXISTS event_payload JSONB');
    await queryRunner.query('CREATE INDEX IF NOT EXISTS ix_ops_pending_received ON operations.pending_cancellations(received_at)');
  }
  async down(): Promise<void> { throw new Error('Use a reviewed forward migration to preserve pending commands'); }
}
