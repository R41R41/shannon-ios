import { GOAL_OUTCOMES, RUN_ENDS } from '../../contracts/continueContract.js';
import type { MinecraftControlPoll, MinecraftSkillDefinition } from '../../contracts/minecraftControlContract.js';
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
const SKILL = /^[a-z][a-z0-9-]{0,59}$/;
const forbidden = /(?:campaign|planner|agent|command|chat|constant|script|code|background|schedule)/;
export const controlId = (value: unknown): value is string => typeof value === 'string' && ID.test(value);
export const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
export const timestamp = (v: unknown): v is string => typeof v === 'string' && v.length <= 40 && Number.isFinite(Date.parse(v));
const boundedJSON = (v: unknown, length: number) => { try { return JSON.stringify(v).length <= length; } catch { return false; } };

/** The task queue's `act` takes a condition (an array of arrays of objects) in `done`: two levels deeper than the schemas before it. */
const SKILL_SCHEMA_DEPTH = 8;
/**
 * The most alternatives an `anyOf` may have. run 39 (2026-10-26, rel55): the body's `done` condition is one object schema per kind of clause (11), and 4 refused the
 * body's whole catalog: every poll was a 400 FCA_BODY_POLL_INVALID, so the head never saw the body. 16 leaves room for the kinds still to come.
 */
const SKILL_SCHEMA_ANY_OF = 16;
/**
 * The most properties an object schema may have. run 39 (2026-10-26): the act's hand has 43 with the new hands' fields (it had 31); 48 left room.
 * Continue contract 2 (the 欄の数): `dependsOn` and vertical's `dir`, `shape`, `toward`, `toY` and `liquid` make the hand's 49; 56 leaves room.
 */
const SKILL_SCHEMA_PROPERTIES = 56;
/** Bounded JSON-schema subset; native skill validation remains authoritative at the actuator. */
export function skillSchema(value: unknown, depth = 0): value is Readonly<Record<string, unknown>> {
  if (!record(value) || depth > SKILL_SCHEMA_DEPTH) return false;
  const allowed = ['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'description', 'minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems', 'anyOf', 'default'];
  if (Object.keys(value).some(key => !allowed.includes(key))) return false;
  if (value.description !== undefined && (typeof value.description !== 'string' || value.description.length > 2000)) return false;
  if (['minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems'].some(key => value[key] !== undefined && (typeof value[key] !== 'number' || !Number.isFinite(value[key])))) return false;
  if (value.anyOf !== undefined) {
    return Array.isArray(value.anyOf) && value.anyOf.length > 0 && value.anyOf.length <= SKILL_SCHEMA_ANY_OF
      && value.anyOf.every(item => skillSchema(item, depth + 1));
  }
  if (!['object', 'array', 'string', 'integer', 'number', 'boolean', 'null'].includes(String(value.type))) return false;
  if (value.type === 'object') {
    if (!record(value.properties) || Object.keys(value.properties).length > SKILL_SCHEMA_PROPERTIES || value.additionalProperties !== false) return false;
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
/** The live speech fields of a poll (session dc-live): receipts the body gives for lines it was handed, and the room it plays in. Both optional. */
const SPEECH_OUTCOMES = ['spoken', 'posted', 'declined', 'failed'];
const CONVERSATION_ID = /^discord:\d{0,25}:\d{1,25}$/;
function validLiveSpeech(value: Record<string, unknown>): boolean {
  const receipts = value.speechReceipts, room = value.liveRoom;
  const receiptsOk = receipts === undefined || (Array.isArray(receipts) && receipts.length <= 8 && receipts.every(item => record(item) && controlId(item.id)
    && SPEECH_OUTCOMES.includes(String(item.outcome)) && (item.reason === undefined || typeof item.reason === 'string' && /^[a-z_]{1,40}$/.test(item.reason))
    && (item.conversationId === undefined || typeof item.conversationId === 'string' && CONVERSATION_ID.test(item.conversationId))));
  const roomOk = room === undefined || (record(room) && typeof room.voice === 'boolean' && typeof room.humanSpeaking === 'boolean'
    && (room.sinceHumanMs === null || typeof room.sinceHumanMs === 'number' && Number.isFinite(room.sinceHumanMs) && room.sinceHumanMs >= 0));
  return receiptsOk && roomOk;
}
/**
 * The task queue's fields of a poll, both optional: the ids of the waiting items (at most 8) and how far the running item is (whole numbers, its
 * repeat 1–8). A body without the queue sends neither.
 */
export function validQueueFields(value: Record<string, unknown>): boolean {
  const queued = value.queuedOperationIds, progress = value.queue;
  const idsOk = queued === undefined || (Array.isArray(queued) && queued.length <= 8 && queued.every(controlId));
  const whole = (item: unknown, high: number) => Number.isSafeInteger(item) && Number(item) >= 1 && Number(item) <= high;
  const progressOk = progress === undefined || (record(progress) && controlId(progress.id) && whole(progress.hand, 100_000) && whole(progress.of, 100_000)
    && whole(progress.iteration, 100_000) && whole(progress.repeat, 8));
  return idsOk && progressOk;
}
/** The cuts a unit may name (`CutBy`) and the two codes a dropped one may add. */
const DROPPED_CODES = ['reflex', 'stopIf', 'inventoryFull', 'cancelled', 'deadline', 'noProgress', 'damage', 'fall', 'death', 'stale_life', 'dimension_changed', 'lease_expired',
  'connection_changed', 'operator_stop', 'handover', 'depends_failed', 'depends_unknown'];
/** A queue mark of the body (`{ queue, item }`, continue contract 2). */
const queueRef = (v: unknown): boolean => record(v) && typeof v.queue === 'string' && v.queue.length > 0 && v.queue.length <= 200 && controlId(v.item);
/**
 * A receipt's `unit` (continue contract 1): both axes in their closed words, `released`, and the optional marks of why it was dropped or kept and when it started.
 * Only the shape is read here; which pairs of words are allowed is the contract's table, kept by the body that writes them.
 */
export function validUnit(v: unknown): boolean {
  return record(v) && GOAL_OUTCOMES.includes(v.goal as never) && RUN_ENDS.includes(v.end as never) && typeof v.released === 'boolean'
    && (v.droppedBecause === undefined || record(v.droppedBecause) && DROPPED_CODES.includes(String(v.droppedBecause.code)) && (v.droppedBecause.item === undefined || queueRef(v.droppedBecause.item)))
    && (v.keptDespite === undefined || record(v.keptDespite) && queueRef(v.keptDespite.item) && typeof v.keptDespite.code === 'string' && v.keptDespite.code.length <= 80)
    && (v.startedAt === undefined || timestamp(v.startedAt));
}
/** A receipt's `bodyTimes`: the times of the stages, in ISO strings (`acceptedAt` and `endedAt` are always there). */
export function validBodyTimes(v: unknown): boolean {
  if (!record(v) || !timestamp(v.acceptedAt) || !timestamp(v.endedAt)) return false;
  return ['startedAt', 'lockAt', 'firstMotorAt', 'failedAt'].every(key => v[key] === undefined || timestamp(v[key]))
    && (v.reflexWaitMs === undefined || typeof v.reflexWaitMs === 'number' && Number.isFinite(v.reflexWaitMs) && v.reflexWaitMs >= 0)
    && (v.motorOps === undefined || Number.isSafeInteger(v.motorOps) && Number(v.motorOps) >= 0);
}
/** A receipt's `eventsMore`: where the events that did not fit are fetched (the command, the next `deliverySeq`, how many there are in all). */
export function validEventsMore(v: unknown): boolean {
  return record(v) && controlId(v.command) && Number.isSafeInteger(v.nextSeq) && Number(v.nextSeq) >= 0 && Number.isSafeInteger(v.total) && Number(v.total) >= Number(v.nextSeq)
    && Number(v.total) <= 100_000;
}
/** The poll's `bodyVersion` (continue contract 8): the body's revision and the hash of its catalog. */
export function validBodyVersion(v: unknown): boolean {
  return record(v) && typeof v.revision === 'string' && v.revision.length > 0 && v.revision.length <= 80 && typeof v.catalogHash === 'string' && v.catalogHash.length > 0 && v.catalogHash.length <= 160;
}
export function validControlPoll(value: unknown, now: number): value is MinecraftControlPoll {
  if (!record(value) || value.schemaVersion !== 1 || !controlId(value.serverId) || !controlId(value.connectionId)) return false;
  const o = value.observation;
  if (!record(o) || o.schemaVersion !== 1 || !controlId(o.bodyId) || !Number.isSafeInteger(o.sequence) || Number(o.sequence) < 0
    || !timestamp(o.stateAt) || !timestamp(o.receivedAt) || Math.abs(now - Date.parse(o.stateAt)) > 30_000
    || typeof o.connected !== 'boolean' || !record(o.state) || !record(o.facts) || !boundedJSON(o, 100_000)) return false;
  if (Object.entries(o.facts).some(([key,v]) => key.length > 160 || v !== null && (!['boolean', 'number', 'string'].includes(typeof v) || typeof v === 'number' && !Number.isFinite(v) || typeof v === 'string' && v.length > 2000))) return false;
  if (!validObservationState(o.state, o.facts)) return false;
  if (!Array.isArray(value.candidates) || value.candidates.length > 64 || !boundedJSON(value.candidates, 100_000)) return false;
  if (value.candidates.some(c => !record(c) || !['action', 'observe', 'return', 'stop'].includes(String(c.kind)) || typeof c.label !== 'string'
    || c.label.length > 500 || !record(c.arguments) || !Array.isArray(c.preconditions) || c.preconditions.length > 32
    || c.preconditions.some(p => !record(p) || typeof p.key !== 'string' || !Object.hasOwn(o.facts as object, p.key) || p.value !== null && !['boolean','number','string'].includes(typeof p.value))
    || c.kind === 'action' && (typeof c.operation !== 'string' || c.operation.length > 80)
    || c.requiresImage !== undefined && typeof c.requiresImage !== 'boolean'
    || !timestamp(c.expiresAt) || !Number.isFinite(c.maxDurationMs) || Number(c.maxDurationMs) < 0 || Number(c.maxDurationMs) > 5000)) return false;
  if (value.skills !== undefined && !validSkills(value.skills)) return false;
  if (!Array.isArray(value.activeOperationIds) || value.activeOperationIds.length > 8 || value.activeOperationIds.some(id => !controlId(id))) return false;
  // Each event is checked when it is taken (`WorkingEventLog`, the first 32 only); a malformed one is skipped, never the whole poll.
  if (value.events !== undefined && !Array.isArray(value.events)) return false;
  if (!validLiveSpeech(value) || !validQueueFields(value)) return false;
  if (value.bodyVersion !== undefined && !validBodyVersion(value.bodyVersion)) return false;
  return Array.isArray(value.receipts) && value.receipts.length <= 16 && value.receipts.every(r => record(r) && controlId(r.id)
    && r.connectionId === value.connectionId && ['completed', 'failed', 'cancelled', 'unknown'].includes(String(r.outcome))
    && typeof r.inputsReleased === 'boolean' && timestamp(r.observedAt) && (r.result === undefined || typeof r.result === 'string' && r.result.length <= 16_000)
    && (r.unit === undefined || validUnit(r.unit)) && (r.bodyTimes === undefined || validBodyTimes(r.bodyTimes)) && (r.eventsMore === undefined || validEventsMore(r.eventsMore))
    && (r.image === undefined || record(r.image) && timestamp(r.image.capturedAt) && typeof r.image.dataUrl === 'string'
      && /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(r.image.dataUrl) && r.image.dataUrl.length <= 700_000));
}

// ---- continue contract 4 and 5 (and 3's scan): the observation's life, run, control and utilities ---------------------------------------------------------------
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
const whole = (v: unknown, low = 0): v is number => Number.isSafeInteger(v) && Number(v) >= low;
const DIMENSIONS = ['overworld', 'the_nether', 'the_end'];
/** `state.life` (a `LifeView`): the life number, why it moved on, the death counter (epoch and sequence come together), the time, whether alive, the dimension and its generation. */
export function validLifeView(v: unknown): boolean {
  if (!record(v) || !whole(v.life, 1) || typeof v.alive !== 'boolean' || !timestamp(v.since) || !timestamp(v.dimensionSince) || !DIMENSIONS.includes(String(v.dimension))) return false;
  if (v.advancedBy !== undefined && v.advancedBy !== 'death' && v.advancedBy !== 'file_unreadable') return false;
  if ((v.deathEpoch === undefined) !== (v.deathSeq === undefined) || (v.deathEpoch !== undefined && (!text(v.deathEpoch, 80) || !whole(v.deathSeq)))) return false;
  return (v.diedAt === undefined || timestamp(v.diedAt)) && (v.deathCause === undefined || typeof v.deathCause === 'string' && v.deathCause.length <= 200);
}
/** `state.bodyRun`: the body's boot and the connection it runs in. */
export const validBodyRun = (v: unknown): boolean => record(v) && text(v.bodyBoot, 80) && text(v.connectionId, 160);
/** `state.control` (a `ControlView`): who holds the body, the reflex's episode, the combat mark, and the commands waiting behind a reflex. */
export function validControlView(v: unknown): boolean {
  if (!record(v) || !record(v.holder) || !Array.isArray(v.waiting) || v.waiting.length > 16) return false;
  const holder = v.holder;
  const holderOk = holder.kind === 'idle'
    || holder.kind === 'command' && text(holder.actionId, 160) && text(holder.command, 160) && (holder.item === undefined || text(holder.item, 40)) && whole(holder.life) && timestamp(holder.since)
    || holder.kind === 'reflex' && text(holder.actionId, 160) && text(holder.reflex, 80) && whole(holder.priority) && (holder.target === undefined || whole(holder.target)) && timestamp(holder.since)
      && (holder.episode === undefined || typeof holder.episode === 'boolean')
    || holder.kind === 'bridge' && text(holder.after, 80) && (holder.hold === 'shield' || holder.hold === 'step_back') && (holder.target === undefined || whole(holder.target))
      && timestamp(holder.since) && timestamp(holder.until)
    || holder.kind === 'cleanup' && text(holder.command, 160) && timestamp(holder.since);
  if (!holderOk) return false;
  const episode = v.reflexEpisode, mark = v.combatMark;
  if (episode !== undefined && !(record(episode) && text(episode.reflex, 80) && (episode.target === undefined || whole(episode.target)) && whole(episode.hands) && whole(episode.hits)
    && timestamp(episode.since))) return false;
  if (mark !== undefined && !(record(mark) && text(mark.skill, 80) && (mark.target === undefined || whole(mark.target)) && timestamp(mark.until))) return false;
  return v.waiting.every(entry => record(entry) && text(entry.command, 160) && timestamp(entry.since) && text(entry.behind, 160));
}
/** `state.world.utilities` (chapter 3): the radius scanned, whether a scan was made at all, and what it found (block and distance). */
export function validUtilities(v: unknown): boolean {
  return record(v) && typeof v.radius === 'number' && Number.isFinite(v.radius) && v.radius > 0 && typeof v.scanned === 'boolean'
    && (v.dim === undefined || typeof v.dim === 'string' && v.dim.length <= 40) && (v.obsSeq === undefined || whole(v.obsSeq))
    && Array.isArray(v.found) && v.found.length <= 64 && v.found.every(item => record(item) && text(item.block, 80) && typeof item.distance === 'number' && Number.isFinite(item.distance));
}
/**
 * The new fields of an observation, each optional (a body before the contract sends none): `facts.life`, `state.life`, `state.bodyRun`, `state.control`,
 * `state.world.utilities`. Only the shape is read here; what the life means (a rise of the death counter) is `deathBetween`'s.
 */
export function validObservationState(state: Record<string, unknown>, facts: Record<string, unknown>): boolean {
  if (facts.life !== undefined && !whole(facts.life, 1)) return false;
  if (state.life !== undefined && !validLifeView(state.life)) return false;
  if (state.bodyRun !== undefined && !validBodyRun(state.bodyRun)) return false;
  if (state.control !== undefined && !validControlView(state.control)) return false;
  const world = state.world;
  return !(record(world) && world.utilities !== undefined && !validUtilities(world.utilities));
}
