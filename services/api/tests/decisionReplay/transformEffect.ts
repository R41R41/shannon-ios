import { existsSync, readFileSync } from 'node:fs';
import { answerOf, contextOf } from './checks.js';
import { answerOfSent, productionTransform } from './headTransform.js';
import { loadAllRuns, dataFile } from './allRuns.js';
import { decisionOf, loadScenes, scoreAnswer } from './score.js';
import type { Row2 } from './run2.js';

/**
 * 頭の変換（headTransform.ts）を通す前と後で、機械の検査の結果がどう変わるか（API を使わない）。
 *   node --import tsx tests/decisionReplay/transformEffect.ts [--variants=v1] [--files=results.jsonl,results5.jsonl]
 * 検査で決まる ×（stopIf の hostileWithin、体に送れない形など）と、変換が答えを変えた数・直した行の種類を数える。
 * 採点者（Opus）で決まる場面は、変わった答えだけ別に採点する（judge5.ts）。
 */
const args = process.argv.slice(2);
const flag = (name: string, fallback: string) => args.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const variants = flag('variants', 'v1').split(','), files = flag('files', 'results.jsonl,results5.jsonl').split(',');
const rows = files.flatMap(name => existsSync(dataFile(name)) ? readFileSync(dataFile(name), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as Row2) : [])
  .filter(row => row.ok && variants.includes(row.variant));
const runs = loadAllRuns();
const scenes = new Map(loadScenes().map(scene => [scene.id, scene]));
const tally = { rows: 0, acts: 0, changed: 0, flipped: 0 };
const kinds = new Map<string, number>();
const flips: string[] = [];
for (const row of rows) {
  const scene = scenes.get(row.scene);
  if (!scene) continue;
  const decision = decisionOf(runs, scene), context = contextOf(decision);
  const raw = answerOf([{ type: 'tool_use', name: String(row.answer.tool).replace(/^mc\./, 'mc_').replace(/^plan\./, 'plan_'), input: row.answer.input }] as never);
  const sent = productionTransform(row.answer.tool, row.answer.input, decision);
  const after = answerOfSent(sent);
  tally.rows += 1;
  if (row.answer.tool === 'mc.act') tally.acts += 1;
  if (sent.changed) {
    tally.changed += 1;
    for (const fix of sent.fixes) { const kind = fix.replace(/[\d.]+/g, 'N').slice(0, 48); kinds.set(kind, (kinds.get(kind) ?? 0) + 1); }
  }
  const a = scoreAnswer(scene, context, raw), b = scoreAnswer(scene, context, after);
  if (a.verdict !== b.verdict || a.failed.join() !== b.failed.join()) {
    tally.flipped += 1;
    flips.push(`${row.variant} ${row.scene} r${row.rep}: ${a.verdict}${a.failed.length ? `[${a.failed.map(x => x.slice(0, 40)).join(' / ')}]` : ''} → ${b.verdict}${b.failed.length ? `[${b.failed.map(x => x.slice(0, 40)).join(' / ')}]` : ''}  fixes=${sent.fixes.join(' | ').slice(0, 120)}`);
  }
}
console.log(JSON.stringify(tally));
console.log([...kinds].map(([k, n]) => `${n} × ${k}`).join('\n'));
console.log(flips.join('\n'));
