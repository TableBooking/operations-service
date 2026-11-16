import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';
import { Clock, calendar, date, fail, lockBooking, lockCatalog, reservationDto, slotParts, states, type Row } from './domain.js';
import { validateEvent, type Event } from '../messaging/events.js';

@Injectable()
export class ReservationService {
  constructor(@Inject(DataSource) private readonly db: DataSource, @Inject(Clock) private readonly clock: Clock) {}
  private async transaction<T>(id: string, work: (tx: EntityManager) => Promise<T>): Promise<T> {
    return this.db.transaction(async tx => { await lockCatalog(tx); await lockBooking(tx,id); return work(tx); });
  }
  async list(filters: Row, page: number, limit: number) {
    const values: any[] = []; const clauses: string[] = [];
    if (filters.date) { values.push(`${date(filters.date)}-%`); clauses.push(`slot_id LIKE $${values.length}`); }
    if (filters.slotId) { slotParts(filters.slotId); values.push(filters.slotId); clauses.push(`slot_id=$${values.length}`); }
    if (filters.state) {
      if (!states.includes(filters.state)) fail(400,'INVALID_STATE','Unknown reservation state');
      values.push(filters.state); clauses.push(`state=$${values.length}`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    // One SQL snapshot keeps total and rows coherent during concurrent changes.
    const [result] = await this.db.query(`WITH filtered AS (SELECT * FROM operations.reservations ${where}),
      paged AS (SELECT * FROM filtered ORDER BY slot_id,created_at,id LIMIT $${values.length+1} OFFSET $${values.length+2})
      SELECT (SELECT count(*)::int FROM filtered) AS total, coalesce((SELECT json_agg(paged) FROM paged),'[]'::json) AS rows`,[...values,limit,(page-1)*limit]);
    return {data:result.rows.map(reservationDto),meta:{page,limit,total:result.total,totalPages:Math.ceil(result.total/limit)}};
  }
  async detail(id: string) {
    const [row] = await this.db.query('SELECT * FROM operations.reservations WHERE id=$1',[id]);
    if (!row) fail(404,'RESERVATION_NOT_FOUND','Reservation not found');
    return reservationDto(row);
  }
  async stats(day: string) {
    date(day);
    const [row] = await this.db.query(`SELECT count(*)::int AS total,
      count(*) FILTER(WHERE state='REQUESTED')::int AS requested,
      count(*) FILTER(WHERE state='CONFIRMED')::int AS confirmed,
      count(*) FILTER(WHERE state='CHECKED_IN')::int AS "checkedIn",
      count(*) FILTER(WHERE state='COMPLETED')::int AS completed,
      count(*) FILTER(WHERE state='CANCELLED')::int AS cancelled,
      count(*) FILTER(WHERE state='NO_SHOW')::int AS "noShow"
      FROM operations.reservations WHERE slot_id LIKE $1`,[`${day}-%`]);
    return {date:day,...row};
  }
  async transition(id: string, action: string, input: Row, actor: string, correlationId: string) {
    const next: Record<string,string> = {confirm:'CONFIRMED',reject:'REJECTED','check-in':'CHECKED_IN',seat:'SEATED',complete:'COMPLETED','no-show':'NO_SHOW',cancel:'CANCELLED'};
    if (!next[action]) fail(400,'INVALID_ACTION','Unknown reservation action');
    if (['reject','cancel'].includes(action) && (typeof input.reason !== 'string' || !input.reason.trim())) fail(400,'REASON_REQUIRED','A nonempty reason is required');
    if (action === 'confirm' && !input.tableId) fail(400,'TABLE_REQUIRED','Confirmation requires tableId');
    return this.transaction(id,async tx => {
      const [row] = await tx.query('SELECT * FROM operations.reservations WHERE id=$1 FOR UPDATE',[id]);
      if (!row) fail(404,'RESERVATION_NOT_FOUND','Reservation not found');
      if (row.aggregate_version !== input.expectedVersion) fail(409,'RESERVATION_VERSION_CONFLICT','Reservation has changed',{expectedVersion:input.expectedVersion,actualVersion:row.aggregate_version});
      const from: Record<string,string[]> = {CONFIRMED:['REQUESTED'],REJECTED:['REQUESTED'],CHECKED_IN:['CONFIRMED'],SEATED:['CHECKED_IN'],COMPLETED:['SEATED'],NO_SHOW:['CONFIRMED'],CANCELLED:['REQUESTED','CONFIRMED']};
      const target = next[action];
      if (!from[target].includes(row.state)) fail(409,'INVALID_TRANSITION','Transition is not allowed from the current state');
      const c = await calendar(tx,row.slot_id); const now = this.clock.now().getTime();
      if (action === 'confirm') {
        if (!c.config.active || now >= c.start.toMillis()) fail(409,'SLOT_CLOSED','Slot is inactive or has started');
        const [table] = await tx.query(`SELECT t.*,a.active AS area_active FROM operations.dining_tables t
          JOIN operations.dining_areas a ON a.id=t.area_id WHERE t.id=$1 AND a.restaurant_id=$2 FOR SHARE OF t,a`,[input.tableId,c.rest.id]);
        if (!table || !table.active || !table.area_active || table.capacity < row.party_size) fail(409,'TABLE_UNAVAILABLE','Table is inactive, missing or too small');
        await tx.query('INSERT INTO operations.table_allocations(id,booking_id,table_id,slot_id) VALUES($1,$2,$3,$4)',[randomUUID(),id,input.tableId,row.slot_id]);
        row.table_id = input.tableId;
      }
      if (action === 'cancel' && !this.canCancel(row,c)) fail(409,'CANCELLATION_NOT_ALLOWED','Cancellation deadline has passed');
      if (action === 'check-in' && (now < c.start.minus({minutes:c.rest.checkin_early_minutes}).toMillis() || now > c.start.plus({minutes:c.rest.no_show_after_minutes}).toMillis())) fail(409,'CHECKIN_WINDOW_CLOSED','Outside the check-in time window');
      if (action === 'no-show' && now <= c.start.plus({minutes:c.rest.no_show_after_minutes}).toMillis()) fail(409,'NO_SHOW_TOO_EARLY','No-show grace period has not elapsed');
      if (action === 'seat') {
        const [allocation] = await tx.query('SELECT 1 FROM operations.table_allocations WHERE booking_id=$1 AND table_id=$2 AND released_at IS NULL',[id,row.table_id]);
        if (!allocation || input.tableId && input.tableId !== row.table_id) fail(409,'TABLE_MISMATCH','Seat requires the allocated table');
      }
      await this.change(tx,row,target,actor,input.reason ?? null,correlationId);
      return {bookingId:row.id,state:row.state,version:row.aggregate_version,...(row.table_id ? {tableId:row.table_id}: {})};
    });
  }
  private canCancel(row: Row, c: Awaited<ReturnType<typeof calendar>>): boolean {
    return ['REQUESTED','CONFIRMED'].includes(row.state) && this.clock.now().getTime() < c.start.minus({minutes:c.rest.cancel_before_minutes}).toMillis();
  }
  private async outbox(tx: EntityManager, event: Event) {
    validateEvent(event);
    await tx.query('INSERT INTO operations.outbox_events(event_id,aggregate_id,routing_key,payload) VALUES($1,$2,$3,$4)',[event.eventId,event.aggregateId,event.eventType,event]);
  }
  private event(type: string, id: string, correlationId: string, data: Row, version?: number): Event {
    return {eventId:randomUUID(),eventType:type,schemaVersion:1,aggregateId:id,...(version ? {aggregateVersion:version}:{}),
      occurredAt:this.clock.now().toISOString(),producer:'operations-service',correlationId,data};
  }
  private async emitState(tx: EntityManager, row: Row, previous: string|null, actor: string, reason: string|null, correlationId: string, commandId?: string) {
    const event = this.event('booking.state-changed.v1',row.id,correlationId,{previousState:previous,state:row.state,customerId:row.customer_id,
      email:row.contact_email,slotId:row.slot_id,partySize:row.party_size,tableId:row.table_id,actorId:actor,reason,...(commandId ? {commandId}:{})},row.aggregate_version);
    await this.outbox(tx,event); return event;
  }
  private async change(tx: EntityManager, row: Row, state: string, actor: string, reason: string|null, correlationId: string, commandId?: string) {
    const previous = row.state; row.state=state; row.aggregate_version++;
    await tx.query('UPDATE operations.reservations SET state=$2,aggregate_version=$3,table_id=$4,updated_at=$5 WHERE id=$1',[row.id,state,row.aggregate_version,row.table_id,this.clock.now()]);
    if (['CANCELLED','NO_SHOW'].includes(state)) await tx.query('UPDATE operations.table_allocations SET released_at=$2 WHERE booking_id=$1 AND released_at IS NULL',[row.id,this.clock.now()]);
    return this.emitState(tx,row,previous,actor,reason,correlationId,commandId);
  }
  async receive(value: unknown) {
    validateEvent(value); const event = value;
    if (!['booking.requested.v1','booking.cancel-requested.v1'].includes(event.eventType)) fail(400,'INVALID_EVENT_TYPE','Operations consumes Booking commands only');
    return this.transaction(event.aggregateId,async tx => {
      const inbox = await tx.query('INSERT INTO operations.inbox_events(event_id,aggregate_id) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING event_id',[event.eventId,event.aggregateId]);
      if (!inbox.length) return;
      if (event.eventType === 'booking.cancel-requested.v1') {
        const [processed] = await tx.query('SELECT * FROM operations.processed_commands WHERE command_id=$1',[event.data.commandId]);
        if (processed) {
          if (processed.booking_id !== event.aggregateId || processed.result.customerId !== event.data.customerId) fail(400,'COMMAND_COLLISION','Command ID already belongs to another request');
          return;
        }
        const [row] = await tx.query('SELECT * FROM operations.reservations WHERE id=$1 FOR UPDATE',[event.aggregateId]);
        if (row) await this.cancel(tx,row,event);
        else {
          const [pending] = await tx.query('SELECT * FROM operations.pending_cancellations WHERE command_id=$1',[event.data.commandId]);
          if (pending && (pending.booking_id !== event.aggregateId || pending.customer_id !== event.data.customerId)) fail(400,'COMMAND_COLLISION','Command ID already belongs to another request');
          await tx.query('INSERT INTO operations.pending_cancellations(command_id,booking_id,customer_id,event_payload) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[event.data.commandId,event.aggregateId,event.data.customerId,event]);
        }
      } else {
        const [existing] = await tx.query('SELECT * FROM operations.reservations WHERE id=$1',[event.aggregateId]);
        if (existing) {
          if (existing.customer_id !== event.data.customerId || existing.slot_id !== event.data.slotId || existing.party_size !== event.data.partySize) fail(400,'BOOKING_COLLISION','Booking ID already exists with different data');
          return;
        }
        const c = await calendar(tx,event.data.slotId);
        if (!c.config.active || c.start.toMillis() <= this.clock.now().getTime()) fail(409,'SLOT_CLOSED','Requested slot is not bookable');
        const [row] = await tx.query(`INSERT INTO operations.reservations(id,customer_id,contact_email,contact_phone,slot_id,party_size,note,state,aggregate_version)
          VALUES($1,$2,$3,$4,$5,$6,$7,'REQUESTED',1) RETURNING *`,[event.aggregateId,event.data.customerId,event.data.email,event.data.contactPhone ?? null,event.data.slotId,event.data.partySize,event.data.note ?? '']);
        await this.emitState(tx,row,null,'booking-service',null,event.correlationId);
        const pending = await tx.query('SELECT * FROM operations.pending_cancellations WHERE booking_id=$1 ORDER BY received_at,command_id',[row.id]);
        for (const p of pending) {
          const command = p.event_payload ?? this.event('booking.cancel-requested.v1',row.id,event.correlationId,{commandId:p.command_id,customerId:p.customer_id});
          await this.cancel(tx,row,command);
          await tx.query('DELETE FROM operations.pending_cancellations WHERE command_id=$1',[p.command_id]);
        }
      }
    });
  }
  private async cancel(tx: EntityManager, row: Row, event: Event) {
    let result: Event;
    const c = await calendar(tx,row.slot_id);
    if (event.data.customerId !== row.customer_id || !this.canCancel(row,c)) {
      result = this.event('booking.cancellation-rejected.v1',row.id,event.correlationId,{commandId:event.data.commandId,customerId:event.data.customerId,
        reason:event.data.customerId !== row.customer_id ? 'OWNER_MISMATCH' : 'STATE_OR_DEADLINE_NOT_ALLOWED'},row.aggregate_version);
      await this.outbox(tx,result);
    } else result = await this.change(tx,row,'CANCELLED','booking-service',event.data.reason ?? null,event.correlationId,event.data.commandId);
    await tx.query('INSERT INTO operations.processed_commands(command_id,booking_id,result) VALUES($1,$2,$3)',[event.data.commandId,row.id,{customerId:event.data.customerId,eventId:result.eventId,outcome:result.eventType}]);
  }
  async expirePending() {
    const expired = await this.db.query("SELECT booking_id,command_id FROM operations.pending_cancellations WHERE received_at < now()-interval '24 hours' ORDER BY received_at LIMIT 20");
    for (const p of expired) await this.transaction(p.booking_id,async tx => {
      const [row] = await tx.query("SELECT * FROM operations.pending_cancellations WHERE command_id=$1 AND received_at < now()-interval '24 hours' FOR UPDATE",[p.command_id]);
      if (!row) return;
      const event = this.event('booking.cancellation-rejected.v1',row.booking_id,row.event_payload?.correlationId ?? randomUUID(),{commandId:row.command_id,customerId:row.customer_id,reason:'BOOKING_NOT_RECEIVED'});
      await this.outbox(tx,event);
      await tx.query('INSERT INTO operations.processed_commands(command_id,booking_id,result) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[row.command_id,row.booking_id,{customerId:row.customer_id,eventId:event.eventId,outcome:event.eventType}]);
      await tx.query('DELETE FROM operations.pending_cancellations WHERE command_id=$1',[row.command_id]);
    });
  }
}
