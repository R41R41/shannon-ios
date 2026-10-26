import { loadAllRuns } from './allRuns.js';
import { decisions } from './load.js';
const [,, key, idx] = process.argv;
const d = decisions(loadAllRuns().get(key!)!)[Number(idx) - 1]!;
const b: any = d.live.body, p: any = d.live.plan;
console.log('seq', d.row.seq, 'planNow', b.planNow, '| next', JSON.stringify(p?.next), 'rules', JSON.stringify(p?.rules));
console.log('state', JSON.stringify(b.state)); console.log('stops', JSON.stringify(b.stops));
console.log('lastResults', JSON.stringify(b.lastResults ?? null).slice(0, 1500)); console.log('inv', JSON.stringify(b.inventory ?? null).slice(0, 400));
console.log('threats', JSON.stringify(b.threats ?? null).slice(0, 250), 'urgent', JSON.stringify(b.urgent ?? null), 'keys', Object.keys(b).join(','));
