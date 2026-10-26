import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { bootstrapFile } from './bootstrap.js';
import { loadAllRuns } from './allRuns.js';
import { candFixed, candRows, candTurn } from './candidateAdapter.js';
import { markCache, sceneMessages } from './request.js';
import { scenesFor } from './sceneSet.js';

/**
 * 回さずに、場面の要求（候補の版の組み立て）をファイルに書く（B の直しの比べ: 基準の木と修正の木で出して、差分を見る）。
 *   DECISION_REPLAY_SCENES_DIR=scenes-b DECISION_REPLAY_BOOTSTRAP_TAG=fix node --import tsx tests/decisionReplay/buildB.ts <out-prefix> [s64,s65]
 */
const [, , prefix, wanted] = process.argv;
const runs = loadAllRuns();
const bootstrapOf = (key: string, epoch: number): string | null => {
  if (epoch === 0) return null;
  const file = bootstrapFile(runs.get(key)!);
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Record<number, string>)[epoch] ?? null : null;
};
for (const { scene, decision } of scenesFor(runs, wanted?.split(','))) {
  const fixed = await candFixed(decision.run.core);
  const { turn } = candTurn(decision);
  const { messages } = sceneMessages(decision, bootstrapOf(decision.run.key, decision.epoch), false, { rows: candRows(decision), turn });
  const body = markCache({ ...fixed.fixed, model: 'claude-opus-5-5', messages } as Record<string, any>, '5m');
  writeFileSync(`${prefix}-${scene.id.split('-')[0]}.json`, JSON.stringify(body, null, 1));
  console.log(scene.id, 'chars', JSON.stringify(body).length, 'system', JSON.stringify(body.system).length, 'tools', JSON.stringify(body.tools).length, 'messages', messages.length);
}
