import { createHash } from 'node:crypto';
import type Anthropic from '@anthropic-ai/sdk';

/**
 * The stored state of a transient body task (observation redesign P3; `anthropicFcaTransient.ts` explains the whole shape): the user
 * text `{"stateUpdate":"full"|"changed",…}` that carries what the model must keep seeing, only when it changed since the history last
 * stated it. The tool catalog is stated item by item: a first `catalog` list, then `catalogChanges` {added, changed, removed} (a change
 * of one tool's description never states the whole catalog again). A part that was cut to fit the request is named (`capped`,
 * `cappedCatalog`) with the digest of the whole it was cut from, so that a later state restates it whole once it fits
 * (`anthropicFcaStateCut.ts`). Nothing here is ever cut; this module only says what to state.
 */
export const STATE_MARK = '{"stateUpdate":';
/** The parts a stored state may carry besides the catalog, in order. The task is always stated first, and in full. */
const PARTS = ['task', 'children', 'messages', 'skillIndex', 'sharedContext', 'progress', 'stageKnowledge'] as const;
const EMPTY_LIST = new Set(['children', 'messages']);
/** Parts that may be absent from a decision (no index, no shared context, no progress tools), and so be stated as removed. */
const OPTIONAL = new Set(['skillIndex', 'sharedContext', 'progress', 'stageKnowledge']);

const digest = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 24);
/** What a catalog item is compared by. A digest: the key of a cut item is written into the state that cut it, never the whole. */
export const itemKey = (item: unknown): string => digest(JSON.stringify(item));
/** What a part is compared by: the shared context by its revision and its outcomes' progress (its text is large and moves without meaning). */
export function partKey(key: string, value: unknown): string {
  if (key !== 'sharedContext') return digest(JSON.stringify(value));
  const context = object(value), affect = object(context?.affect), outcomes = Array.isArray(context?.recentOutcomes) ? context.recentOutcomes : [];
  return digest(JSON.stringify([affect?.revision ?? null, outcomes.map(outcome => {
    const row = object(outcome);
    return [row?.eventId ?? null, row?.appraisalRevision ?? null, row?.observation ?? null];
  })]));
}

interface Stated {
  latest: Map<string, string>; catalog: Map<string, string> | null; cappedItems: Set<string>; messages: Set<string>; capped: Set<string>; any: boolean;
}
/**
 * What the history of this epoch already stated: each part as last stated (a part stated cut is keyed by the key of the whole it was
 * cut from, and named in `capped`; so is a catalog item, in `cappedItems`), the catalog's items, and the ids of the messages it showed.
 */
function statedBefore(history: readonly Anthropic.MessageParam[]): Stated {
  const stated: Stated = { latest: new Map(), catalog: null, cappedItems: new Set(), messages: new Set(), capped: new Set(), any: false };
  for (const message of history) {
    if (message.role !== 'user' || !Array.isArray(message.content)) continue;
    const block = message.content[0];
    if (block?.type !== 'text' || !block.text.startsWith(STATE_MARK)) continue;
    let row: Record<string, unknown> | null = null;
    try { row = object(JSON.parse(block.text)); } catch { row = null; }
    if (!row) continue;
    stated.any = true;
    noteStated(row, stated);
  }
  return stated;
}

function noteStated(row: Record<string, unknown>, into: Stated): void {
  const { latest, capped } = into, cutFrom = object(row.capped);
  for (const key of PARTS) {
    if (!(key in row)) continue;
    const whole = cutFrom?.[key];
    latest.set(key, typeof whole === 'string' ? whole : partKey(key, row[key]));
    if (typeof whole === 'string') capped.add(key); else capped.delete(key);
  }
  for (const name of Array.isArray(row.removed) ? row.removed : []) {
    if (typeof name === 'string') {
      latest.delete(name);
      capped.delete(name);
    }
  }
  noteCatalog(row, into);
  for (const item of Array.isArray(row.messages) ? row.messages : []) {
    const id = object(item)?.id;
    if (typeof id === 'string') into.messages.add(id);
  }
}

/** A `catalog` list replaces the stated catalog; `catalogChanges` applies to it. */
function noteCatalog(row: Record<string, unknown>, into: Stated): void {
  const cutFrom = object(row.cappedCatalog), changes = object(row.catalogChanges);
  const note = (items: unknown): void => {
    for (const item of Array.isArray(items) ? items : []) {
      const name = object(item)?.name, whole = typeof name === 'string' ? cutFrom?.[name] : undefined;
      if (typeof name !== 'string') continue;
      into.catalog!.set(name, typeof whole === 'string' ? whole : itemKey(item));
      if (typeof whole === 'string') into.cappedItems.add(name); else into.cappedItems.delete(name);
    }
  };
  if (Array.isArray(row.catalog)) {
    into.catalog = new Map();
    into.cappedItems.clear();
    note(row.catalog);
  }
  if (!changes) return;
  into.catalog ??= new Map();
  for (const name of Array.isArray(changes.removed) ? changes.removed : []) {
    if (typeof name === 'string') {
      into.catalog.delete(name);
      into.cappedItems.delete(name);
    }
  }
  note(changes.added);
  note(changes.changed);
}

/**
 * What a legacy decision showed of the task and a transient one states (review 4, M1): everything but the fields that move with every
 * step and say nothing the model decides on, `revision` and `updatedAt` (stating them would make the task a changed part each step).
 * `parentId` is what `task.send` needs; `kind`, `origin`, `status`, `phase`, `pauseReason`, `summary` and `childIds` are the task's
 * state, stated again only when one of them changes. In the legacy order.
 */
const TASK_FIELDS = ['id', 'scopeKey', 'parentId', 'kind', 'origin', 'title', 'goal', 'completionCriteria', 'status', 'pauseReason',
  'summary', 'createdAt', 'phase', 'childIds'] as const;
function statedTask(value: unknown): unknown {
  const task = object(value);
  return task ? Object.fromEntries(TASK_FIELDS.filter(key => task[key] !== undefined).map(key => [key, task[key]])) : value;
}

/**
 * The catalog as a state says it: the whole list the first time the epoch has any, then only the items added, changed or removed since
 * (and, with `restate`, the items stated cut earlier, whole again). Nothing when nothing changed.
 */
function catalogPart(current: unknown, stated: Stated, restate: boolean): Record<string, unknown> {
  // One entry for each provider name, the first (review 4, L4): two tools whose names meet after `.` becomes `_` can be told apart by
  // nothing the model writes (a call finds the first, `fcaToolState.ts`), and the catalog is compared by that name, so both of them would
  // be stated as changed at every step. Such a pair is refused earlier (`FCA_MODEL_TOOL_CONFLICT`); this keeps the diff stable regardless.
  const seen = new Set<string>();
  const items = (Array.isArray(current) ? current as unknown[] : []).filter(item => {
    const name = object(item)?.name;
    if (typeof name !== 'string' || seen.has(name)) return false;
    seen.add(name);
    return true;
  });
  if (stated.catalog === null) return items.length ? { catalog: items } : {};
  const now = new Set(items.map(item => String(object(item)!.name)));
  const added: unknown[] = [], changed: unknown[] = [];
  for (const item of items) {
    const name = String(object(item)!.name), before = stated.catalog.get(name);
    if (before === undefined) added.push(item);
    else if (before !== itemKey(item) || (restate && stated.cappedItems.has(name))) changed.push(item);
  }
  const removed = [...stated.catalog.keys()].filter(name => !now.has(name));
  const changes = { ...(added.length ? { added } : {}), ...(changed.length ? { changed } : {}), ...(removed.length ? { removed } : {}) };
  return Object.keys(changes).length ? { catalogChanges: changes } : {};
}

/** The candidates whose value differs from what was last stated, and the optional parts that were stated and are gone (`removed`). */
function changedParts(candidates: ReadonlyArray<[string, unknown]>, stated: Stated, restate: boolean): { row: Record<string, unknown>; parts: string[] } {
  const row: Record<string, unknown> = {}, parts: string[] = [], removed: string[] = [];
  for (const [key, value] of candidates) {
    // A part that was stated and is gone now is named as removed: "a part it lacks is unchanged" would otherwise keep showing it.
    if (value === undefined) {
      if (OPTIONAL.has(key) && stated.latest.has(key)) removed.push(key);
      continue;
    }
    const before = stated.latest.get(key) ?? (EMPTY_LIST.has(key) ? partKey(key, []) : undefined), now = partKey(key, value);
    const again = restate && stated.capped.has(key) && before === now;
    if (key === 'messages' ? !(value as unknown[]).length : before === now && !again) continue;
    row[key] = value;
    parts.push(key);
  }
  if (removed.length) {
    row.removed = removed;
    parts.push('removed');
  }
  return { row, parts };
}

export interface StoredRow {
  /** What to state, whole (never cut here); empty when nothing changed. */
  row: Record<string, unknown>; parts: string[];
  /** The first state of the epoch. */
  full: boolean;
  /** Some part or catalog item was stated cut earlier: asking again with `restate` says it whole. */
  hasCut: boolean;
}

/**
 * What to state this step. `supplied` is the decision's fields (`decisionFields`). The first state of an epoch is `full`; it is always the
 * first the epoch holds, because a summary's new epoch replays only its bootstrap text, which states none of the parts.
 */
export function storedState(supplied: Record<string, unknown>, history: readonly Anthropic.MessageParam[], restate = false): StoredRow {
  const stated = statedBefore(history);
  const messages = (Array.isArray(supplied.messages) ? supplied.messages as unknown[] : []).filter(item => {
    const id = object(item)?.id;
    return typeof id !== 'string' || !stated.messages.has(id);
  });
  const changed = changedParts([['task', statedTask(supplied.task)], ['children', supplied.children], ['messages', messages],
    ['skillIndex', supplied.skillIndex], ['sharedContext', supplied.sharedContext], ['progress', supplied.progress],
    ['stageKnowledge', supplied.stageKnowledge]], stated, restate);
  const catalog = catalogPart(supplied.catalog, stated, restate), parts = changed.parts;
  // The catalog comes after the messages and before the skill index, as it stood in the decision message.
  const row: Record<string, unknown> = { ...changed.row, ...catalog };
  const order = [...PARTS.slice(0, 3), 'catalog', 'catalogChanges', ...PARTS.slice(3), 'removed'];
  const ordered = Object.fromEntries(order.filter(key => key in row).map(key => [key, row[key]]));
  return { row: ordered, parts: [...parts, ...Object.keys(catalog)], full: !stated.any,
    hasCut: stated.capped.size > 0 || stated.cappedItems.size > 0 };
}

/** The user message of a state row (null when it is empty). */
export function stateMessage(row: Record<string, unknown>, full: boolean): Anthropic.MessageParam | null {
  if (!Object.keys(row).length) return null;
  return { role: 'user', content: [{ type: 'text', text: stateText(row, full) }] };
}
export const stateText = (row: Record<string, unknown>, full: boolean): string => JSON.stringify({ stateUpdate: full ? 'full' : 'changed', ...row });

/** The parts a summary or a size budget does not read whole: the catalog and the skill index, which each epoch's first state says again. */
const RESTATED_BY_STATE = ['catalog', 'catalogChanges', 'skillIndex', 'stageKnowledge'] as const;
export function publicState(text: string): string {
  if (!text.startsWith(STATE_MARK)) return text;
  let row: Record<string, unknown> | null = null;
  try { row = object(JSON.parse(text)); } catch { return text; }
  if (!row || !RESTATED_BY_STATE.some(key => key in row)) return text;
  const kept = Object.fromEntries(Object.entries(row).filter(([key]) => !(RESTATED_BY_STATE as readonly string[]).includes(key)));
  return JSON.stringify({ ...kept, restatedEachEpoch: RESTATED_BY_STATE.filter(key => key in row) });
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
