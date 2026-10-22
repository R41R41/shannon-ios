import { answerOf, contextOf, decisionOf, loadScenes, scoreAnswer } from './score.js';
import { loadRuns } from './load.js';

/** 本番で実際に出た答え（DB の履歴）を場面の検査にかける。検査が本番の誤りを拾うか、正しい手を通すかの確かめ。 */
const p = (name: string) => new URL(`./data/${name}`, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const runs = loadRuns(p('export1.txt'), p('journal.txt'));
for (const scene of loadScenes()) {
  const decision = decisionOf(runs, scene);
  const context = contextOf(decision);
  const answer = answerOf(decision.assistant ? (decision.assistant.content as never) : []);
  const score = scoreAnswer(scene, context, answer);
  console.log(`${scene.id.padEnd(40)} ${score.verdict} ${score.by.padEnd(7)} ${answer.tool} hands=${answer.hands.length} ${score.failed.join(' | ').slice(0, 170)}`);
}
