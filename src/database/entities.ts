import { EntitySchema } from 'typeorm';

// Migrations own DDL, foreign keys, CHECKs and partial indexes. Synchronization
// stays disabled. Property names map explicitly to the V2 SQL column names.
export const Restaurant = new EntitySchema({
  name: 'Restaurant', tableName: 'restaurants',
  columns: {
    id: { type: 'text', primary: true }, name: { type: 'text' },
    address: { type: 'text', default: '' }, phone: { type: 'text', nullable: true },
    timezone: { type: 'text', default: 'Asia/Ho_Chi_Minh' },
    cancelBeforeMinutes: { name: 'cancel_before_minutes', type: 'int', default: 120 },
    checkinEarlyMinutes: { name: 'checkin_early_minutes', type: 'int', default: 30 },
    noShowAfterMinutes: { name: 'no_show_after_minutes', type: 'int', default: 15 },
  },
});
export const DiningArea = new EntitySchema({
  name: 'DiningArea', tableName: 'dining_areas',
  columns: {
    id: { type: 'text', primary: true },
    restaurantId: { name: 'restaurant_id', type: 'text' },
    name: { type: 'text' }, active: { type: 'boolean', default: true },
  },
});
export const DiningTable = new EntitySchema({
  name: 'DiningTable', tableName: 'dining_tables',
  columns: {
    id: { type: 'text', primary: true }, areaId: { name: 'area_id', type: 'text' },
    name: { type: 'text', nullable: true }, capacity: { type: 'int' },
    active: { type: 'boolean', default: true },
  },
});
export const ServiceSlotConfig = new EntitySchema({
  name: 'ServiceSlotConfig', tableName: 'service_slot_configs',
  columns: {
    code: { type: 'text', primary: true },
    restaurantId: { name: 'restaurant_id', type: 'text' },
    startsAtLocal: { name: 'starts_at_local', type: 'time' },
    endsAtLocal: { name: 'ends_at_local', type: 'time' },
    active: { type: 'boolean', default: true },
  },
});
export const Reservation = new EntitySchema({
  name: 'Reservation', tableName: 'reservations',
  columns: {
    id: { type: 'uuid', primary: true }, customerId: { name: 'customer_id', type: 'uuid' },
    contactEmail: { name: 'contact_email', type: 'text' },
    contactPhone: { name: 'contact_phone', type: 'text', nullable: true },
    slotId: { name: 'slot_id', type: 'text' }, partySize: { name: 'party_size', type: 'int' },
    note: { type: 'text', default: '' }, state: { type: 'text' },
    aggregateVersion: { name: 'aggregate_version', type: 'int' },
    tableId: { name: 'table_id', type: 'text', nullable: true },
    createdAt: { name: 'created_at', type: 'timestamptz', createDate: true },
    updatedAt: { name: 'updated_at', type: 'timestamptz', updateDate: true },
  },
});
export const TableAllocation = new EntitySchema({
  name: 'TableAllocation', tableName: 'table_allocations',
  columns: {
    id: { type: 'uuid', primary: true }, bookingId: { name: 'booking_id', type: 'uuid', unique: true },
    tableId: { name: 'table_id', type: 'text' }, slotId: { name: 'slot_id', type: 'text' },
    allocatedAt: { name: 'allocated_at', type: 'timestamptz', createDate: true },
    releasedAt: { name: 'released_at', type: 'timestamptz', nullable: true },
  },
  indices: [{ name: 'ux_active_table_slot', columns: ['tableId', 'slotId'], unique: true, where: 'released_at IS NULL' }],
});
export const PendingCancellation = new EntitySchema({
  name: 'PendingCancellation', tableName: 'pending_cancellations',
  columns: {
    commandId: { name: 'command_id', type: 'uuid', primary: true },
    bookingId: { name: 'booking_id', type: 'uuid' }, customerId: { name: 'customer_id', type: 'uuid' },
    receivedAt: { name: 'received_at', type: 'timestamptz', createDate: true },
    eventPayload: { name: 'event_payload', type: 'jsonb', nullable: true },
  },
});
export const ProcessedCommand = new EntitySchema({
  name: 'ProcessedCommand', tableName: 'processed_commands',
  columns: {
    commandId: { name: 'command_id', type: 'uuid', primary: true },
    bookingId: { name: 'booking_id', type: 'uuid' }, result: { type: 'jsonb' },
    createdAt: { name: 'created_at', type: 'timestamptz', createDate: true },
  },
});
export const InboxEvent = new EntitySchema({
  name: 'InboxEvent', tableName: 'inbox_events',
  columns: {
    eventId: { name: 'event_id', type: 'uuid', primary: true },
    aggregateId: { name: 'aggregate_id', type: 'uuid' },
    processedAt: { name: 'processed_at', type: 'timestamptz', createDate: true },
  },
});
export const OutboxEvent = new EntitySchema({
  name: 'OutboxEvent', tableName: 'outbox_events',
  columns: {
    eventId: { name: 'event_id', type: 'uuid', primary: true },
    aggregateId: { name: 'aggregate_id', type: 'uuid' },
    routingKey: { name: 'routing_key', type: 'text' }, payload: { type: 'jsonb' },
    attempts: { type: 'int', default: 0 },
    createdAt: { name: 'created_at', type: 'timestamptz', createDate: true },
    publishedAt: { name: 'published_at', type: 'timestamptz', nullable: true },
  },
});

export const operationEntities = [Restaurant, DiningArea, DiningTable,
  ServiceSlotConfig, Reservation, TableAllocation, PendingCancellation,
  ProcessedCommand, InboxEvent, OutboxEvent];
