import { readFileSync } from 'node:fs';
import { candidatesOf } from './judge.js';
import { loadRuns } from './load.js';
import { decisionOf, loadScenes } from './score.js';
import type { ResultRow } from './run.js';

/** × になった答えを、理由の種類ごとに数える（検査が本当に誤りを拾っているかの見直し用）。 */
const p = (name: string) => new URL(`./data/${name}`, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const runs = loadRuns(p('export1.txt'), p('journal.txt'));
const rows = readFileSync(p('results.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as ResultRow);
const count = new Map<string, number>();
for (const scene of loadScenes()) {
  for (const item of candidatesOf(scene, decisionOf(runs, scene), rows)) {
    if (item.score.verdict !== '×') continue;
    for (const reason of item.score.failed) {
      const kind = reason.split(/[:（(]/)[0]!.slice(0, 40);
      const key = `${item.variant}\t${scene.id.slice(0, 3)}\t${kind}`;
      count.set(key, (count.get(key) ?? 0) + 1);
    }
  }
}
for (const [key, n] of [...count].sort()) console.log(n, key);
