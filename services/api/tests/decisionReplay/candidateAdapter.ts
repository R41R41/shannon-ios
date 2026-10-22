import { createHash } from 'node:crypto';
import type { BodyObservation } from '../../src/contracts/bodyControlContract.js';
import { actToShort } from '../../src/contracts/minecraftActShortContract.js';
import type { FcaToolDefinition } from '../../src/mind/action/fca/fcaPorts.js';
import { candidateAct, candidateLive } from '../../src/surfaces/minecraft/minecraftLlmcV2.js';
import { candidateFixed, type CandidateFixed } from '../../src/wiring/minecraftLlmcV2Request.js';
import { contextOf } from './checks.js';
import type { Decision, Entry } from './load.js';
import { frameBefore, type Frames } from './preflightFrames.js';

/**
 * 候補の版（branch codex/shannon/mb-llmc-cand fdd976c、台の branch は codex/shannon/decision-replay-cand）を台に入れる口。候補の頭が
 * 「記録の live から呼べる純粋な関数」として持つ物をそのまま呼ぶ（`minecraftLlmcV2.ts`・`minecraftLlmcV2Request.ts`）。台が作る近似は 3 つ:
 *  - 履歴: 過去の act は、候補の本番の形（モデルが書いた短い書き方の行）に直して見せる（`actToShort`）。bootstrap（要約 + 直近 8 ラウンドの公開記録）は
 *    本番の形のまま（JSON の手）。
 *  - 守りにかける frame: 直前の act が終わった時の地図と足（なければ判断の live の地図）、体力と敵は live の行（敵の `canSee` は行の「見える／見えない」から）。
 *    本番が持つ「頭が保ってきた柱の答え・sight の答え」（keptColumnFact・keptThreatSight）は台に無い。
 *  - 部分送りの結果: 体が実際に返す結果の行は無いので、「手 1…k-1 は送った」という 1 行と、候補が作る「手 k から先は送っていない」の文を返す。
 */
const fixedCache = new Map<string, Promise<CandidateFixed>>();
/** 要求の固定部分（system 2 ブロックと道具）。run の core（道具の定義）ごとに 1 回。 */
export function candFixed(core: readonly FcaToolDefinition[]): Promise<CandidateFixed> {
  const key = createHash('sha256').update(JSON.stringify(core)).digest('hex').slice(0, 16);
  if (!fixedCache.has(key)) fixedCache.set(key, candidateFixed(core));
  return fixedCache.get(key)!;
}

/** 判断の後ろの入れ替わる部分: 候補の live を JSON にして、記録の live の entry と入れ替える。 */
export function candTurn(decision: Decision): { turn: Entry[]; notes: unknown } {
  const { live, notes } = candidateLive(decision.live);
  return { turn: decision.turn.map(entry => entry.role === 'system' ? { ...entry, content: JSON.stringify(live) } : entry), notes };
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
  return { schemaVersion: 1, bodyId: 'replay', sequence: 0, stateAt: '', receivedAt: '', connected: true, facts: {},
    state: { world: { health: context.hp, position: { x: feet.x + 0.5, y: feet.y, z: feet.z + 0.5 }, ...(frame.map ? { localMap: frame.map } : {}), nearbyThreats } as never } };
}

export { candidateAct };
