import { writeFileSync } from 'node:fs';
import { dataFile } from './allRuns.js';
import { latest } from './views5.js';
import { readRows10, type S2Meta } from './sonnet10.js';
import type { Row2 } from './run2.js';

/**
 * S×2: Sonnet 5.5 を同じ要求で 2 つ並列に出し、送る前の守り（preflight・規則の守り）に通して、止められなかった方を使う。
 *   - 両方通れば、先に返った方（1 回目の呼び出しの終わりが早い方）。
 *   - 片方だけ通れば、通った方（遅く返っても待つ）。
 *   - 両方止められたら、先に返った方を今の聞き直しの形（事実を返して 1 回聞き直す）に回す。
 * 独立に出した 2 つの答えの組は、S の回の組から作る（S の 3 回の 3 通りの組。組どうしは独立でない）。実際に並列に出した場合と、
 * 答えの分布は同じ。時間は「使った方まで」、費用は 2 つ分（両方の 1 回目 + 使った方の聞き直し）。
 * 「止められた」= 守りが手を止めた（全部または一部）か、送れない形（problem）。道具が mc.act でない答えは守りに掛からない = 通った。
 */
type Row = Row2 & { sent: { guard?: unknown; problem?: string | null }; blockTypes?: string[] };
const rows = latest(readRows10(['sn-S.jsonl'])) as Row[];
const scenes = [...new Set(rows.map(row => row.scene))];
const held = (row: Row) => !!row.sent.guard || !!row.sent.problem;
const out: string[] = [];
let pairs = 0, bothHeld = 0, bothPassed = 0;
for (const scene of scenes) {
  const mine = rows.filter(row => row.scene === scene).sort((a, b) => a.rep - b.rep);
  let index = 0;
  for (let i = 0; i < mine.length; i += 1) for (let j = i + 1; j < mine.length; j += 1) {
    const a = mine[i]!, b = mine[j]!;
    const firstEnd = (row: Row) => row.firstTEnd ?? row.tEnd;
    const early = firstEnd(a) <= firstEnd(b) ? a : b, late = early === a ? b : a;
    const passA = !held(a), passB = !held(b);
    let chosen: Row, tUsed: number, reask = false;
    if (passA && passB) { chosen = early; tUsed = firstEnd(early); }
    else if (passA || passB) { chosen = passA ? a : b; tUsed = firstEnd(chosen); }
    else { chosen = early; tUsed = early.tEnd; reask = true; }
    void late;
    pairs += 1; if (!passA && !passB) bothHeld += 1; if (passA && passB) bothPassed += 1;
    const firstCost = (row: Row) => row.firstCostUsd ?? row.costUsd;
    const meta: S2Meta = { reps: [a.rep, b.rep], used: chosen.rep, bothHeld: reask, bothPassed: passA && passB, tUsed, tFirstBlock: chosen.tFirstBlock ?? 0,
      firstUsages: [a.firstUsage ?? a.usage, b.firstUsage ?? b.usage],
      ...(reask ? { reaskUsage: { input: chosen.usage.input - (chosen.firstUsage?.input ?? 0), output: chosen.usage.output - (chosen.firstUsage?.output ?? 0),
        cacheWrite: chosen.usage.cacheWrite - (chosen.firstUsage?.cacheWrite ?? 0), cacheRead: chosen.usage.cacheRead - (chosen.firstUsage?.cacheRead ?? 0) } } : {}),
      costActual: firstCost(a) + firstCost(b) + (reask ? chosen.costUsd - firstCost(chosen) : 0) };
    index += 1;
    out.push(JSON.stringify({ ...chosen, variant: 'S2', rep: index, s2: meta }));
  }
}
writeFileSync(dataFile('sn-S2.jsonl'), `${out.join('\n')}\n`);
console.log(`S2: scenes ${scenes.length}, pairs ${pairs}, both passed ${bothPassed}, one passed ${pairs - bothPassed - bothHeld}, both held ${bothHeld}`);
