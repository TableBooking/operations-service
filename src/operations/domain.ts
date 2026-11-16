import { HttpException, Injectable } from '@nestjs/common';
import { DateTime } from 'luxon';
import type { EntityManager } from 'typeorm';

export const states = ['REQUESTED','CONFIRMED','REJECTED','CANCELLED','CHECKED_IN','SEATED','COMPLETED','NO_SHOW'] as const;
export function fail(status: number, code: string, message: string, details: unknown = null): never {
  throw new HttpException({ code, message, details }, status);
}
@Injectable()
export class Clock { now(): Date { return new Date(); } }
export type Row = Record<string, any>;
export const uuidPattern = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
export function uuid(value: string): string {
  if (!uuidPattern.test(value)) fail(400, 'INVALID_ID', 'Expected a UUID');
  return value;
}
export function date(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      !DateTime.fromISO(value).isValid) fail(400, 'INVALID_DATE', 'Expected a valid YYYY-MM-DD date');
  return value;
}
export function slotParts(value: string): { date: string; code: string } {
  const match = /^(\d{4}-\d{2}-\d{2})-(lunch|dinner)$/.exec(value);
  if (!match) fail(400, 'INVALID_SLOT', 'Expected YYYY-MM-DD-lunch or YYYY-MM-DD-dinner');
  return { date: date(match[1]), code: match[2] };
}
export async function restaurant(tx: EntityManager): Promise<Row> {
  const [row] = await tx.query('SELECT * FROM operations.restaurants ORDER BY id LIMIT 1');
  if (!row) fail(503, 'RESTAURANT_NOT_CONFIGURED', 'Run the Operations seed first');
  return row;
}
export async function calendar(tx: EntityManager, slotId: string): Promise<{ rest: Row; config: Row; start: DateTime; end: DateTime }> {
  const parts = slotParts(slotId);
  const rest = await restaurant(tx);
  const [config] = await tx.query('SELECT * FROM operations.service_slot_configs WHERE code=$1 AND restaurant_id=$2', [parts.code, rest.id]);
  if (!config) fail(409, 'SLOT_NOT_FOUND', 'Service slot is not configured');
  const start = DateTime.fromISO(`${parts.date}T${config.starts_at_local}`, { zone: rest.timezone });
  const end = DateTime.fromISO(`${parts.date}T${config.ends_at_local}`, { zone: rest.timezone });
  if (!start.isValid || !end.isValid || end <= start) fail(409, 'INVALID_SLOT_CONFIG', 'Invalid local slot configuration');
  return { rest, config, start, end };
}
export async function lockCatalog(tx: EntityManager, exclusive = false): Promise<void> {
  await tx.query(`SELECT pg_advisory_xact_lock${exclusive ? '' : '_shared'}(hashtextextended('operations:catalog',0))`);
}
export async function lockBooking(tx: EntityManager, bookingId: string): Promise<void> {
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`operations:booking:${bookingId}`]);
}
export function reservationDto(row: Row): Row {
  return { bookingId: row.id, customerId: row.customer_id, slotId: row.slot_id,
    partySize: row.party_size, state: row.state, version: row.aggregate_version,
    ...(row.table_id ? { tableId: row.table_id } : {}),
    createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString() };
}
export function tableDto(row: Row): Row {
  return { id: row.id, areaId: row.area_id, ...(row.name !== null ? { name: row.name } : {}), capacity: row.capacity, active: row.active };
}
export const areaDto = (row: Row) => ({ id: row.id, name: row.name, active: row.active });
export const configDto = (row: Row) => ({ code: row.code, startsAtLocal: row.starts_at_local.slice(0,5), endsAtLocal: row.ends_at_local.slice(0,5), active: row.active });
