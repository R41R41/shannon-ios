import type { BodyObservation } from '../../contracts/bodyControlContract.js';
import { readActResult, type ActHandLine } from '../../contracts/minecraftActContract.js';
import { carriedItemCounts } from './minecraftItems.js';
import { tableLackFact } from './minecraftLlmcTableNote.js';

/** Head-only facts and suggestions. No executor, permission change or automatic retry. */
export interface TypedFailure {
  code: 'no_table' | 'no_permission' | 'lack_material' | 'not_visible';
  evidence: string[];
  candidateArgs: Array<{ hand: Record<string, unknown>; verified: boolean; why: string }>;
  cost: { seconds?: number; risk?: 'low' | 'mid' | 'high' };
  checkedAt: number;
}

/** The actual hand, separately from the alternatives that were merely offered. */
export interface TypedFailureAttempt {
  failure: TypedFailure;
  hand: Record<string, unknown> | null;
}

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

/** Body observation time, never the head's wall clock. Invalid/missing frames prove nothing. */
export function failureCheckedAt(observation: BodyObservation | null): number | null {
  if (!observation || !observation.connected) return null;
  const at = Date.parse(observation.stateAt);
  return Number.isFinite(at) ? at : null;
}

const CREATION = new Set(['make', 'craft']);
const PERMISSION_HANDS = new Set(['dig', 'mine', 'place', 'go', 'walk', 'vertical', 'pillarUp']);
// cannot_dig/no_place alone also mean a bad tool, bedrock, a missing face, etc. Only explicit permission evidence counts.
const PERMIT = '(?:permission|permit)';
const PERMIT_STATES = '(?:denied|missing|required|blocked|refused)';
const PERMISSION_CODE = new RegExp(`^(?:(?:no|missing|denied|lack|need|needs|requires|required)_${PERMIT}|${PERMIT}(?:_${PERMIT_STATES})?)$`, 'u');
const PERMISSION_LISTS = /(?:canDig|canPlace)\s*に\s*(?:[a-z][a-z0-9_]*\s*(?:は|が)?\s*)?(?:無い|ない|含まれていない|含まれない|を足)/u;
const PERMISSION_WORDS = new RegExp(`${PERMIT}\\s*[:：]?\\s*${PERMIT_STATES}|許可(?:が|されて|して)?(?:無い|ない|いない)|許可不足`, 'u');
const settled = (line: ActHandLine): boolean => (line.status === 'stopped' || line.status === 'failed') && line.code !== 'gate_required'
  && !['unknown', 'done', 'already'].includes(String(line.goal)) && line.end !== 'cut' && line.end !== 'not_run';
const lacksMaterial = (line: ActHandLine): boolean => line.code === 'missing' || line.code === 'missing_material'
  || /\bmissing\s*:/u.test(line.line);
const permissionStop = (line: ActHandLine): boolean => PERMISSION_CODE.test(line.code ?? '') || PERMISSION_LISTS.test(line.line)
  || PERMISSION_WORDS.test(line.line);

function failureCode(line: ActHandLine): TypedFailure['code'] | null {
  if (!settled(line)) return null;
  if (CREATION.has(line.do)) return line.code === 'no_table' ? 'no_table' : lacksMaterial(line) ? 'lack_material' : null;
  if ((line.do === 'dig' || line.do === 'mine') && (line.code === 'not_visible' || line.code === 'unreachable')) return 'not_visible';
  return PERMISSION_HANDS.has(line.do) && permissionStop(line) ? 'no_permission' : null;
}

type Candidate = TypedFailure['candidateArgs'][number];
const candidate = (hand: Record<string, unknown>, why: string): Candidate => ({ hand, verified: false, why });
const WOODS = /^(spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|pale_oak)_log$/u;

/** With no table carried, four planks make one: offered as a hand, never as a claim that it will be placed or work. */
function tableCandidates(observation: BodyObservation | null, counts: ReadonlyMap<string, number>): Candidate[] {
  const planks = [...counts].filter(([item]) => /_planks$/u.test(item)).reduce((sum, [, count]) => sum + count, 0);
  if (planks < 4 || counts.has('crafting_table')) return [];
  return [candidate({ do: 'make', item: 'crafting_table', count: 1 }, `持ち物に板 ${planks}。作成・設置場所・経路は未確認`)];
}

/** An oak-only make chain can fail while other wood is carried: a concrete conversion is offered, never a claim that it substitutes. */
function woodCandidates(line: ActHandLine, counts: ReadonlyMap<string, number>): Candidate[] {
  if (!/\b(?:minecraft:)?oak_log\s*×\s*\d+/u.test(line.line)) return [];
  const out: Candidate[] = [];
  for (const [item, count] of counts) {
    const wood = WOODS.exec(item)?.[1];
    if (!wood || count < 1) continue;
    out.push(candidate({ do: 'make', item: `${wood}_planks`, count: 4 }, `持ち物に ${item}×${count}。この板で元の品を作れるかは未確認`));
  }
  return out.slice(0, 2);
}

/** A look is a candidate to observe the reported stop, not a claim that digging, placing or moving there will work. */
function lookCandidates(line: ActHandLine): Candidate[] {
  const at = line.where;
  if (!at || ![at.x, at.y, at.z].every(value => typeof value === 'number' && Number.isFinite(value))) return [];
  return [candidate({ do: 'look', to: { ...at } }, '体が報告した停止位置。見え方・届く足場・掘り置きの許可は未確認')];
}

/** A body result's line and the frame it was checked against. Evidence preserves the body's words verbatim. */
export function typedFailureOf(line: ActHandLine, observation: BodyObservation | null): TypedFailure | null {
  const checkedAt = failureCheckedAt(observation), code = failureCode(line);
  if (checkedAt === null || !code || typeof line.line !== 'string') return null;
  const counts = carriedItemCounts(record(observation?.state.world), observation?.facts);
  const fact = code === 'no_table' ? tableLackFact(observation) : null;
  const candidateArgs = code === 'no_table' ? tableCandidates(observation, counts)
    : code === 'lack_material' ? woodCandidates(line, counts) : lookCandidates(line);
  return { code, evidence: fact ? [line.line, fact] : [line.line], candidateArgs, cost: {}, checkedAt };
}

/** Only actual body result lines become attempts. No parsing of a model's explanation or a head guard's prose. */
export function typedFailureAttemptsOf(resultJson: string | undefined, observation: BodyObservation | null, input: unknown): TypedFailureAttempt[] {
  const act = readActResult(resultJson);
  if (!act) return [];
  const hands = record(input)?.hands;
  return act.lines.flatMap(line => {
    if (!record(line)) return [];
    const failure = typedFailureOf(line, observation);
    if (!failure) return [];
    const hand = Array.isArray(hands) && Number.isInteger(line.i) && line.i >= 1 ? record(hands[line.i - 1]) : null;
    return [{ failure, hand: hand?.do === line.do ? hand : null }];
  });
}

/** Compare arguments by value (including nested positions), independent of object key order. */
function sameValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right) && left.length === right.length &&
    left.every((value, index) => sameValue(value, right[index]));
  const a = record(left), b = record(right);
  if (!a || !b) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && sameValue(a[key], b[key]));
}

/** Same premise means the same frame time, code and evidence. Merely displaying an alternative never counts as trying it. */
export function repeatedTypedFailure(attempt: TypedFailureAttempt, previous: readonly TypedFailureAttempt[]): boolean {
  const last = previous.at(-1);
  return !!last && attempt.hand !== null && last.hand !== null && sameValue(last.hand, attempt.hand) &&
    last.failure.checkedAt === attempt.failure.checkedAt && last.failure.code === attempt.failure.code &&
    sameValue(last.failure.evidence, attempt.failure.evidence);
}

const TRIED = '同じ候補はもう試した（同じ code・evidence・観測時刻で、同じ手が再び失敗した）';

/** One to three fact lines. A new frame invalidates all old candidates; historical evidence keeps its observation time. */
export function typedFailureLines(attempt: TypedFailureAttempt, observation: BodyObservation | null,
  previous: readonly TypedFailureAttempt[] = []): string[] {
  const { failure } = attempt;
  const lines = [`失敗 ${failure.code}（観測 ${failure.checkedAt} ms）: ${failure.evidence.join(' / ')}`];
  if (repeatedTypedFailure(attempt, previous)) lines.push(TRIED);
  if (failure.checkedAt === failureCheckedAt(observation) && failure.candidateArgs.length) {
    lines.push(`候補: ${failure.candidateArgs.slice(0, 2).map(candidate => `${JSON.stringify(candidate.hand)}（${candidate.verified ?
      '現観測で確認' : '未確認'}: ${candidate.why}）`).join(' / ')}`);
  }
  return lines;
}
