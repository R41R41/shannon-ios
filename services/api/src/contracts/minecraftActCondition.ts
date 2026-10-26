/**
 * The task queue's conditions (design `minebot-task-queue-design-2026-10-26.md` section 4; wire note `tq/contract.md` section 1): what an act's
 * `done` and a queue item's `pre` say. The body reads only the JSON (`ActCondition`); the head parses the model's text into it here and writes it
 * back as text. A condition is alternatives (OR) of conjunctions (AND). Facts only: nothing here picks a block, a place or an action.
 */
export type Dim = 'overworld' | 'the_nether' | 'the_end';
export type ActClause =
  | { k: 'have'; item: string; n: number; op?: '>=' | '<' }
  | { k: 'food'; n: number }
  | { k: 'hunger'; n: number }
  | { k: 'hp'; n: number }
  | { k: 'dim'; dim: Dim }
  | { k: 'at'; x: number; y: number; z: number; r: number; dim?: Dim }
  | { k: 'near'; block: string; r: number }
  | { k: 'free'; n: number }
  | { k: 'time'; t: 'day' | 'night' }
  | { k: 'furnace'; x: number; y: number; z: number }
  | { k: 'safe'; r: number };
export type ActCondition = ActClause[][];

export const CONDITION_MAX_ALTERNATIVES = 4;
export const CONDITION_MAX_CLAUSES = 6;
const DIMENSIONS: Readonly<Record<string, Dim>> = { nether: 'the_nether', the_nether: 'the_nether', end: 'the_end', the_end: 'the_end',
  overworld: 'overworld' };
const DIM_TEXT: Readonly<Record<Dim, string>> = { overworld: 'overworld', the_nether: 'nether', the_end: 'end' };
const ID = /^[a-z][a-z0-9_]{0,63}$/u;
const NUMBER = '-?\\d{1,7}';
const AMOUNT = '\\d{1,5}(?:\\.\\d)?';

/** The flat JSON schema of one condition as the head's `mc.act` input takes it (the wire schema subset: an object of optional fields, `k` required). */
const CLAUSE_SCHEMA = { type: 'object', additionalProperties: false, required: ['k'], properties: {
  k: { type: 'string', enum: ['have', 'food', 'hunger', 'hp', 'dim', 'at', 'near', 'free', 'time', 'furnace', 'safe'] },
  item: { type: 'string', maxLength: 64 }, block: { type: 'string', maxLength: 64 }, op: { type: 'string', enum: ['>=', '<'] },
  n: { type: 'number', minimum: 0, maximum: 100000 }, r: { type: 'number', minimum: 0, maximum: 1000 },
  x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' },
  dim: { type: 'string', enum: ['overworld', 'the_nether', 'the_end'] }, t: { type: 'string', enum: ['day', 'night'] },
} } as const;
export const CONDITION_SCHEMA = Object.freeze({ type: 'array', minItems: 1, maxItems: CONDITION_MAX_ALTERNATIVES,
  items: { type: 'array', minItems: 1, maxItems: CONDITION_MAX_CLAUSES, items: CLAUSE_SCHEMA } });

type Check = (value: unknown) => boolean;
const finite: Check = value => typeof value === 'number' && Number.isFinite(value);
const between = (low: number, high: number): Check => value => finite(value) && (value as number) >= low && (value as number) <= high;
const whole = (low: number, high: number): Check => value => Number.isInteger(value) && (value as number) >= low && (value as number) <= high;
const id: Check = value => typeof value === 'string' && ID.test(value);
const dimension: Check = value => value === 'overworld' || value === 'the_nether' || value === 'the_end';
/** Each kind's fields: the required ones, then the optional ones (the body's strict shape). */
const SHAPES: Readonly<Record<string, { need: Readonly<Record<string, Check>>; may?: Readonly<Record<string, Check>> }>> = {
  have: { need: { item: id, n: whole(0, 100_000) }, may: { op: value => value === '>=' || value === '<' } },
  food: { need: { n: whole(0, 100_000) } },
  hunger: { need: { n: between(0, 20) } },
  hp: { need: { n: between(0, 20) } },
  dim: { need: { dim: dimension } },
  at: { need: { x: finite, y: finite, z: finite, r: between(0, 1000) }, may: { dim: dimension } },
  near: { need: { block: id, r: between(1, 8) } },
  free: { need: { n: whole(0, 36) } },
  time: { need: { t: value => value === 'day' || value === 'night' } },
  furnace: { need: { x: finite, y: finite, z: finite } },
  safe: { need: { r: between(1, 64) } },
};
const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function validClause(value: unknown): value is ActClause {
  if (!plain(value) || typeof value.k !== 'string') return false;
  const shape = SHAPES[value.k];
  if (!shape) return false;
  const may = shape.may ?? {};
  const keys = Object.keys(value).filter(key => key !== 'k');
  return keys.every(key => key in shape.need || key in may) && Object.entries(shape.need).every(([key, check]) => check(value[key]))
    && Object.entries(may).every(([key, check]) => value[key] === undefined || check(value[key]));
}
/** Whether the value is a well formed condition (the body's strict shape: no unknown key, ranges as the body reads them). */
export function validCondition(value: unknown): value is ActCondition {
  return Array.isArray(value) && value.length >= 1 && value.length <= CONDITION_MAX_ALTERNATIVES
    && value.every(alternative => Array.isArray(alternative) && alternative.length >= 1 && alternative.length <= CONDITION_MAX_CLAUSES
      && alternative.every(validClause));
}

/** The forms the model may write, one per kind (what a refusal offers). */
export const CONDITION_FORMS: Readonly<Record<string, string>> = {
  have: 'have:raw_iron>=3 / have:log / have:bucket<1', food: 'food>=20', hunger: 'hunger>=18', hp: 'hp>=15', dim: 'dim:nether',
  at: 'at:26,51,7~2', near: 'near:furnace~4', free: 'free>=6', time: 'time:night', furnace: 'furnace:10,64,5', safe: 'safe~12',
};
const FORMS = 'have:物>=n（物は id か id の終わり）・food>=n・hunger>=n・hp>=n・dim:nether・at:x,y,z~r・near:ブロック~r（r は 8 まで）・free>=n・time:day か night・furnace:x,y,z・safe~r。'
  + '& で「かつ」、| で「または」';

const plainDim = (name: string | undefined): Dim | null | undefined => name === undefined ? undefined : (DIMENSIONS[name] ?? null);
type Reader = (match: RegExpExecArray) => ActClause | null;
const READERS: ReadonlyArray<[RegExp, Reader]> = [
  [new RegExp(`^have:([a-z][a-z0-9_]{0,63})(?:(>=|<)(\\d{1,5}))?$`, 'u'),
    m => ({ k: 'have', item: m[1]!, n: m[3] === undefined ? 1 : Number(m[3]), ...(m[2] === '<' ? { op: '<' as const } : {}) })],
  [new RegExp(`^food>=(${AMOUNT})$`, 'u'), m => ({ k: 'food', n: Number(m[1]) })],
  [new RegExp(`^hunger>=(${AMOUNT})$`, 'u'), m => ({ k: 'hunger', n: Number(m[1]) })],
  [new RegExp(`^hp>=(${AMOUNT})$`, 'u'), m => ({ k: 'hp', n: Number(m[1]) })],
  [/^dim:([a-z_]{1,16})$/u, m => DIMENSIONS[m[1]!] ? { k: 'dim', dim: DIMENSIONS[m[1]!]! } : null],
  [new RegExp(`^at:\\(?(${NUMBER}),(${NUMBER}),(${NUMBER})\\)?(?:~(\\d{1,4}))?(?:@([a-z_]{1,16}))?$`, 'u'), m => {
    const dim = plainDim(m[5]);
    return dim === null ? null : { k: 'at', x: Number(m[1]), y: Number(m[2]), z: Number(m[3]), r: Number(m[4] ?? 4), ...(dim ? { dim } : {}) };
  }],
  [/^near:([a-z][a-z0-9_]{0,63})(?:~(\d{1,2}))?$/u, m => ({ k: 'near', block: m[1]!, r: Number(m[2] ?? 4) })],
  [/^free>=(\d{1,2})$/u, m => ({ k: 'free', n: Number(m[1]) })],
  [/^time:(day|night)$/u, m => ({ k: 'time', t: m[1] as 'day' | 'night' })],
  [new RegExp(`^furnace:\\(?(${NUMBER}),(${NUMBER}),(${NUMBER})\\)?$`, 'u'), m => ({ k: 'furnace', x: Number(m[1]), y: Number(m[2]), z: Number(m[3]) })],
  [/^safe~(\d{1,2})$/u, m => ({ k: 'safe', r: Number(m[1]) })],
];
/** One clause from its text, or null when it is none of the forms (or a value out of range). */
export function parseClause(text: string): ActClause | null {
  for (const [pattern, read] of READERS) {
    const match = pattern.exec(text);
    if (!match) continue;
    const clause = read(match);
    return clause && validClause(clause) ? clause : null;
  }
  return null;
}
const NEW_KINDS = new Set(['hp', 'hunger', 'free', 'time']);
/** A clause of the forms a plan node's `doneWhen` did not have before (`hp>=`, `hunger>=`, `free>=`, `time:`, `have:x<n`), or null. */
export function newerClause(text: string): ActClause | null {
  const clause = parseClause(text);
  return clause && (NEW_KINDS.has(clause.k) || (clause.k === 'have' && clause.op === '<')) ? clause : null;
}

/** The form to suggest for an unreadable clause: its own kind's when its start names one, else none. */
function suggestion(bad: string): string {
  const key = /^([a-z]+)/u.exec(bad)?.[1];
  if (key && CONDITION_FORMS[key]) return CONDITION_FORMS[key]!;
  if (/かまど|furnace/u.test(bad)) return CONDITION_FORMS.near!;
  return '';
}
export type ParsedCondition = { ok: true; condition: ActCondition } | { ok: false; problem: string };
/**
 * The condition a text is, or one Japanese line naming the part that does not read and the form to write instead
 * (「pre の書き方の誤り: 『かまどが近い』は読めない。使える形: near:furnace~4」). `label` names the field in the line.
 */
export function parseCondition(text: string, label = '条件'): ParsedCondition {
  const compact = text.replace(/\s+/gu, '').toLowerCase();
  const fail = (bad: string, why = '読めない'): ParsedCondition => {
    const near = suggestion(bad);
    return { ok: false, problem: `${label} の書き方の誤り: 『${bad.slice(0, 40)}』は${why}。使える形: ${near ? `${near}（全部の形: ${FORMS}）` : FORMS}`.slice(0, 600) };
  };
  if (!compact) return fail(text.trim() || '（空）');
  if (compact.length > 160) return fail(compact, '長すぎる');
  const condition: ActCondition = [];
  for (const part of compact.split('|')) {
    const clauses: ActClause[] = [];
    for (const piece of part.split('&')) {
      const clause = parseClause(piece);
      if (!clause) return fail(piece || part);
      clauses.push(clause);
    }
    condition.push(clauses);
  }
  if (condition.length > CONDITION_MAX_ALTERNATIVES || condition.some(alternative => alternative.length > CONDITION_MAX_CLAUSES)) {
    return fail(compact, `多すぎる（「または」は ${CONDITION_MAX_ALTERNATIVES} つ、「かつ」は ${CONDITION_MAX_CLAUSES} つまで）`);
  }
  return { ok: true, condition };
}

type Writers = { [K in ActClause['k']]: (clause: Extract<ActClause, { k: K }>) => string };
const WRITERS: Writers = {
  have: c => c.op === '<' ? `have:${c.item}<${c.n}` : c.n === 1 ? `have:${c.item}` : `have:${c.item}>=${c.n}`,
  food: c => `food>=${c.n}`,
  hunger: c => `hunger>=${c.n}`,
  hp: c => `hp>=${c.n}`,
  dim: c => `dim:${DIM_TEXT[c.dim]}`,
  at: c => `at:${c.x},${c.y},${c.z}~${c.r}${c.dim ? `@${DIM_TEXT[c.dim]}` : ''}`,
  near: c => `near:${c.block}~${c.r}`,
  free: c => `free>=${c.n}`,
  time: c => `time:${c.t}`,
  furnace: c => `furnace:${c.x},${c.y},${c.z}`,
  safe: c => `safe~${c.r}`,
};
/** The clause as the model writes it. */
export const clauseText = (clause: ActClause): string => (WRITERS[clause.k] as (clause: ActClause) => string)(clause);
/** The condition in its compact text (parses back to the same condition). */
export function conditionText(condition: ActCondition): string {
  return condition.map(clauses => clauses.map(clauseText).join('&')).join('|');
}
