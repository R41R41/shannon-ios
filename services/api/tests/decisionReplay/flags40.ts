import { loadAllRuns } from './allRuns.js';
import { decisions } from './load.js';
import { answerOf } from './checks.js';
const ds = decisions(loadAllRuns().get('r40')!);
const kind = (i: number) => { const d = ds[i]; if (!d) return '-'; const t = d.resultText; return /^act 全部済み/u.test(t) ? 'ok' : /^act 最後まで/u.test(t) ? 'okish' : /^act \d+\/\d+ 済みで止まった/u.test(t) ? 'stop' : /^送る前に止めた/u.test(t) ? 'held' : /^引数/u.test(t) ? 'shape' : /^急ぎ/u.test(t) ? 'reflex' : d.call?.name?.startsWith('mc_probe') || d.call?.name === 'mc.probe' ? 'probe' : 'other'; };
const out: Record<string, number[]> = { okAfterOk: [], okAfterStop: [], stopAfterOk: [], urg: [] };
for (const [i, d] of ds.entries()) {
  const body = (d.live.body ?? {}) as Record<string, any>;
  const a = answerOf((d.assistant?.content ?? []) as never);
  if (a.tool !== 'mc.act') continue;
  const prev = kind(i - 1);
  const tag = body.urgent ? 'URG' : prev === 'ok' ? 'AFTER_OK' : /stop|held|shape|reflex/.test(prev) ? 'AFTER_STOP' : 'OTHER';
  console.log(d.row.seq, 'e' + d.epoch, tag, prev, '->', kind(i), a.hands.length + 'h', JSON.stringify(a.input).includes('wait') ? 'WAIT' : '', (d.row.entries.length));
}
