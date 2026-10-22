import { existsSync, readFileSync } from 'node:fs';
import { loadRuns } from './load.js';
import { decisionOf, loadScenes } from './score.js';

/**
 * 費用の見積もり: count_tokens（count.ts が data/counts.json に書く）の数 + 場面の並び順でのキャッシュ書き込み（5 分）。
 * 実際の費用は ledger.jsonl が数える。見積もりは run.ts が「2 回目を回しても上限に収まるか」を決めるのにも使う。
 */
const p = (name: string) => new URL(`./data/${name}`, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const PRICE: Record<string, { in: number; out: number; read: number; write: number }> = {
  v1: { in: 4, out: 20, read: 0.2, write: 5 }, v2: { in: 4, out: 20, read: 0.2, write: 5 }, v3: { in: 2, out: 10, read: 0.2, write: 2.5 } };
/** Output tokens a decision is guessed to take (production Opus: 300-1,000, mean about 560 with the old instructions). */
const OUT: Record<string, number> = { v1: 560, v2: 350, v3: 350 };
const LIVE = 3300, FIXED: Record<string, number> = { v1: 31200, v2: 14300, v3: 14300 };

let cache: { runs: ReturnType<typeof loadRuns>; counts: Record<string, Record<string, number>> } | null = null;
function load() {
  if (cache) return cache;
  const runs = loadRuns(p('export1.txt'), p('journal.txt'));
  const counts = existsSync(p('counts.json')) ? JSON.parse(readFileSync(p('counts.json'), 'utf8')) as Record<string, Record<string, number>> : {};
  return cache = { runs, counts };
}

export function projectedCost(variant: string, sceneIds: readonly string[], reps = 2, detail = false): number {
  const { runs, counts } = load();
  const price = PRICE[variant] ?? PRICE.v1!;
  const wanted = new Set(sceneIds);
  const scenes = loadScenes().filter(scene => wanted.has(scene.id)).map(scene => ({ scene, decision: decisionOf(runs, scene) }))
    .sort((a, b) => a.scene.run.localeCompare(b.scene.run) || a.decision.epoch - b.decision.epoch || a.decision.index - b.decision.index);
  let sum = 0, previous: (typeof scenes)[number] | null = null, previousPrefix = 0;
  for (const item of scenes) {
    const n = counts[item.scene.id]?.[variant] ?? 50_000;
    const prefix = n - LIVE;
    const same = previous && previous.scene.run === item.scene.run && previous.decision.epoch === item.decision.epoch;
    const read = same ? Math.min(previousPrefix, prefix) : Math.min(FIXED[variant] ?? 31_200, prefix);
    const write = prefix - read;
    let cost = (LIVE * price.in + write * price.write + read * price.read + (OUT[variant] ?? 560) * price.out) / 1e6;
    for (let rep = 1; rep < reps; rep += 1) cost += (LIVE * price.in + prefix * price.read + (OUT[variant] ?? 560) * price.out) / 1e6;
    if (detail) console.log(item.scene.id.padEnd(40), 'e' + item.decision.epoch, 'tokens', n, 'read', read, 'write', write, 'cost', cost.toFixed(3));
    sum += cost; previous = item; previousPrefix = prefix;
  }
  return sum;
}

if (process.argv[1]?.endsWith('plan.ts')) {
  const ids = loadScenes().map(scene => scene.id);
  const reps = Number(process.argv[2] ?? 2);
  let total = 0;
  for (const v of ['v1', 'v2', 'v3']) {
    const cost = projectedCost(v, ids, reps, process.argv[3] === 'detail' && v === 'v1');
    console.log(v, 'scenes', ids.length, 'cost $', cost.toFixed(2));
    total += cost;
  }
  console.log('total $', total.toFixed(2));
}
