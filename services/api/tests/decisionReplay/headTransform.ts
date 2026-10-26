import { MC_ACT_TOOL } from '../../src/contracts/minecraftActContract.js';
import type { BodyObservation } from '../../src/contracts/bodyControlContract.js';
import { llmcPrepare } from '../../src/surfaces/minecraft/minecraftLlmc.js';
import { checkedStopIf } from '../../src/surfaces/minecraft/minecraftLlmcStopIf.js';
import { answerOf, contextOf, type Answer } from './checks.js';
import type { Decision } from './load.js';

/**
 * 「頭の変換」: 本番では、モデルの答え（道具の呼び出し）が体へ送られる前に、頭のコードが答えを変える。台はこれまで答えをそのまま採点していた。
 * ここは、本番の `fcaMinecraftTools.ts` の `execute` が mc.act に対してする順番を、記録の live だけで写す。
 *   1. `llmcPrepare`（形を整える `normalizeActInput`。形が合わなければ problem で道具の失敗 = 体へ送らず、モデルに 1 行返る）
 *   2. `checkedStopIf`（r9: 今の体力以上の hpBelow を外す / 待つ手に hostileWithin 4 を足す。直した行は結果の先頭に付く）
 *   （送る前の守り `preflight` は本番で既定 off。候補の版の変換は `candidateTransform` の口から足す）
 * 本番は stopIf の点検を「体が最新に持っている frame」にかける。台には frame が無いので、判断が受け取った live の体力と敵の行から、
 * 点検に要る分（体力・敵の名前・距離・届くか）だけの frame を作る（近似: 判断から実行まで 5〜10 秒のずれは写せない）。
 * 写さない物: `nodeTagged`（why に計画の節の札を付ける）、`fightRefusal`（mc.act には効かない道具名の表）、catalog の変化、lease。
 */
export interface Sent {
  tool: string | null;
  /** 体へ送る入力（変換の後）。 */
  input: unknown;
  /** 変換が答えに足した説明の行（モデルが次に読む）。 */
  fixes: string[];
  /** 形が合わず体へ送れない時の 1 行（この時は道具の失敗）。 */
  problem: string | null;
  /** 変換の前と後で入力が違うか。 */
  changed: boolean;
  /** 候補の守りが止めた時（部分送りの前の手の数を含む）。 */
  guard?: { stopped: boolean; hand?: number; sentHands?: number; code?: string; text?: string };
}

/** 判断の live から、stopIf の点検に要る分だけの frame（体力・敵の名前と距離・届くか）を作る。 */
export function observationOf(decision: Decision): BodyObservation {
  const context = contextOf(decision);
  const body = (decision.live.body ?? {}) as Record<string, any>;
  const lines: string[] = [...(Array.isArray(body.urgent) ? body.urgent : []), ...(Array.isArray(body.unreachable) ? body.unreachable : []), ...(Array.isArray(body.threats) ? body.threats : [])];
  const reach = (id: string): boolean | null => {
    const mine = lines.filter(line => new RegExp(`#${id}(?!\d)`).test(line));
    if (mine.some(line => /壁の向こうで届かない/u.test(line))) return false;
    if (mine.some(line => /見える|道がある|道はある/u.test(line))) return true;
    return null;
  };
  const nearbyThreats = context.threats.map(threat => ({ name: threat.name, distance: threat.meters, canReachMe: reach(threat.id) }));
  return { schemaVersion: 1, bodyId: 'replay', sequence: 0, stateAt: '', receivedAt: '', connected: true, state: { world: { health: context.hp, nearbyThreats } as never }, facts: {} };
}

/** 本番（rel38、3008876 の頭）が mc.act に対してする変換。mc.act でない道具は、形の整えだけ（本番でも `llmcPrepare` が通す物）。 */
export function productionTransform(tool: string | null, raw: unknown, decision: Decision): Sent {
  if (!tool) return { tool, input: raw, fixes: [], problem: '道具の呼び出しが無い', changed: false };
  if (tool !== 'mc.act') return { tool, input: raw, fixes: [], problem: null, changed: false };
  const prepared = llmcPrepare(MC_ACT_TOOL, raw);
  if (prepared.problem) return { tool, input: raw, fixes: prepared.fixes, problem: prepared.problem, changed: false };
  const checked = checkedStopIf(prepared.input, observationOf(decision));
  const fixes = [...prepared.fixes, ...checked.fixes];
  return { tool, input: checked.input, fixes, problem: null, changed: JSON.stringify(checked.input) !== JSON.stringify(raw) };
}

/** 送る入力から採点用の Answer を作る。形の問題は変換の段階で決まっている（送れない形はそのまま ×）。 */
export function answerOfSent(sent: Sent): Answer {
  const content = sent.tool ? [{ type: 'tool_use', name: sent.tool.replace(/^mc\./, 'mc_').replace(/^plan\./, 'plan_'), input: sent.input }] : [];
  const answer = answerOf(content as never);
  return sent.problem ? { ...answer, shapeProblem: sent.problem } : answer;
}

/** 版ごとの変換の表。候補の版は `candidate` の口（`candidateTransform.ts`）から足す。 */
export type Transform = (tool: string | null, raw: unknown, decision: Decision) => Sent | Promise<Sent>;
export const TRANSFORMS: Record<string, Transform> = {
  /** 変換なし（答えをそのまま）。 */
  none: (tool, raw) => ({ tool, input: raw, fixes: [], problem: null, changed: false }),
  production: productionTransform,
};
