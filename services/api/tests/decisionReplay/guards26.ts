import { loadAllRuns } from './allRuns.js';
import { candFrame, candidateAct } from './candidateAdapter.js';
import { decisionOf } from './score.js';
import { frames } from './sceneSet.js';
import { latest } from './views5.js';
import { readRows10, scenes10 } from './sonnet10.js';
import { isUrgentLive } from '../../src/surfaces/minecraft/minecraftLlmcV2.js';

/**
 * 10/26 mc-sonnet-guards: 記録した Sonnet・Opus の 1 回目の答えに、今の src の守りをかけ直して、前の守り（行に残る sent.guard）と比べる。API は使わない。
 *   node --import tsx tests/decisionReplay/guards26.ts [--files=sn-S.jsonl,sn-O.jsonl,sn-N.jsonl] [--all]
 */
const arg = (name: string) => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const files = (arg('files') ?? 'sn-O.jsonl,sn-S.jsonl,sn-N.jsonl').split(',');
const rows = latest(readRows10(files)) as any[];
const runs = loadAllRuns();
const out: string[] = [];
let n = 0, changed = 0;
for (const scene of scenes10(rows)) {
  const decision = decisionOf(runs, scene);
  const info = frames(runs, decision.run.key);
  const frame = candFrame(decision, info);
  for (const row of rows.filter(r => r.scene === scene.id)) {
    const firstTool = row.sent?.guard ? 'mc.act' : row.answer?.tool;
    if (firstTool !== 'mc.act' || !row.rawFirst) continue;
    n += 1;
    const act = candidateAct(row.rawFirst, frame, `g26-${scene.id}-${row.rep}`, { urgent: isUrgentLive(decision.live) });
    const old = row.sent?.guard;
    const now = act.guard;
    const tag = (g: any) => g ? `${g.stopped ? '全' : '部'}${g.hand}:${g.code ?? '?'}` : '-';
    const diff = tag(old) !== tag(now);
    if (diff) changed += 1;
    if (diff || process.argv.includes('--all')) out.push(`${scene.id.slice(0, 3)} ${row.variant}r${row.rep} 前 ${tag(old)} → 今 ${tag(now)}${now?.text ? `  | ${String(now.text).replace(/^.*?手 \d+ /, '').slice(0, 150)}` : ''}`);
  }
}
console.log(out.join('\n'));
console.log(`答え ${n}、守りの結果が変わった ${changed}`);
