import type { Run } from './load.js';
import { resultsByDecision, type Frames } from './preflightFrames.js';
import { decisionOf, loadScenes } from './score.js';

/** 場面（run, epoch, 判断の順に並べる）と、run ごとの結果の結びつき。run2・run3 が使う。 */
const infos = new Map<string, Frames>();
export function frames(runs: Map<string, Run>, key: string): Frames {
  if (!infos.has(key)) infos.set(key, resultsByDecision(runs.get(key)!));
  return infos.get(key)!;
}
export function scenesFor(runs: Map<string, Run>, wanted?: string[]) {
  return loadScenes().filter(scene => !wanted || wanted.includes(scene.id.split('-')[0]!))
    .map(scene => ({ scene, decision: decisionOf(runs, scene) }))
    .sort((a, b) => a.scene.run.localeCompare(b.scene.run) || a.decision.epoch - b.decision.epoch || a.decision.index - b.decision.index);
}
