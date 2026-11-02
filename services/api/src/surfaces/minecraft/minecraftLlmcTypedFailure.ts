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
const PERMISSION_CODE = /^(?:(?:no|missing|denied|lack|need|needs|requires|required)_(?:permission|permit)|(?:permission|permit)(?:_(?:denied|missing|required|blocked|refused))?)$/u;
const PERMISSION_WORDS = /(?:canDig|canPlace)\s*に\s*(?:[a-z][a-z0-9_]*\s*(?:は|が)?\s*)?(?:無い|ない|含まれていない|含まれない|を足)|(?:permission|permit)\s*[:：]?\s*(?:denied|missing|required|refused)|許可(?:が|されて|して)?(?:無い|ない|いない)|許可不足/u;

function failureCode(line: ActHandLine): TypedFailure['code'] | null {
  if (line.status !== 'stopped' && line.status !== 'failed') return null;
  if (line.code === 'gate_required') return null;
  if (line.goal === 'unknown' || line.goal === 'done' || line.goal === 'already' || line.end === 'cut' || line.end === 'not_run') return null;
  if (CREATION.has(line.do) && line.code === 'no_table') return 'no_table';
  if (CREATION.has(line.do) && (line.code === 'missing' || line.code === 'missing_material' || /\bmissing\s*:/u.test(line.line))) return 'lack_material';
  if ((line.do === 'dig' || line.do === 'mine') && (line.code === 'not_visible' || line.code === 'unreachable')) return 'not_visible';
  if (PERMISSION_HANDS.has(line.do) && (PERMISSION_CODE.test(line.code ?? '') || PERMISSION_WORDS.test(line.line))) return 'no_permission';
  return null;
}

/** A body result's line and the frame it was checked against. Evidence preserves the body's words verbatim. */
export function typedFailureOf(line: ActHandLine, observation: BodyObservation | null): TypedFailure | null {
  const checkedAt = failureCheckedAt(observation), code = failureCode(line);
  if (checkedAt === null || !code || typeof line.line !== 'string') return null;
  const evidence = [line.line], candidateArgs: TypedFailure['candidateArgs'] = [];
  const counts = carriedItemCounts(record(observation?.state.world), observation?.facts);
  const suggest = (hand: Record<string, unknown>, why: string) => candidateArgs.push({ hand, verified: false, why });
  if (code === 'no_table') {
    const fact = tableLackFact(observation);
    if (fact) evidence.push(fact);
    const planks = [...counts].filter(([item]) => /_planks$/u.test(item)).reduce((sum, [, count]) => sum + count, 0);
    if (planks >= 4 && !counts.has('crafting_table')) suggest({ do: 'make', item: 'crafting_table', count: 1 },
      `持ち物に板 ${planks}。作成・設置場所・経路は未確認`);
  }
  // An oak-only make chain can fail while other wood is carried. Offer a concrete conversion, never assert substitution or success.
  if (code === 'lack_material' && /\b(?:minecraft:)?oak_log\s*×\s*\d+/u.test(line.line)) {
    for (const [item, count] of counts) {
      const wood = /^(spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|pale_oak)_log$/u.exec(item)?.[1];
      if (wood && count > 0) suggest({ do: 'make', item: `${wood}_planks`, count: 4 }, `持ち物に ${item}×${count}。この板で元の品を作れるかは未確認`);
      if (candidateArgs.length >= 2) break;
    }
  }
  // A look is a candidate to observe the reported stop, not a claim that digging/placing/moving there will work.
  if ((code === 'no_permission' || code === 'not_visible') && line.where &&
      [line.where.x, line.where.y, line.where.z].every(value => typeof value === 'number' && Number.isFinite(value))) {
    suggest({ do: 'look', to: { ...line.where } }, '体が報告した停止位置。見え方・届く足場・掘り置きの許可は未確認');
  }
  return { code, evidence, candidateArgs, cost: {}, checkedAt };
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

/** One to three fact lines. A new frame invalidates all old candidates; historical evidence keeps its observation time. */
export function typedFailureLines(attempt: TypedFailureAttempt, observation: BodyObservation | null,
  previous: readonly TypedFailureAttempt[] = []): string[] {
  const { failure } = attempt;
  const lines = [`失敗 ${failure.code}（観測 ${failure.checkedAt} ms）: ${failure.evidence.join(' / ')}`];
  if (repeatedTypedFailure(attempt, previous)) lines.push('同じ候補はもう試した（同じ code・evidence・観測時刻で、同じ手が再び失敗した）');
  if (failure.checkedAt === failureCheckedAt(observation) && failure.candidateArgs.length) {
    lines.push(`候補: ${failure.candidateArgs.slice(0, 2).map(candidate => `${JSON.stringify(candidate.hand)}（${candidate.verified ?
      '現観測で確認' : '未確認'}: ${candidate.why}）`).join(' / ')}`);
  }
  return lines;
}
