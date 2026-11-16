import { createRequire } from 'node:module';
import requested from '../contracts/booking.requested.v1.schema.json' with { type: 'json' };
import cancelled from '../contracts/booking.cancel-requested.v1.schema.json' with { type: 'json' };
import changed from '../contracts/booking.state-changed.v1.schema.json' with { type: 'json' };
import rejected from '../contracts/booking.cancellation-rejected.v1.schema.json' with { type: 'json' };
import { fail, type Row } from '../operations/domain.js';
const require = createRequire(import.meta.url);
const Ajv2020 = require('ajv/dist/2020').default;
const ajv = new Ajv2020({ strict: false, allErrors: true });
require('ajv-formats')(ajv);
const validators = new Map([requested,cancelled,changed,rejected].map(schema => [schema.title, ajv.compile(schema)]));
export interface Event {
  eventId: string; eventType: string; schemaVersion: 1; aggregateId: string;
  aggregateVersion?: number; occurredAt: string; producer: string;
  correlationId: string; data: Row;
}
export function validateEvent(value: unknown): asserts value is Event {
  const type = value && typeof value === 'object' && 'eventType' in value ? String(value.eventType) : '';
  const validate = validators.get(type);
  if (!validate || !validate(value)) fail(400, 'INVALID_EVENT', 'Message does not match the agreed event JSON Schema');
}
