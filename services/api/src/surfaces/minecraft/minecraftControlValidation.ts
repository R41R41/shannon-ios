import type { MinecraftControlPoll, MinecraftSkillDefinition } from '../../contracts/minecraftControlContract.js';
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
const SKILL = /^[a-z][a-z0-9-]{0,59}$/;
const forbidden = /(?:campaign|planner|agent|command|chat|constant|script|code|background|schedule)/;
export const controlId = (value: unknown): value is string => typeof value === 'string' && ID.test(value);
export const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
export const timestamp = (v: unknown): v is string => typeof v === 'string' && v.length <= 40 && Number.isFinite(Date.parse(v));
const boundedJSON = (v: unknown, length: number) => { try { return JSON.stringify(v).length <= length; } catch { return false; } };

/** Bounded JSON-schema subset; native skill validation remains authoritative at the actuator. */
export function skillSchema(value: unknown, depth = 0): value is Readonly<Record<string, unknown>> {
  if (!record(value) || depth > 6) return false;
  const allowed = ['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'description', 'minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems', 'anyOf', 'default'];
  if (Object.keys(value).some(key => !allowed.includes(key))) return false;
  if (value.description !== undefined && (typeof value.description !== 'string' || value.description.length > 2000)) return false;
  if (['minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems'].some(key => value[key] !== undefined && (typeof value[key] !== 'number' || !Number.isFinite(value[key])))) return false;
  if (value.anyOf !== undefined) return Array.isArray(value.anyOf) && value.anyOf.length > 0 && value.anyOf.length <= 4 && value.anyOf.every(item => skillSchema(item, depth + 1));
  if (!['object', 'array', 'string', 'integer', 'number', 'boolean', 'null'].includes(String(value.type))) return false;
  if (value.type === 'object') {
    if (!record(value.properties) || Object.keys(value.properties).length > 32 || value.additionalProperties !== false) return false;
    if (Object.entries(value.properties).some(([key, schema]) => !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key) || !skillSchema(schema, depth + 1))) return false;
    if (!Array.isArray(value.required) || value.required.some(key => typeof key !== 'string' || !Object.hasOwn(value.properties as object, key))) return false;
  }
  if (value.type === 'array' && !skillSchema(value.items, depth + 1)) return false;
  if (value.enum !== undefined && (!Array.isArray(value.enum) || value.enum.length > 128 || value.enum.some(item => !['string', 'number', 'boolean'].includes(typeof item)))) return false;
  return boundedJSON(value, 16_000);
}
export function validSkills(skills: unknown): skills is MinecraftSkillDefinition[] {
  return Array.isArray(skills) && skills.length <= 128 && new Set(skills.map(item => item?.name)).size === skills.length
    && skills.every(item => record(item) && typeof item.name === 'string' && SKILL.test(item.name) && !forbidden.test(item.name)
      && typeof item.description === 'string' && item.description.length <= 3000 && typeof item.readOnly === 'boolean'
      && skillSchema(item.inputSchema) && item.inputSchema.type === 'object') && boundedJSON(skills, 250_000);
}
export function validSkillInput(value: unknown, schema: Readonly<Record<string, unknown>>, depth = 0): boolean {
  if (depth > 6 || !boundedJSON(value, 32_000)) return false;
  if (Array.isArray(schema.anyOf)) return schema.anyOf.some(item => record(item) && validSkillInput(value, item, depth + 1));
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return false;
  if (schema.type === 'object') {
    if (!record(value) || !record(schema.properties) || !Array.isArray(schema.required)) return false;
    return schema.required.every(key => typeof key === 'string' && Object.hasOwn(value, key))
      && Object.entries(value).every(([key, item]) => Object.hasOwn(schema.properties as object, key) && validSkillInput(item, (schema.properties as Record<string, Record<string, unknown>>)[key]!, depth + 1));
  }
  if (schema.type === 'array') return Array.isArray(value) && value.length <= Math.min(256, Number(schema.maxItems ?? 256))
    && value.length >= Number(schema.minItems ?? 0) && value.every(item => validSkillInput(item, schema.items as Record<string, unknown>, depth + 1));
  if (schema.type === 'string') return typeof value === 'string' && value.length <= Number(schema.maxLength ?? 8000) && value.length >= Number(schema.minLength ?? 0);
  if (schema.type === 'boolean') return typeof value === 'boolean';
  if (schema.type === 'null') return value === null;
  return typeof value === 'number' && Number.isFinite(value) && (schema.type !== 'integer' || Number.isInteger(value))
    && value >= Number(schema.minimum ?? -30_000_000) && value <= Number(schema.maximum ?? 30_000_000);
}
export function validControlPoll(value: unknown, now: number): value is MinecraftControlPoll {
  if (!record(value) || value.schemaVersion !== 1 || !controlId(value.serverId) || !controlId(value.connectionId)) return false;
  const o = value.observation;
  if (!record(o) || o.schemaVersion !== 1 || !controlId(o.bodyId) || !Number.isSafeInteger(o.sequence) || Number(o.sequence) < 0
    || !timestamp(o.stateAt) || !timestamp(o.receivedAt) || Math.abs(now - Date.parse(o.stateAt)) > 30_000
    || typeof o.connected !== 'boolean' || !record(o.state) || !record(o.facts) || !boundedJSON(o, 100_000)) return false;
  if (Object.entries(o.facts).some(([key,v]) => key.length > 160 || v !== null && (!['boolean', 'number', 'string'].includes(typeof v) || typeof v === 'number' && !Number.isFinite(v) || typeof v === 'string' && v.length > 2000))) return false;
  if (!Array.isArray(value.candidates) || value.candidates.length > 64 || !boundedJSON(value.candidates, 100_000)) return false;
  if (value.candidates.some(c => !record(c) || !['action', 'observe', 'return', 'stop'].includes(String(c.kind)) || typeof c.label !== 'string'
    || c.label.length > 500 || !record(c.arguments) || !Array.isArray(c.preconditions) || c.preconditions.length > 32
    || c.preconditions.some(p => !record(p) || typeof p.key !== 'string' || !Object.hasOwn(o.facts as object, p.key) || p.value !== null && !['boolean','number','string'].includes(typeof p.value))
    || c.kind === 'action' && (typeof c.operation !== 'string' || c.operation.length > 80)
    || c.requiresImage !== undefined && typeof c.requiresImage !== 'boolean'
    || !timestamp(c.expiresAt) || !Number.isFinite(c.maxDurationMs) || Number(c.maxDurationMs) < 0 || Number(c.maxDurationMs) > 5000)) return false;
  if (value.skills !== undefined && !validSkills(value.skills)) return false;
  if (!Array.isArray(value.activeOperationIds) || value.activeOperationIds.length > 8 || value.activeOperationIds.some(id => !controlId(id))) return false;
  return Array.isArray(value.receipts) && value.receipts.length <= 16 && value.receipts.every(r => record(r) && controlId(r.id)
    && r.connectionId === value.connectionId && ['completed', 'failed', 'cancelled', 'unknown'].includes(String(r.outcome))
    && typeof r.inputsReleased === 'boolean' && timestamp(r.observedAt) && (r.result === undefined || typeof r.result === 'string' && r.result.length <= 16_000)
    && (r.image === undefined || record(r.image) && timestamp(r.image.capturedAt) && typeof r.image.dataUrl === 'string'
      && /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(r.image.dataUrl) && r.image.dataUrl.length <= 700_000));
}
