import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { actToShort } from '../../src/contracts/minecraftActShortContract.js';
import { isUrgentLive, candidateAct } from '../../src/surfaces/minecraft/minecraftLlmcV2.js';
import { bootstrapFile } from './bootstrap.js';
import { loadAllRuns, dataFile } from './allRuns.js';
import { answerOf } from './checks.js';
import { candFixed, candFrame, candRows, candTurn } from './candidateAdapter.js';
import { markCache, sceneMessages } from './request.js';
import { frames, scenesFor } from './sceneSet.js';

/**
 * 回帰の確かめ（API を使わない）: 場面ごとに、この木の版の要求を組み（system・道具・live・履歴・段の知識）、記録の本番の答えを候補の頭（candidateAct: 戻し・形・stopIf・守り）に通して、
 * 要求の文字数・live の文字数・段・答えの通り方を data/<out> に書く。基準の木と修正の木で出して、compareB.ts で並べる。
 *   [DECISION_REPLAY_SCENES_DIR=scenes-b] node --import tsx tests/decisionReplay/offlineB.ts <out.json> [s01,s02]
 */
const [, , outName, wanted] = process.argv;
const runs = loadAllRuns();
const bootstrapOf = (key: string, epoch: number): string | null => {
  if (epoch === 0) return null;
  const file = bootstrapFile(runs.get(key)!);
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Record<number, string>)[epoch] ?? null : null;
};
const result: Record<string, unknown> = {};
for (const { scene, decision } of scenesFor(runs, wanted?.split(','))) {
  const id = scene.id.split('-')[0]!;
  try {
    const fixed = await candFixed(decision.run.core);
    const { turn, stage, stated } = candTurn(decision);
    const rows = candRows(decision);
    const { messages } = sceneMessages(decision, bootstrapOf(decision.run.key, decision.epoch), false, { rows, turn });
    const body = markCache({ ...fixed.fixed, model: 'claude-opus-5-5', messages } as Record<string, any>, '5m');
    const live = turn.find(entry => entry.role === 'system');
    const prod = answerOf((decision.assistant?.content ?? []) as never);
    let act: Record<string, unknown> | null = null;
    if (prod.tool === 'mc.act' && prod.shapeProblem === null) {
      try {
        const raw = actToShort(prod.input);
        const done = candidateAct(raw, candFrame(decision, frames(runs, decision.run.key)), `offline-${id}`, { urgent: isUrgentLive(decision.live) });
        act = { problem: done.problem, fixes: done.fixes.length, guard: done.guard ? { stopped: done.guard.stopped, hand: done.guard.hand, code: done.guard.code } : null, hands: Array.isArray((done.input as { hands?: unknown[] })?.hands) ? (done.input as { hands: unknown[] }).hands.length : null };
      } catch (error) { act = { error: String(error).slice(0, 160) }; }
    }
    result[id] = { id: scene.id, chars: JSON.stringify(body).length, system: JSON.stringify(body.system).length, tools: JSON.stringify(body.tools).length, live: live ? JSON.stringify(live.content).length : 0,
      stage: stage ? stage.split('\n')[0] : null, stated, messages: messages.length, act };
  } catch (error) { result[id] = { id: scene.id, error: String(error).slice(0, 200) }; }
}
writeFileSync(dataFile(outName!), JSON.stringify(result, null, 1));
console.log('wrote', outName, Object.keys(result).length);
