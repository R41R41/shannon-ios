import { loadAllRuns } from './allRuns.js';
import { candFrame, candidateAct } from './candidateAdapter.js';
import { decisionOf } from './score.js';
import { frames } from './sceneSet.js';
import { latest } from './views5.js';
import { readRows10, scenes10 } from './sonnet10.js';
import { seenStops } from '../../src/surfaces/minecraft/minecraftLlmcHandGuards.js';
import { candidateInput, isUrgentLive } from '../../src/surfaces/minecraft/minecraftLlmcV2.js';

/** 「見られる」で止まったマス（90 秒以内）を exposeOk なしで掘る手が、答え（1 回目・聞き直し）に残っていないか。残るなら守りが止めたか。 */
const rows = latest(readRows10(['sn-O.jsonl', 'sn-S.jsonl', 'sn-N.jsonl'])) as any[];
const runs = loadAllRuns();
const rel = (hand: any) => hand?.rel === true;
for (const scene of scenes10(rows)) {
  const decision = decisionOf(runs, scene);
  const frame = candFrame(decision, frames(runs, decision.run.key)) as any;
  const stops = seenStops(frame.state.world.recentStops);
  if (!stops.size) continue;
  console.log(`## ${scene.id.slice(0, 3)} 見られるの止まり: ${[...stops].map(([k, v]) => `(${k}) ${v}秒前`).join(' ')}`);
  for (const row of rows.filter(r => r.scene === scene.id)) {
    for (const [label, raw] of [['1回目', row.rawFirst], ['聞き直し', row.rawFinal]] as const) {
      if (!raw || typeof raw !== 'object' || !Array.isArray((raw as any).hands)) continue;
      const input = candidateInput('mc.act', raw) as any;
      const hits: string[] = [];
      for (const [i, hand] of (input.hands ?? []).entries()) {
        if (hand?.do !== 'dig') continue;
        for (const cell of hand.at ?? []) {
          const key = rel(hand) ? '' : `${cell.x},${cell.y},${cell.z}`;
          if (stops.has(key) && !hand.exposeOk) hits.push(`手${i + 1}(${key})`);
          // 相対の手は足からの差で見る
          if (rel(hand)) {
            const feet = frame.state.world.position;
            const abs = `${Math.floor(feet.x) + cell.x},${Math.floor(feet.y) + cell.y},${Math.floor(feet.z) + cell.z}`;
            if (stops.has(abs) && !hand.exposeOk) hits.push(`手${i + 1}rel(${abs})`);
          }
        }
      }
      if (!hits.length) continue;
      const act = candidateAct(raw, frame, `leak-${scene.id}-${row.rep}`, { urgent: isUrgentLive(decision.live) });
      console.log(`  ${row.variant}r${row.rep} ${label}: 見られるマスの dig ${hits.join(',')} → 今の守り ${act.guard ? `${act.guard.stopped ? '全' : '部'}${act.guard.hand}:${act.guard.code ?? ''}` : '止めず'}`);
    }
  }
}
