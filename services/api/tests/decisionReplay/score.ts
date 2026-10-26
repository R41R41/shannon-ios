import { readdirSync, readFileSync } from 'node:fs';
import { answerOf, contextOf, repeatsStop, runCheck, stopIfFixes, walksIntoBlock, type Answer, type Check, type Context } from './checks.js';
import { decisions, type Decision, type Run } from './load.js';

/**
 * 場面のファイル（scenes/*.json）。ライ氏が見て直せるように、正しい手の条件は文で書き、機械で決まる所だけ検査の名前で書く。
 * - must: 外れたら × （正しい手がしてはいけないこと）。
 * - want: 全部通れば ○ （正しい手がしていること）。外れた・書いていない場面は、後知恵つきの Opus の採点（judge.ts）が決める。
 * - 自動の検査（どの場面にも）: 体に送れる形・同じ止まりのくり返し・塞がったマス／床の無いマスへ歩く手。外れたら ×。
 */
export interface SceneFile {
  id: string; run: string; seq: number;
  /** stopped（直前に止まった）, urgent（近い敵・急ぎ）, death（死の直前）, progress（ふつうに進む）, plan（計画の節の変わり目） */
  category: string[];
  title: string; situation: string; correct: string; hindsight: string;
  must?: Array<{ id: string; why: string; check: Check }>;
  want?: Array<{ id: string; why: string; check: Check }>;
  /** undecided（既定: 検査で決まらない時だけ judge）, always（必ず judge）, never（検査だけ） */
  judge?: 'undecided' | 'always' | 'never';
  /** 自動の検査を切る（理由を note に）。 */
  auto?: { repeat?: boolean; walk?: boolean }; note?: string;
}
/** 場面のファイルの置き場所。既定は scenes/（60 場面）、DECISION_REPLAY_SCENES_DIR=scenes-b で B の直しの比べの場面。 */
export const scenesDir = new URL(`./${process.env.DECISION_REPLAY_SCENES_DIR ?? 'scenes'}/`, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
export function loadScenes(dir = scenesDir): SceneFile[] {
  return readdirSync(dir).filter(name => name.endsWith('.json')).sort().map(name => JSON.parse(readFileSync(`${dir}${name}`, 'utf8')) as SceneFile);
}
export function decisionOf(runs: Map<string, Run>, scene: SceneFile): Decision {
  const run = runs.get(scene.run);
  const found = run && decisions(run).find(item => item.row.seq === scene.seq);
  if (!found) throw new Error(`DECISION_REPLAY_SCENE_NOT_FOUND ${scene.id}`);
  return found;
}

export type Verdict = '○' | '△' | '×' | '?';
export interface Score {
  verdict: Verdict; by: 'check' | 'pending';
  failed: string[]; passed: string[];
  /** 本番ではコードが直して送る stopIf の不備（数えるだけ）。 */
  stopIfFixes: string[];
  whyTag: boolean;
}

/** 答えを場面の検査にかける。検査で決まらなければ verdict は '?'（judge に回す）。 */
export function scoreAnswer(scene: SceneFile, context: Context, answer: Answer): Score {
  const failed: string[] = [], passed: string[] = [];
  if (!answer.tool) failed.push('道具の呼び出しが無い');
  else if (answer.shapeProblem) failed.push(`体に送れない形: ${answer.shapeProblem.slice(0, 80)}`);
  else passed.push('体に送れる形');
  if (scene.auto?.repeat !== false && answer.tool === 'mc.act') {
    const repeated = repeatsStop(answer, context);
    if (repeated) failed.push(`同じ止まりのくり返し: ${repeated}`); else passed.push('止まった手をくり返さない');
  }
  if (scene.auto?.walk !== false && answer.tool === 'mc.act') {
    const blocked = walksIntoBlock(answer, context);
    if (blocked) failed.push(`塞がったマスへ歩く: ${blocked}`); else passed.push('歩く先は塞がっていない');
  }
  for (const item of scene.must ?? []) {
    const result = runCheck(item.check, answer, context);
    if (result.pass) passed.push(item.id); else failed.push(`${item.id}: ${item.why}（${result.detail}）`);
  }
  const flags = { stopIfFixes: answer.tool === 'mc.act' ? stopIfFixes(answer, context) : [], whyTag: answer.tool === 'mc.act' ? runCheck({ kind: 'whyTag' }, answer, context).pass : true };
  if (failed.length) return { verdict: '×', by: 'check', failed, passed, ...flags };
  const wants = scene.want ?? [];
  const results = wants.map(item => ({ item, result: runCheck(item.check, answer, context) }));
  for (const { item, result } of results) if (result.pass) passed.push(item.id);
  const allWanted = wants.length > 0 && results.every(entry => entry.result.pass);
  if ((scene.judge ?? 'undecided') !== 'always' && allWanted) return { verdict: '○', by: 'check', failed, passed, ...flags };
  if (scene.judge === 'never') return { verdict: wants.length === 0 ? '○' : '△', by: 'check', failed, passed, ...flags };
  return { verdict: '?', by: 'pending', failed, passed, ...flags };
}

export { answerOf, contextOf };
