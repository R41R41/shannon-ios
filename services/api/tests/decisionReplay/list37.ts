import { loadAllRuns } from './allRuns.js';
import { decisions } from './load.js';
const [,, key, from, to] = process.argv;
const ds = decisions(loadAllRuns().get(key!)!);
for (const d of ds.slice(Number(from) - 1, Number(to))) {
  const a = (d.assistant?.content as any[] | undefined) ?? [];
  const think = a.filter(b => b.type === 'text').map(b => b.text).join('|').slice(0, 100);
  console.log(`d${d.index + 1} e${d.epoch} ${d.call?.name} ${JSON.stringify(d.call?.input ?? {}).slice(0, 220)} ${think ? 'T:' + think : ''}\n    => ${String(d.resultText).slice(0, 160).replace(/\n/g, ' ')}`);
}
