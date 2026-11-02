import { applyPlanUpdate, type PlanOp, type PlanUpdate } from '@shannon/mind';
import type { FcaPlanInbox } from '../../mind/action/fca/fcaPlanTools.js';
import { PLAN_UPDATE_RULES_DEFINITION } from '../../mind/action/fca/fcaPlanTools.js';

/**
 * The plan made again when the body stands still (owner 2026-11-02: a run of two to four hours cannot wait for a person at every stop).
 * The head's look for a task that is not held (`minecraftLlmcWatch.ts`) finds the stall; the strong model is asked once, with a short brief
 * that holds no history (`minecraftLlmcReplanBrief.ts`), for the ops of a `plan.update`; the head applies them at the next read of the plan.
 * It is bounded in time, count and tries, and every attempt counts, an answer or not:
 * - at least `gapMs` of the task's running time between two, `perHour` in any hour, `perRun` in the whole run;
 * - `perNode` for one plan node: past it the stall is told to the decision as a fact (the node did not move after that many new plans), and
 *   the decision chooses; the head blocks nothing by itself.
 * A hold is kept for the results nobody knows and for the body's and the head's disagreement on who holds the body.
 */
export const REPLAN = Object.freeze({ gapMs: 10 * 60_000, perHour: 6, perRun: 30, perNode: 3, briefTokens: 8_000, giveUpMs: 120_000, outputTokens: 5_000 });

/** The stalls a new plan answers; a failure of the decision's writing is not one. */
export const REPLAN_STALLS: ReadonlySet<string> = new Set(['node_stalled', 'same_spot_stops', 'wait_loop', 'death']);

export interface ReplanRecord {
  /** The task's running clock (ms) when it was asked. */
  at: number;
  node: string;
  kind: string;
  /** What came of it: `changed`, `unchanged` (the strong model changed nothing), `refused` (the plan would not take it), `failed` (no answer). */
  outcome: 'changed' | 'unchanged' | 'refused' | 'failed';
  why: string;
}
export interface ReplanLedger {
  v: 1;
  total: number;
  /** The clock of each attempt in the last hour. */
  recent: number[];
  /** Attempts for each plan node. */
  nodes: Record<string, number>;
  /** The newest three, for the next brief. */
  last: ReplanRecord[];
}
const HOUR_MS = 60 * 60_000;
const OUTCOMES: ReadonlySet<string> = new Set(['changed', 'unchanged', 'refused', 'failed']);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

function recordOf(raw: unknown): ReplanRecord | null {
  const item = raw && typeof raw === 'object' ? raw as Record<string, unknown> : null;
  if (!item || !finite(item.at) || typeof item.node !== 'string' || typeof item.kind !== 'string' || typeof item.why !== 'string') return null;
  return typeof item.outcome === 'string' && OUTCOMES.has(item.outcome)
    ? { at: item.at, node: item.node.slice(0, 32), kind: item.kind.slice(0, 24), outcome: item.outcome as ReplanRecord['outcome'],
      why: item.why.slice(0, 120) } : null;
}

/** The ledger a checkpoint held, read with care: anything malformed is an empty ledger. */
export function readReplanLedger(saved: unknown): ReplanLedger {
  const raw = saved && typeof saved === 'object' ? saved as Record<string, unknown> : null;
  const nodes = raw?.nodes && typeof raw.nodes === 'object' && !Array.isArray(raw.nodes) ? raw.nodes as Record<string, unknown> : {};
  if (raw?.v !== 1 || !finite(raw.total)) return { v: 1, total: 0, recent: [], nodes: {}, last: [] };
  return { v: 1, total: Math.max(0, Math.floor(raw.total)), recent: (Array.isArray(raw.recent) ? raw.recent : []).filter(finite).slice(-REPLAN.perHour * 2),
    nodes: Object.fromEntries(Object.entries(nodes).filter((entry): entry is [string, number] => finite(entry[1])).slice(0, 64)),
    last: (Array.isArray(raw.last) ? raw.last : []).map(recordOf).filter((item): item is ReplanRecord => item !== null).slice(-3) };
}

export type ReplanVerdict = { ok: true } | { ok: false; why: 'gap' | 'hour' | 'run' | 'node' };

/** Whether another plan may be asked for now (`nowMs`: the task's running clock) for a stall at `node`. */
export function replanVerdict(ledger: ReplanLedger, node: string, nowMs: number): ReplanVerdict {
  if (ledger.total >= REPLAN.perRun) return { ok: false, why: 'run' };
  if ((ledger.nodes[node] ?? 0) >= REPLAN.perNode) return { ok: false, why: 'node' };
  const recent = ledger.recent.filter(at => nowMs - at < HOUR_MS);
  if (recent.length >= REPLAN.perHour) return { ok: false, why: 'hour' };
  const last = recent.at(-1);
  return last !== undefined && nowMs - last < REPLAN.gapMs ? { ok: false, why: 'gap' } : { ok: true };
}

/** The ledger with one more attempt (an attempt counts whether or not an answer came). */
export function withAttempt(ledger: ReplanLedger, record: ReplanRecord): ReplanLedger {
  return { v: 1, total: ledger.total + 1, recent: [...ledger.recent.filter(at => record.at - at < HOUR_MS), record.at],
    nodes: { ...ledger.nodes, [record.node]: (ledger.nodes[record.node] ?? 0) + 1 }, last: [...ledger.last, record].slice(-3) };
}

/** The newest attempt with what came of it (it was counted when it was asked). */
export function settledAttempt(ledger: ReplanLedger, record: ReplanRecord): ReplanLedger {
  return { ...ledger, last: [...ledger.last.slice(0, -1), record] };
}

/** The ops the strong model may write: the plan's own, without the promises (a new plan does not move what was set aside). */
const ALLOWED_OPS: ReadonlySet<string> = new Set(['add', 'split', 'set', 'move', 'drop', 'forbid', 'caution', 'lift']);
const BASE = PLAN_UPDATE_RULES_DEFINITION.nativeInputSchema as { properties: { ops: { items: { properties: Record<string, unknown> } }; current: unknown } };
const ITEM = BASE.properties.ops.items;

/** The answer's schema: the plan tool's ops and current node, and a line saying what was changed and why. */
export const REPLAN_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['ops', 'why'],
  properties: {
    ops: { type: 'array', maxItems: 12, items: { ...ITEM, properties: { ...ITEM.properties, op: { type: 'string', enum: [...ALLOWED_OPS] } } } },
    current: BASE.properties.current,
    why: { type: 'string', maxLength: 120, description: '何を直したか、またはなぜ直さないか（120 字まで）' },
  },
});

/** The ops and the line of an answer; null when it is not one. An empty list of ops is an answer: the strong model found nothing to change. */
export function replanOf(answer: unknown): { update: PlanUpdate; why: string } | null {
  const value = answer && typeof answer === 'object' ? answer as Record<string, unknown> : null;
  if (!value || !Array.isArray(value.ops) || value.ops.length > 12) return null;
  const ops = value.ops.filter((item): item is PlanOp => !!item && typeof item === 'object' && ALLOWED_OPS.has(String((item as { op?: unknown }).op)));
  if (ops.length !== value.ops.length) return null;
  const current = typeof value.current === 'string' && value.current ? value.current : undefined;
  const why = typeof value.why === 'string' ? value.why.replace(/\s+/gu, ' ').trim().slice(0, 120) : '';
  return { update: { ops, ...(current ? { current } : {}) }, why };
}

// ---- the plans waiting to be taken, by task
const waiting = new Map<string, { update: PlanUpdate; why: string }>();

/** A new plan for the task, taken at its next read of the plan. */
export function putReplan(taskId: string, update: PlanUpdate, why: string): void {
  waiting.delete(taskId);
  waiting.set(taskId, { update, why });
  if (waiting.size > 32) waiting.delete(waiting.keys().next().value as string);
}

/** The plan inbox of a task with this one beside the first plan's: the first plan is taken first, a new plan after it. */
export function withReplanInbox(first: FcaPlanInbox, log: (line: string) => void = () => undefined): FcaPlanInbox {
  return {
    take(taskId, held) {
      const asked = first.take(taskId, held);
      if (asked) return asked;
      const entry = waiting.get(taskId);
      if (!entry) return null;
      waiting.delete(taskId);
      const made = applyPlanUpdate(held, entry.update, { at: new Date().toISOString() });
      if (made.problem || !made.changed) {
        log(`Shannon Minecraft replan not taken task=${taskId} ${made.problem ? made.problem.slice(0, 100) : 'no change'}`);
        return null;
      }
      return { tree: made.tree, note: `計画を立て直した（強いモデル）: ${entry.why || '理由なし'}` };
    },
  };
}

/** For tests: no task has a new plan waiting. */
export function forgetReplans(): void {
  waiting.clear();
}

/** The instructions of the strong model that makes the plan again (the same for every request). */
export const REPLAN_SYSTEM = [
  'あなたはマイクラの体を動かすシャノンの、計画の立て直し係。毎歩の判断は別のモデルがしていて、今、体が止まっている（止まりの理由が入力にある）。',
  '原因を事実から考え、計画だけを直す。出すのは plan.update の ops（12 個まで）と、今の節にしたい id（current。変えないなら省く）と、何を直したかの一行（why）。体の手は出さない。',
  '- ops の書き方（plan.update と同じ）: add（parent・after・title・where・doneWhen・target・note・kind。id は書かない）、split（id の下に into の節を足す）、'
    + 'set（id の state=done|blocked|continue|wait・title・where・doneWhen・target・note・reason・kind）、move（id を parent・after へ）、drop（id とその下を消す）、'
    + 'forbid / caution（id の節に text を 1 行足す）、lift（text の行を消す）。id は入力の計画に出ている物。節は 64 まで・深さ 4 まで・title 60 字まで。',
  '- 止まりの原因が「見えていない事実」か「足りない前提」かを考える。計画を、観測で確かめられる小さな節に割る・前提の節を足す・順を変える・別の手段の節に替える・できない節を blocked にして理由と代わりの道を書く。',
  '- doneWhen は観測の形で書く: have:物>=数・food>=点・dim:the_nether|the_end|overworld・at:x,y,z~半径@次元・'
    + 'see:fortress / see:end_portal_frame / see:end_portal・crystals<=n。& が全部、| がどれか。target は完成品を取る節にだけ。',
  '- 座標は入力にある物だけを使う。無い場所を作らない。時間や許可を増やすだけの直しはしない。同じ直しを繰り返さない（前の立て直しが入力にある）。',
  '- 準備の節（prep_descent）を黙って飛ばさない。省くなら prep skipped と why を書く。済んでいない節を done にしない。',
  '- 原因が分かったら、今の節に forbid（してはいけない事）か caution（気をつける事）を 1 行足すと、次の判断が読む。',
  '- 止まりに見えて本当は進行中の待ち（夜待ち・かまど・ブレイズの湧き待ち・竜の止まり待ち）なら、ops を空にして、why にそう書く。',
].join('\n');
