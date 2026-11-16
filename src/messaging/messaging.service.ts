import { HttpException, Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { connect, type Channel, type ChannelModel, type ConfirmChannel, type ConsumeMessage } from 'amqplib';
import { randomUUID } from 'node:crypto';
import { environment } from '../config/runtime.js';
import { ReservationService } from '../operations/reservation.service.js';
import { fail } from '../operations/domain.js';

export const lifecycleBindings: Record<string,string[]> = {
  'booking.lifecycle.q':['booking.state-changed.v1','booking.cancellation-rejected.v1'],
  'tracking.lifecycle.q':['booking.state-changed.v1'],
  'notification.lifecycle.q':['booking.state-changed.v1'],
};
export async function publish(channel: ConfirmChannel, exchange: string, routingKey: string, payload: Buffer, headers: Record<string,any> = {}): Promise<void> {
  const messageId = randomUUID();
  return new Promise((resolve,reject) => {
    let returned = false;
    const onReturn = (msg: ConsumeMessage) => { if (msg.properties.messageId === messageId) returned = true; };
    const clean = () => { clearTimeout(timer); channel.off('return',onReturn); channel.off('close',onClose); };
    const onClose = () => { clean(); reject(new Error('Publisher channel closed')); };
    const timer = setTimeout(() => { clean(); reject(new Error('Publisher confirm timeout')); },5000);
    channel.on('return',onReturn); channel.on('close',onClose);
    try {
      channel.publish(exchange,routingKey,payload,{persistent:true,mandatory:true,messageId,contentType:'application/json',headers},(error) => {
        clean(); if (error || returned) reject(new Error('Publication was not confirmed or was unroutable')); else resolve();
      });
    } catch { clean(); reject(new Error('Publisher unavailable')); }
  });
}

@Injectable()
export class MessagingService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(MessagingService.name);
  private connection?: ChannelModel;
  private publisher?: ConfirmChannel;
  private consumer?: ConfirmChannel;
  private consumerTag?: string;
  private timer?: ReturnType<typeof setInterval>;
  private work?: Promise<void>;
  private closing = false;
  private reconnectAt = 0;
  private expiryAt = 0;
  private inflight = new Set<Promise<void>>();
  connected = false;
  constructor(@Inject(DataSource) private readonly db: DataSource,
    @Inject(ReservationService) private readonly reservations: ReservationService) {}
  onApplicationBootstrap() {
    this.timer = setInterval(() => { if (!this.work) this.work = this.tick().finally(() => { this.work=undefined; }); },1000);
  }
  private async topology(channel: Channel) {
    const ex = environment.RABBITMQ_EXCHANGE;
    await channel.assertExchange(ex,'topic',{durable:true});
    await channel.assertExchange('restaurant.dlx','topic',{durable:true});
    await channel.assertExchange('restaurant.retry','topic',{durable:true});
    for (const [queue,keys] of Object.entries({[environment.RABBITMQ_QUEUE]:['booking.requested.v1','booking.cancel-requested.v1'],...lifecycleBindings})) {
      await channel.assertQueue(`${queue}.dlq`,{durable:true});
      await channel.bindQueue(`${queue}.dlq`,'restaurant.dlx',`${queue}.dlq`);
      await channel.assertQueue(queue,{durable:true,arguments:{'x-dead-letter-exchange':'restaurant.dlx','x-dead-letter-routing-key':`${queue}.dlq`}});
      for (const key of keys) await channel.bindQueue(queue,ex,key);
    }
    const retry = `${environment.RABBITMQ_QUEUE}.retry`;
    await channel.assertQueue(retry,{durable:true,arguments:{'x-message-ttl':5000,'x-dead-letter-exchange':ex}});
    for (const key of ['booking.requested.v1','booking.cancel-requested.v1']) await channel.bindQueue(retry,'restaurant.retry',key);
  }
  private async open() {
    await this.connection?.close().catch(() => {});
    const connection = await connect(environment.RABBITMQ_URL,{timeout:5000});
    this.connection=connection;
    connection.on('error',() => {});
    connection.on('close',() => { this.connected=false; this.publisher=undefined; this.consumer=undefined; this.connection=undefined; });
    const publisher = await connection.createConfirmChannel();
    publisher.on('error',() => {});
    publisher.on('close',() => { this.connected=false; });
    await this.topology(publisher);
    const consumer = await connection.createConfirmChannel();
    consumer.on('error',() => {});
    consumer.on('close',() => { this.connected=false; });
    await consumer.prefetch(5);
    this.publisher=publisher; this.consumer=consumer;
    const result = await consumer.consume(environment.RABBITMQ_QUEUE,msg => {
      if (!msg) { this.connected=false; return; }
      const job = this.handle(consumer,msg).finally(() => this.inflight.delete(job));
      this.inflight.add(job);
    },{noAck:false});
    this.consumerTag=result.consumerTag; this.connected=true;
    this.logger.log('Operations consumer and durable lifecycle queues ready');
  }
  private async handle(channel: ConfirmChannel, msg: ConsumeMessage) {
    try {
      let event: any;
      try { event=JSON.parse(msg.content.toString('utf8')); } catch { fail(400,'INVALID_EVENT','Invalid JSON message'); }
      if (event?.eventType !== msg.fields.routingKey) fail(400,'INVALID_EVENT','Routing key must match eventType');
      await this.reservations.receive(event);
      channel.ack(msg);
      this.logger.log(JSON.stringify({code:'EVENT_PROCESSED',eventId:event.eventId,bookingId:event.aggregateId,correlationId:event.correlationId}));
    } catch (error) {
      const current = Number(msg.properties.headers?.['x-operations-retries'] ?? 0);
      const tries = Number.isFinite(current) && current >= 0 ? current : 3;
      const poison = error instanceof HttpException && error.getStatus() < 500;
      try {
        await publish(channel,poison || tries >= 3 ? 'restaurant.dlx' : 'restaurant.retry',
          poison || tries >= 3 ? `${environment.RABBITMQ_QUEUE}.dlq` : msg.fields.routingKey,msg.content,
          {...msg.properties.headers,'x-operations-retries':tries+1});
        channel.ack(msg);
      } catch {
        // Closing the connection requeues unacknowledged deliveries and backs
        // off reconnect, instead of a tight nack/requeue loop.
        await this.connection?.close().catch(() => {});
      }
      this.logger.warn(JSON.stringify({code:poison ? 'MESSAGE_REJECTED':'MESSAGE_RETRY',retry:tries}));
    }
  }
  async relayOnce(): Promise<boolean> {
    const publisher = this.publisher;
    if (!this.connected || !publisher) return false;
    return this.db.transaction(async tx => {
      const [row] = await tx.query(`SELECT * FROM operations.outbox_events WHERE published_at IS NULL
        ORDER BY created_at,(payload->>'aggregateVersion')::int NULLS LAST,event_id FOR UPDATE SKIP LOCKED LIMIT 1`);
      if (!row) return false;
      let sent = false;
      try { await publish(publisher,environment.RABBITMQ_EXCHANGE,row.routing_key,Buffer.from(JSON.stringify(row.payload))); sent=true; }
      catch { this.logger.warn(JSON.stringify({code:'OUTBOX_RETRY',eventId:row.event_id})); }
      await tx.query('UPDATE operations.outbox_events SET attempts=attempts+1,published_at=CASE WHEN $2 THEN now() ELSE NULL END WHERE event_id=$1',[row.event_id,sent]);
      return sent;
    });
  }
  private async tick() {
    if (this.closing) return;
    try {
      if (!this.connected && Date.now() >= this.reconnectAt) {
        this.reconnectAt=Date.now()+5000;
        try { await this.open(); } catch { await this.connection?.close().catch(() => {}); this.logger.warn('RabbitMQ unavailable; database outbox remains durable'); }
      }
      if (this.connected) for (let i=0;i<10;i++) { if (!await this.relayOnce()) break; }
      if (Date.now() >= this.expiryAt) { this.expiryAt=Date.now()+60000; await this.reservations.expirePending(); }
    } catch { this.logger.warn('Operations background cycle failed; retrying'); }
  }
  async onApplicationShutdown() {
    this.closing=true; if (this.timer) clearInterval(this.timer);
    if (this.consumer && this.consumerTag) await this.consumer.cancel(this.consumerTag).catch(() => {});
    await Promise.allSettled([...this.inflight,...(this.work ? [this.work]:[])]);
    await this.connection?.close().catch(() => {});
  }
}
