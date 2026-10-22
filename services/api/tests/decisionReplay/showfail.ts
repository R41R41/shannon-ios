import { readFileSync } from 'node:fs';
import { candidatesOf, answerText } from './judge.js';
import { loadRuns } from './load.js';
import { decisionOf, loadScenes } from './score.js';
import type { ResultRow } from './run.js';
const p = (name: string) => new URL(`./data/${name}`, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const runs = loadRuns(p('export1.txt'), p('journal.txt'));
const rows = readFileSync(p('results.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as ResultRow);
const want = process.argv.slice(2);
for (const scene of loadScenes().filter(item => want.includes(item.id.slice(0, 3)))) {
  for (const item of candidatesOf(scene, decisionOf(runs, scene), rows)) {
    if (item.score.verdict !== '×') continue;
    console.log(`--- ${scene.id} ${item.key}\n${answerText(item.answer)}\nFAIL: ${item.score.failed.join(' | ')}`);
  }
}
