import { loadAllRuns } from './allRuns.js';
import { contextOf } from './checks.js';
import { candFrame, candidateAct } from './candidateAdapter.js';
import { decisionOf } from './score.js';
import { frames } from './sceneSet.js';
import { latest } from './views5.js';
import { readRows10, scenes10 } from './sonnet10.js';
import { isUrgentLive } from '../../src/surfaces/minecraft/minecraftLlmcV2.js';
import { candidateInput } from '../../src/surfaces/minecraft/minecraftLlmcV2.js';

/** 足・頭のマスへの place が最終の答え（sent.input）に残った行を出し、1 回目の答えの守り（今の src）が止めたかを見る。 */
const rows = latest(readRows10(['sn-O.jsonl', 'sn-S.jsonl', 'sn-N.jsonl'])) as any[];
const runs = loadAllRuns();
for (const scene of scenes10(rows)) {
  const decision = decisionOf(runs, scene);
  const self = contextOf(decision).self;
  const frame = candFrame(decision, frames(runs, decision.run.key));
  for (const row of rows.filter(r => r.scene === scene.id)) {
    const check = (hands: any[]) => hands.some(hand => hand?.do === 'place' && (Array.isArray(hand.at) ? hand.at : hand.at ? [hand.at] : []).some((c: any) => c.x === self.x && c.z === self.z && (c.y === self.y || c.y === self.y + 1)));
    const finalHands = (row.sent?.input?.hands ?? []) as any[];
    const firstExpanded = row.rawFirst ? (candidateInput('mc.act', row.rawFirst) as any) : null;
    const firstHands = (firstExpanded?.hands ?? []) as any[];
    if (!check(finalHands) && !check(firstHands)) continue;
    const act = row.rawFirst ? candidateAct(row.rawFirst, frame, `own-${scene.id}-${row.rep}`, { urgent: isUrgentLive(decision.live) }) : null;
    console.log(`${scene.id.slice(0, 3)} ${row.variant}r${row.rep} self=(${self.x},${self.y},${self.z}) 最終に${check(finalHands) ? '有' : '無'} 1回目に${check(firstHands) ? '有' : '無'} 今の守り ${act?.guard ? `${act.guard.stopped ? '全' : '部'}${act.guard.hand}:${act.guard.code}` : '-'}`);
    console.log('   1回目 raw:', JSON.stringify(row.rawFirst).slice(0, 420));
  }
}
