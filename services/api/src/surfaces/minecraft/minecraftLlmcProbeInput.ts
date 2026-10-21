import type { BodyObservation } from '../../contracts/bodyControlContract.js';
import type { ActPos } from '../../contracts/minecraftActContract.js';
import { PROBE_INPUT_SCHEMA, PROBE_KINDS, readProbeResult, type ProbeInput, type ProbeKind } from '../../contracts/minecraftProbeContract.js';

/**
 * mb-llmc r4: `mc.probe` as the model writes it, put into the body's form (`prepareProbeInput`: a creature named is sent as its `#id`, a
 * column always with its x, z and y bounds, a radius within its kind's range), and a probe's answer as a decision reads it
 * (`probeAnswerText`). The surprises and the investigation that uses them are `minecraftLlmcProbe.ts`.
 */
export const LLMC_PROBE = Object.freeze({
  /** The probes of one step, sent at once. */
  maxProbes: 2,
  /** The step's wait for their answers (an urgent step's is shorter); past it the decision goes on without them. */
  budgetMs: 2_000, urgentBudgetMs: 1_000,
  /** The tokens of the whole investigation in the live state. */
  tokens: 600,
  /** The deadline of one probe command (the body computes in 0–1 s; a scan of 441 chunks about 1 s). */
  commandMs: 5_000,
  /** A model's `mc.probe` (its own call). */
  toolMs: 8_000,
  /** The characters of a probe's fields beside its text in a model's own call. */
  toolFieldChars: 2_500,
});

export type Fields = Record<string, unknown>;
export const plain = (value: unknown): Fields | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Fields : null;
export const finite = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value
  : typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value)) ? Number(value) : null;
export const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
export const posText = (at: ActPos) => `(${at.x},${at.y},${at.z})`;

/** A position as the model may write it (`{x,y,z}` of numbers or numeric strings, `[x,y,z]`, `"x,y,z"`), whole blocks; null if none. */
export function readPos(value: unknown): ActPos | null {
  let parts: unknown[] | null = null;
  if (Array.isArray(value)) parts = value;
  else if (typeof value === 'string') {
    const match = /^\s*\(?\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*\)?\s*$/u.exec(value);
    parts = match ? match.slice(1) : null;
  } else {
    const record = plain(value);
    parts = record ? [record.x, record.y, record.z] : null;
  }
  if (!parts || parts.length !== 3) return null;
  const [x, y, z] = parts.map(finite);
  return x === null || y === null || z === null || x === undefined || y === undefined || z === undefined ? null
    : { x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) };
}
const exactPos = (value: unknown) => {
  const record = plain(value);
  return !!record && Object.keys(record).length === 3 && ['x', 'y', 'z'].every(key => Number.isInteger(record[key]));
};

/** The words a model may use for a kind (the prototype's names, mc.view's modes). */
const KIND_WORDS: Readonly<Record<string, ProbeKind>> = {
  path: 'path', look_path: 'path', route: 'path', way: 'path', walk: 'path',
  sight: 'sight', look_reach: 'sight', reach: 'sight', see: 'sight', los: 'sight',
  column: 'column', look_section: 'column', section: 'column', vertical: 'column', drop: 'column',
  around: 'around', look_creatures: 'around', creatures: 'around', entities: 'around', mobs: 'around', nearby: 'around',
  history: 'history', look_history: 'history', stops: 'history', past: 'history',
  scan: 'scan', landmarks: 'scan', survey: 'scan',
};
/** The fields each kind takes (everything else is left out and said). */
const KIND_FIELDS: Readonly<Record<ProbeKind, readonly string[]>> = {
  path: ['to', 'from'], sight: ['target', 'from'], column: ['x', 'z', 'yFrom', 'yTo'], around: ['radius'], history: ['at', 'radius'], scan: ['radius'],
};
/** The radius each kind takes: its range and default (none: the body's own). */
const RADIUS: Readonly<Partial<Record<ProbeKind, { low: number; high: number; fallback?: number }>>> = {
  around: { low: 1, high: 16, fallback: 8 }, history: { low: 1, high: 32, fallback: 4 }, scan: { low: 1, high: 16 },
};
/** A column's default bounds from her feet: below her (a fall, a shaft) or above her (air, water over her head). */
export const COLUMN_DOWN = Object.freeze({ up: 2, down: 14 });
export const COLUMN_UP = Object.freeze({ up: 16, down: 0 });
const COLUMN_SPAN = 96;

/** What the head knows of where she is, for the fields the model left out and a creature it named. */
export interface ProbeContext { feet: ActPos | null; creatures: ReadonlyArray<{ id: number; name: string; distance: number }> }
/** The creatures of a frame with their ids, nearest first (hostiles and the rest). */
export function frameCreatures(observation: BodyObservation | null): ProbeContext['creatures'] {
  const world = plain(observation?.state.world) ?? {};
  return [...(Array.isArray(world.nearbyThreats) ? world.nearbyThreats : []), ...(Array.isArray(world.nearbyEntities) ? world.nearbyEntities : [])]
    .flatMap(item => {
      const entity = plain(item), id = finite(entity?.id), distance = finite(entity?.distance);
      return entity && typeof entity.name === 'string' && id !== null && Number.isSafeInteger(id)
        ? [{ id, name: entity.name.replace(/^minecraft:/u, '').toLowerCase(), distance: distance ?? 99 }] : [];
    }).sort((left, right) => left.distance - right.distance);
}

/** The schema the head checks a probe against once it is in the body's form (a sight's target may be a block or `#id`). */
export const PROBE_WIRE_SCHEMA = Object.freeze({
  ...PROBE_INPUT_SCHEMA,
  properties: { ...PROBE_INPUT_SCHEMA.properties, target: { anyOf: [{ type: 'string', maxLength: 64 }, PROBE_INPUT_SCHEMA.properties.to] } },
});

/**
 * A probe as the model wrote it, put into the body's form (the shared note's 04:10 form), with each fix said in a line; or why it cannot
 * be sent (Japanese, one line). The kind by its name or a near word; positions of numbers, numeric strings, `[x,y,z]` or `"x,y,z"`; a
 * sight's target from `target` (`#id`, an id, a name of a creature near, `"x,y,z"`) or `at`; a column's x, z and y bounds from her feet when
 * left out (`COLUMN_DOWN`); a history's place from her feet; a radius within its kind's range; the fields a kind does not take left out.
 */
export function prepareProbeInput(input: unknown, context: ProbeContext): { input: ProbeInput | null; fixes: string[]; problem: string | null } {
  const fixes: string[] = [];
  const fields = plain(input);
  if (!fields) return { input: null, fixes, problem: 'mc.probe の引数は object（kind と、その kind の欄）' };
  const word = typeof fields.kind === 'string' ? fields.kind.trim().toLowerCase() : '';
  const kind = KIND_WORDS[word] ?? (PROBE_KINDS as readonly string[]).find(item => item === word) as ProbeKind | undefined;
  if (!kind) return { input: null, fixes, problem: `kind は ${PROBE_KINDS.join('・')} のどれか（今: ${String(fields.kind ?? '無し').slice(0, 20)}）` };
  if (kind !== fields.kind) fixes.push(`kind を ${kind} にした`);
  const out: ProbeInput = { kind };
  const problem = KIND_PREPARE[kind]?.({ fields, context, fixes, out }) ?? null;
  if (problem) return { input: null, fixes, problem };
  prepareRadius(kind, fields, fixes, out);
  const taken = new Set(['kind', ...KIND_FIELDS[kind], ...(kind === 'path' || kind === 'sight' ? ['at'] : [])]);
  const extra = Object.keys(fields).filter(key => !taken.has(key));
  if (extra.length) fixes.push(`${kind} に使わない欄 ${extra.join('・')} を外した`);
  return { input: out, fixes, problem: null };
}
/** What one kind's preparation works on: the model's fields, what the head knows, the fixes said, the input made. */
interface Preparing { fields: Fields; context: ProbeContext; fixes: string[]; out: ProbeInput }
/** A position field of the model's, as whole blocks (the fix said), null when it is not one, undefined when absent. */
function position(work: Preparing, key: string): ActPos | null | undefined {
  const value = work.fields[key];
  if (value === undefined) return undefined;
  const at = readPos(value);
  if (at && !exactPos(value)) work.fixes.push(`${key} を整数の座標にした`);
  return at;
}
/** Each kind's own fields (a problem, or null); around and scan have none of their own (their radius is `prepareRadius`'s). */
const KIND_PREPARE: Readonly<Partial<Record<ProbeKind, (work: Preparing) => string | null>>> = {
  path(work) {
    const to = position(work, 'to') ?? position(work, 'at') ?? (typeof work.fields.target === 'string' ? readPos(work.fields.target) : null);
    if (!to) return 'path には to {x,y,z} が要る';
    if (work.fields.to === undefined) work.fixes.push('行き先を to にした');
    work.out.to = to;
    const from = position(work, 'from');
    if (from) work.out.from = from;
    return null;
  },
  sight(work) {
    const target = sightTarget(work.fields, work.context, work.fixes);
    if (typeof target === 'object' && 'problem' in target) return target.problem;
    work.out.target = target;
    const from = position(work, 'from');
    if (from) work.out.from = from;
    return null;
  },
  column: prepareColumn,
  history(work) {
    const feet = work.context.feet;
    const at = position(work, 'at') ?? (feet ? { x: Math.floor(feet.x), y: Math.floor(feet.y), z: Math.floor(feet.z) } : null);
    if (!at) return 'history の at が無く、足の位置も分からない';
    if (work.fields.at === undefined) work.fixes.push('at を足にした');
    work.out.at = at;
    return null;
  },
};
/** A column's x and z (her feet's when left out) and its y bounds (`COLUMN_DOWN` from her feet when left out), top first, within 96. */
function prepareColumn(work: Preparing): string | null {
  const { fields, fixes, out } = work, feet = work.context.feet;
  const x = finite(fields.x), z = finite(fields.z);
  if ((x === null || z === null) && !feet) return 'column の x・z が無く、足の位置も分からない';
  out.x = Math.floor(x ?? feet!.x);
  out.z = Math.floor(z ?? feet!.z);
  if (x === null || z === null) fixes.push('x・z を足の列にした');
  let top = finite(fields.yFrom), bottom = finite(fields.yTo);
  if (top === null || bottom === null) {
    if (!feet) return 'column の yFrom・yTo が無く、足の位置も分からない';
    top ??= feet.y + COLUMN_DOWN.up;
    bottom ??= feet.y - COLUMN_DOWN.down;
    fixes.push('yFrom・yTo を足の上下にした');
  }
  if (top < bottom) {
    [top, bottom] = [bottom, top];
    fixes.push('yFrom（上）と yTo（下）を入れ替えた');
  }
  out.yFrom = clamp(Math.floor(top), -64, 320);
  out.yTo = clamp(Math.floor(bottom), -64, 320);
  if (out.yFrom - out.yTo >= COLUMN_SPAN) {
    out.yTo = out.yFrom - COLUMN_SPAN + 1;
    fixes.push(`幅を ${COLUMN_SPAN} 段にした`);
  }
  return null;
}
/** The radius within its kind's range (said when changed), or the kind's default. */
function prepareRadius(kind: ProbeKind, fields: Fields, fixes: string[], out: ProbeInput): void {
  const range = RADIUS[kind];
  if (!range) return;
  const radius = finite(fields.radius);
  if (radius === null) {
    if (range.fallback !== undefined) out.radius = range.fallback;
    return;
  }
  out.radius = clamp(Math.round(radius), range.low, range.high);
  if (out.radius !== fields.radius) fixes.push(`radius を ${out.radius} にした`);
}
/** A sight's target in the body's form: a block, or `#id` (a creature by its id or its name, the nearest of that name). */
function sightTarget(fields: Fields, context: ProbeContext, fixes: string[]): ActPos | string | { problem: string } {
  const raw = fields.target ?? fields.at;
  if (raw === undefined) return { problem: 'sight には target（座標か "#id"）が要る' };
  if (fields.target === undefined) fixes.push('at を target にした');
  const at = readPos(raw);
  if (at) {
    if (!exactPos(raw)) fixes.push('target を整数の座標にした');
    return at;
  }
  const id = typeof raw === 'number' ? raw : typeof raw === 'string' && /^#?\d+$/u.test(raw.trim()) ? Number(raw.trim().replace('#', '')) : null;
  if (id !== null && Number.isSafeInteger(id)) {
    if (raw !== `#${id}`) fixes.push(`target を #${id} にした`);
    return `#${id}`;
  }
  if (typeof raw !== 'string' || !raw.trim()) return { problem: 'sight の target は座標か "#id"' };
  const name = raw.trim().replace(/^minecraft:/u, '').toLowerCase();
  const creature = context.creatures.find(item => item.name === name);
  if (!creature) return { problem: `sight の target「${raw.slice(0, 24)}」は近くに見えない（座標か "#id" で）` };
  fixes.push(`target の ${name} を一番近い #${creature.id}（${creature.distance.toFixed(1)}m）にした`);
  return `#${creature.id}`;
}

/** A probe's name in a line (`column 足の列 y=47〜33`, `path→(10,64,-3)`). */
export function probeLabel(input: ProbeInput, feet: ActPos | null = null): string {
  return LABELS[input.kind](input, feet);
}
const LABELS: Readonly<Record<ProbeKind, (input: ProbeInput, feet: ActPos | null) => string>> = {
  path: input => `path→${input.to ? posText(input.to) : '?'}`,
  sight: input => `sight→${typeof input.target === 'string' ? input.target : input.target ? posText(input.target) : '?'}`,
  column: (input, feet) => {
    const own = feet && Math.floor(feet.x) === input.x && Math.floor(feet.z) === input.z;
    return `column ${own ? '足の列' : `(${input.x},${input.z})`} y=${input.yFrom}〜${input.yTo}`;
  },
  around: input => `around ${input.radius ?? 8}m`,
  history: input => `history ${input.at ? posText(input.at) : '足'} ${input.radius ?? 4}m`,
  scan: input => `scan${input.radius ? ` ${input.radius}チャンク` : ''}`,
};

const posList = (value: unknown, limit: number): string[] => (Array.isArray(value) ? value : []).flatMap(item => {
  const at = readPos(plain(item)?.at ?? item);
  return at ? [posText(at)] : [];
}).slice(0, limit);
/**
 * A probe's answer as the decision reads it. `live`: the body's text, with the coordinates a hand can use (a path's points and where to
 * stand, what is between in a sight); else the text and the other fields as JSON (a model's own call, `LLMC_PROBE.toolFieldChars`).
 */
export function probeAnswerText(result: string | undefined, live: boolean): string {
  const read = readProbeResult(result);
  if (!read) return '答えが無い';
  const text = read.text.trim() || '（文なし）';
  const fields = Object.fromEntries(Object.entries(read).filter(([key]) => key !== 'v' && key !== 'kind' && key !== 'text'));
  if (!live) {
    const rest = Object.keys(fields).length ? JSON.stringify(fields) : '';
    return rest ? `${text}\n${rest.length > LLMC_PROBE.toolFieldChars ? `${rest.slice(0, LLMC_PROBE.toolFieldChars)}…（後略）` : rest}` : text;
  }
  const extra = read.kind === 'path' ? pathExtras(fields, text) : read.kind === 'sight' ? sightExtras(fields, text) : [];
  return [text, ...extra].join(' ／ ');
}
/** A path's points (for walk's path), where to stand near the target and the nearest point it reaches, when the text lacks them. */
function pathExtras(fields: Fields, text: string): string[] {
  const points = posList(fields.points, 8), stands = posList(fields.stands, 3), nearest = readPos(plain(fields.nearest)?.at ?? fields.nearest);
  return [...(points.length && !points.every(point => text.includes(point)) ? [`道の点（walk の path に使える）: ${points.join(' ')}`] : []),
    ...(stands.length && !stands.every(point => text.includes(point)) ? [`的の近くに立てる所: ${stands.join(' ')}`] : []),
    ...(nearest && !text.includes(posText(nearest)) ? [`行ける所で一番近い点: ${posText(nearest)}`] : [])];
}
/** What stands between in a sight (at most 4), when the text lacks it. */
function sightExtras(fields: Fields, text: string): string[] {
  const between = (Array.isArray(fields.between) ? fields.between : []).flatMap(item => {
    const entry = plain(item), at = readPos(entry?.at);
    return entry && at ? [{ line: `${typeof entry.name === 'string' ? entry.name : '?'} ${posText(at)}`, at: posText(at) }] : [];
  }).slice(0, 4);
  return between.length && !between.every(item => text.includes(item.at)) ? [`間: ${between.map(item => item.line).join('、')}`] : [];
}

