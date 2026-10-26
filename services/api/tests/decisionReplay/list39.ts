import { loadAllRuns } from './allRuns.js';
import { decisions } from './load.js';
import { answerOf } from './checks.js';
const run = loadAllRuns().get('r39')!;
const ds = decisions(run);
console.log('rows', run.rows.length, 'epochs', new Set(ds.map(d => d.epoch)).size, 'core', run.core.length, 'summary', run.summary?.through, run.summary?.reset);
for (const d of ds) {
  const body = (d.live.body ?? {}) as Record<string, any>;
  const a = answerOf((d.assistant?.content ?? []) as never);
  const first = d.resultText.split('\n')[0]?.slice(0, 60) ?? '';
  const st = d.resultText.split('\n').find(l => /^\d+ \w+ (止|失) /u.test(l))?.slice(0, 50) ?? '';
  console.log(d.row.seq, 'e' + d.epoch, a.tool, a.hands.length + 'h', body.urgent ? 'URG' : '   ', String(body.planNow ?? '').slice(0, 30), '|', first, '|', st, '| len', JSON.stringify(d.row.entries).length);
}
