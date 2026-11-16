import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Public } from '../auth/auth.js';
import { MessagingService } from '../messaging/messaging.service.js';

// Internal endpoints; the gateway allowlist intentionally does not forward them.
@Public()
@Controller('operations/health')
export class HealthController {
  constructor(@Inject(DataSource) private readonly database: DataSource,
    @Inject(MessagingService) private readonly messaging: MessagingService) {}

  @Get('live')
  live() { return { status: 'ok', service: 'operation-service', stage: 'operations-v2' }; }

  @Get('ready')
  async ready() {
    try {
      await this.database.query('SELECT 1');
      const [result] = await this.database.query("SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='operations' AND table_name='pending_cancellations' AND column_name='event_payload') AS ready");
      if (!result.ready) throw new Error('Migration pending');
    } catch { throw new ServiceUnavailableException('Database unavailable or operations migration pending'); }
    if (!this.messaging.connected) throw new ServiceUnavailableException('RabbitMQ is reconnecting; committed outbox records are retained');
    return { status: 'ok', database: 'up', messaging: 'up', schema: 'operations', stage: 'operations-v2' };
  }
}
