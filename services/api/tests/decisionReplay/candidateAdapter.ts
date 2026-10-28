import { createHash } from 'node:crypto';
import type { BodyObservation } from '../../src/contracts/bodyControlContract.js';
import { actToShort } from '../../src/contracts/minecraftActShortContract.js';
import type { FcaToolDefinition } from '../../src/mind/action/fca/fcaPorts.js';
import { candidateAct, candidateLive, candidateStage, candidateStageState } from '../../src/surfaces/minecraft/minecraftLlmcV2.js';
import { candidateFixed, type CandidateFixed } from '../../src/wiring/minecraftLlmcV2Request.js';
import { CHECK_FORBID } from '../../src/surfaces/minecraft/minecraftFirstPlan.js';
import { contextOf } from './checks.js';
import type { Decision, Entry } from './load.js';
import { frameBefore, type Frames } from './preflightFrames.js';
import { denormalizeMap, progressPlain, rebuiltLive, taskNoteSwap, withNewLastResults, withRoad, withStateWords } from './liveRebuild.js';

/**
 * 候補の版（branch codex/shannon/mb-llmc-cand fdd976c、台の branch は codex/shannon/decision-replay-cand）を台に入れる口。候補の頭が
 * 「記録の live から呼べる純粋な関数」として持つ物をそのまま呼ぶ（`minecraftLlmcV2.ts`・`minecraftLlmcV2Request.ts`）。台が作る近似は 3 つ:
 *  - 履歴: 過去の act は、候補の本番の形（モデルが書いた短い書き方の行）に直して見せる（`actToShort`）。bootstrap（要約 + 直近 8 ラウンドの公開記録）は
 *    本番の形のまま（JSON の手）。
 *  - 守りにかける frame: 直前の act が終わった時の地図と足（なければ判断の live の地図）、体力と敵は live の行（敵の `canSee` は行の「見える／見えない」から）。
 *    本番が持つ「頭が保ってきた柱の答え・sight の答え」（keptColumnFact・keptThreatSight）は台に無い。
 *  - 部分送りの結果: 体が実際に返す結果の行は無いので、「手 1…k-1 は送った」という 1 行と、候補が作る「手 k から先は送っていない」の文を返す。
 */
/**
 * 10/26 mc-sonnet-guards: 点検の節の禁止の決まり（CHECK_FORBID）の台の側の直し。DECISION_REPLAY_FORBID=fixed の時だけ、
 *  - 実走28〜31 の古い計画の木（r7 より前: 禁止の決まりが無い。s47 の原因）の live に、点検の節（planNow が「出発の点検」の道）の禁止の決まりを足す、
 *  - 記録の「受けた時は離れて塞ぐ」を、この木の CHECK_FORBID の文に替える（この木が古い文なら変わらない）。
 * 本番では新しい run の最初の計画がこの文を書く（種の木が CHECK_FORBID を持つ）ので、これは「その run だったら」の写し。
 */
const FORBID_FIXED = process.env.DECISION_REPLAY_FORBID === 'fixed';
const OLD_FORBID_TAIL = '湧き場の前で戦わない。受けた時は離れて塞ぐ';
const NEW_FORBID_TAIL = CHECK_FORBID.slice(CHECK_FORBID.indexOf('湧き場の前で戦わない'));
export const forbidText = (text: string): string => FORBID_FIXED ? text.split(OLD_FORBID_TAIL).join(NEW_FORBID_TAIL) : text;
function withForbid(live: Record<string, any>): Record<string, any> {
  if (!FORBID_FIXED) return live;
  const plan = live.plan as Record<string, any> | undefined;
  const body = live.body as Record<string, any> | undefined;
  if (!plan || !Array.isArray(plan.rules)) return live;
  const rules = (plan.rules as string[]).map(forbidText);
  const now = String(body?.planNow ?? '');
  if (/出発の点検/u.test(now) && !rules.some(rule => /湧き場の前で戦わない/u.test(rule))) {
    const id = /^\[(p\d+)/u.exec(now)?.[1] ?? 'p1';
    rules.push(`禁止（${id}）: ${CHECK_FORBID}`);
  }
  return { ...live, plan: { ...plan, rules } };
}
/**
 * 10/26 mc-task-queue: 列の版（queueLines がある木）の live は、planNow・road・meter の次に `queue`（列の行）を持つ。台は 1 判断ずつなので、
 * 列は「列に項目なし」の 1 行だけを足す（実行中の項目を作り出さない: 記録の判断は前の act の結果が出た後で、その時の列は空だった）。
 * 基準の木（queueLines が無い）は何もしない。
 */
const dynamicQueue = (path: string): Promise<Record<string, any> | null> => import(path).catch(() => null);
const queueWords = await dynamicQueue('../../src/surfaces/minecraft/' + 'minecraftLlmcQueueWords.js');
export const hasQueueTree = !!queueWords?.queueLines;
function withQueue(live: Record<string, any>): Record<string, any> {
  const body = live.body as Record<string, any> | undefined;
  if (!hasQueueTree || !body || body.queue) return live;
  const lines: string[] = queueWords!.queueLines([], null, { progress: null, leftMs: 0 });
  const next: Record<string, any> = {};
  const after = ['meter', 'road', 'planNow'].find(key => key in body);
  for (const [key, value] of Object.entries(body)) {
    next[key] = value;
    if (key === after) next.queue = lines;
  }
  if (!after) next.queue = lines;
  return { ...live, body: next };
}
const fixedCache = new Map<string, Promise<CandidateFixed>>();
/** 要求の固定部分（system 2 ブロックと道具）。run の core（道具の定義）ごとに 1 回。 */
export function candFixed(core: readonly FcaToolDefinition[]): Promise<CandidateFixed> {
  const key = createHash('sha256').update(JSON.stringify(core)).digest('hex').slice(0, 16);
  if (!fixedCache.has(key)) fixedCache.set(key, candidateFixed(core));
  return fixedCache.get(key)!;
}

/**
 * 段の知識（stage）の置き方（06:30 の入口）: live には入れず、保存される状態の 1 つの部 stageKnowledge として、その判断の epoch の履歴の
 * 状態メッセージ（各ラウンドの最初の user の text。stateUpdate が full か changed の JSON）に足す。足すのは、epoch の最初のラウンドと、前のラウンドと
 * stage が違うラウンドだけ（全判断には付けない）。台の場面は 1 判断ずつなので、前のラウンドの stage は、そのラウンドの記録の live から candidateStage で
 * 同じ関数で求める（stage が無い（null）ラウンドは何も足さない = 前の物が立ったまま）。
 */
function stageOf(live: Record<string, unknown>): string | null {
  return candidateStage(live) ?? null;
}
function withStage(entries: readonly Entry[], stage: string, full: boolean): Entry[] {
  const first = entries[0];
  const block = first && Array.isArray(first.content) ? (first.content as Array<Record<string, any>>)[0] : undefined;
  if (first?.role === 'user' && block?.type === 'text' && typeof block.text === 'string') {
    try {
      const state = JSON.parse(block.text) as Record<string, unknown>;
      const next = { ...state, stageKnowledge: stage };
      return [{ ...first, content: [{ ...block, text: JSON.stringify(next) }, ...(first.content as unknown[]).slice(1)] }, ...entries.slice(1)];
    } catch { /* not a JSON state: add a state of its own below */ }
  }
  return [{ role: 'user', content: [{ type: 'text', text: candidateStageState(stage, full) }] }, ...entries];
}
/**
 * 実走36・37（本番 rel41）の記録の live は書き直し済みの形なので、候補の書き直しは「地図から作る欄」を作り直して差し替える（liveRebuild.ts）。
 * 実走27〜34 の記録の live は書き直し前の形で、これまでどおり candidateLive を通す。
 */
function liveOfDecision(live: Record<string, unknown>, tree?: unknown): { live: Record<string, unknown>; notes: unknown; stage: string | null } {
  const rebuilt = rebuiltLive(live as Record<string, any>);
  // 書き直し前の記録の live: 周りの行（止まった手の周り）の取り出しは書き直しの前に（書き直しが座標つきに直す）。
  if (!rebuilt) { const made = candidateLive(withNewLastResults(live as Record<string, any>)); return { ...made, live: withQueue(withForbid(withRoad(withStateWords(made.live as Record<string, any>), tree))) }; }
  return { live: withQueue(withForbid(withRoad(rebuilt, tree))), notes: { rebuilt: true }, stage: candidateStage(live) ?? null };
}
/** 記録の状態メッセージに残る段の知識（本番がその時付けた物）を外す。台が、この木の版の段の知識を付け直す。 */
function withoutStored(entries: readonly Entry[]): Entry[] {
  const swap = taskNoteSwap();
  return entries.map((entry, i) => {
    if (entry.role !== 'user' || !Array.isArray(entry.content)) return entry;
    const blocks = (entry.content as Array<Record<string, any>>).map(block => {
      if (block?.type !== 'text' || typeof block.text !== 'string') return block;
      let text = forbidText(block.text);
      if (swap && text.includes(swap.from)) text = text.split(swap.from).join(swap.to);
      if (!text.includes('"stageKnowledge"') && !text.includes('"progress"')) return text === block.text ? block : { ...block, text };
      try {
        const state = JSON.parse(text) as Record<string, unknown>;
        delete state.stageKnowledge;
        // この版の状態の progress（完了の証明の 1 文）。前の版では何もしない。
        const next = state.progress !== undefined ? { ...state, progress: progressPlain(state.progress) } : state;
        return { ...block, text: JSON.stringify(next) };
      } catch { return text === block.text ? block : { ...block, text }; }
    });
    // 段の知識だけの状態（stateUpdate だけが残る）は、台がこの版の物を付け直すので外す。
    const only = blocks.length === 1 && blocks[0]?.type === 'text' && ['{"stateUpdate":"changed"}', '{"stateUpdate":"full"}'].includes(String(blocks[0].text));
    return only ? null as never : { ...entry, content: blocks };
  }).filter(Boolean);
}
/** 履歴の epoch の rows に、段の知識を足し、過去の act を短い書き方にする。 */
export function candRows(decision: Decision): Entry[][] {
  const rows = decision.run.rows.slice(decision.epochStart, decision.index);
  let previous: string | null = null;
  return rows.map((row, k) => {
    const stage = stageOf(liveOfRow(row.entries));
    const clean = withoutStored(row.entries);
    const entries = stage && (k === 0 || stage !== previous) ? withStage(clean, stage, k === 0) : clean;
    if (stage) previous = stage;
    return candShorten(entries);
  });
}
/** 判断の後ろの入れ替わる部分: 候補の live を JSON にして記録の live の entry と入れ替え、段が変わった時（と epoch の最初）は状態に stageKnowledge を足す。 */
export function candTurn(decision: Decision): { turn: Entry[]; notes: unknown; stage: string | null; stated: boolean } {
  const { live, notes, stage } = liveOfDecision(decision.live, decision.run.tree);
  let turn = withoutStored(decision.turn).map(entry => entry.role === 'system' ? { ...entry, content: JSON.stringify(live) } : entry);
  // その前のラウンドで立っている段（同じ epoch の中で、stage があった最後のラウンド）。
  let previous: string | null = null;
  for (const row of decision.run.rows.slice(decision.epochStart, decision.index)) previous = stageOf(liveOfRow(row.entries)) ?? previous;
  const first = decision.index === decision.epochStart;
  const stated = !!stage && (first || stage !== previous);
  if (stated) turn = withStage(turn, stage!, first);
  return { turn, notes, stage: stage ?? null, stated };
}
function liveOfRow(entries: readonly Entry[]): Record<string, any> {
  const entry = entries.find(item => item.role === 'system');
  const raw = entry?.content;
  const text = typeof raw === 'string' ? raw : Array.isArray(raw) ? (raw as Array<{ text?: string }>).map(block => block.text ?? '').join('') : '';
  try { return JSON.parse(text) as Record<string, any>; } catch { return {}; }
}

/** 履歴の過去の act（assistant の tool_use mc_act）を、候補の短い書き方の行にする。 */
export function candShorten(entries: readonly Entry[]): Entry[] {
  return entries.map(entry => {
    if (entry.role !== 'assistant' || !Array.isArray(entry.content)) return entry;
    return { ...entry, content: (entry.content as Array<Record<string, any>>).map(block => block.type === 'tool_use' && block.name === 'mc_act' && Array.isArray(block.input?.hands)
      && block.input.hands.every((hand: unknown) => hand && typeof hand === 'object') ? { ...block, input: actToShort(block.input) } : block) };
  });
}

/** 守りと stopIf の点検にかける frame（体の frame のうち頭が読む分: localMap・position・health・nearbyThreats）。 */
export function candFrame(decision: Decision, info: Frames): BodyObservation {
  const context = contextOf(decision);
  const frame = frameBefore(info, decision.index, decision.live);
  const body = (decision.live.body ?? {}) as Record<string, any>;
  const lines: string[] = [...(Array.isArray(body.urgent) ? body.urgent : []), ...(Array.isArray(body.unreachable) ? body.unreachable : []), ...(Array.isArray(body.threats) ? body.threats : [])];
  const mine = (id: string) => lines.filter(line => new RegExp(`#${id}(?!\\d)`).test(line));
  const nearbyThreats = context.threats.map(threat => {
    const own = mine(threat.id);
    const canReachMe = own.some(line => /壁の向こうで届かない/u.test(line)) ? false : own.some(line => /見える|道がある|道はある/u.test(line)) ? true : null;
    const canSee = own.some(line => /見える/u.test(line)) ? true : own.some(line => /見えない|壁の向こう/u.test(line)) ? false : null;
    return { id: Number(threat.id), name: threat.name, distance: threat.meters, position: threat.pos, canReachMe, canSee };
  });
  const feet = frame.feet ?? context.self;
  // 記録の live の地図が「そろえた地図」なら、守りが読める層の形に戻す（実走36・37。前の act の結果の地図が無い時の代わり）。
  const mapText = frame.map && frame.from === 'live' ? denormalizeMap(frame.map) ?? frame.map : frame.map;
  return { schemaVersion: 1, bodyId: 'replay', sequence: 0, stateAt: '', receivedAt: '', connected: true, facts: {},
    state: { world: { health: context.hp, position: { x: feet.x + 0.5, y: feet.y, z: feet.z + 0.5 }, ...(mapText ? { localMap: mapText } : {}), ...(Array.isArray(body.stops) ? { recentStops: body.stops } : {}), nearbyThreats } as never } };
}

export { candidateAct };
