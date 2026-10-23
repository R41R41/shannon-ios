import { loadAllRuns } from './allRuns.js';
import { decisions } from './load.js';
const [,, key, idx] = process.argv;
const run = loadAllRuns().get(key!)!;
const d = decisions(run)[Number(idx) - 1]!;
console.log('epoch', d.epoch, 'epochStart', d.epochStart, 'index', d.index);
for (const e of d.turn) console.log('TURN', e.role, typeof e.content === 'string' ? e.content : JSON.stringify(e.content));
console.log('CALL', JSON.stringify(d.call));
console.log('RESULT', d.resultText);
