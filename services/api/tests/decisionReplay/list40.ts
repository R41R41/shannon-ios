import { loadAllRuns } from './allRuns.js';
import { decisions } from './load.js';
const run = loadAllRuns().get('r40')!;
const t0 = Date.parse('2026-10-26T08:15:13.959Z');
for (const d of decisions(run)) {
  const body = (d.live.body ?? {}) as Record<string, any>;
  const blocks = ((d.assistant?.content ?? []) as any[]).filter(b => b.type === 'tool_use');
  const desc = blocks.map(b => `${b.name}:${JSON.stringify(b.input).slice(0, 110)}`).join(' | ');
  const lr = Array.isArray(body.lastResults) ? String(body.lastResults[0] ?? '').split('\n')[0]!.slice(0, 50) : '';
  console.log(d.row.seq, `+${Math.round((Date.parse(d.row.at) - t0) / 1000)}`, 'e' + d.epoch, body.urgent ? 'URG' : '', String(body.planNow ?? '').slice(0, 24), '|', desc.slice(0, 150), '|LR', lr);
}
