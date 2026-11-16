import { createRequire } from 'node:module';
import httpContract from '../contracts/http.json' with { type: 'json' };
import { fail } from './domain.js';
const require = createRequire(import.meta.url);
const Ajv = require('ajv').default;
const addFormats = require('ajv-formats');
const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
const http: any = httpContract;
const validators = new Map<string, any>();
export function body(name: string, value: unknown, partial = false): Record<string, any> {
  const key = name + partial;
  if (!validators.has(key)) {
    const schema = structuredClone(http.components.schemas[name]);
    if (partial) { delete schema.required; schema.minProperties = 1; }
    // Business identifiers/names must not be blank even where the OpenAPI omits minLength.
    for (const field of ['id','name','areaId','code','tableId']) {
      if (schema.properties?.[field]) Object.assign(schema.properties[field], { minLength: 1, maxLength: 200, pattern: '\\S' });
    }
    validators.set(key, ajv.compile({ ...schema, components: http.components }));
  }
  const validate = validators.get(key);
  if (!validate(value)) fail(400, 'VALIDATION_ERROR', 'Invalid request body', validate.errors.map((e: any) => ({ path: e.instancePath, rule: e.keyword })));
  return value as Record<string, any>;
}
export function query(input: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(input).some((key) => !allowed.includes(key)) || Object.values(input).some((v) => typeof v !== 'string')) {
    fail(400, 'INVALID_QUERY', 'Unsupported or repeated query parameter');
  }
}
export function positive(value: unknown, fallback?: number, max = 100): number {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'string' || !/^\d+$/.test(value) || +value < 1 || +value > max) fail(400, 'INVALID_NUMBER', `Expected an integer from 1 to ${max}`);
  return +value;
}
