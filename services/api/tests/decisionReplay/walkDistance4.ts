/** 比べ（v2・v9b・v9c）の「塞がったマス・床の無いマスへ walk」の ×（検査）を、足からの距離（近い = 2 マス以内、around が書く範囲）で数える。先に report4.ts を回す。 */
import { readFileSync } from 'node:fs';
import { loadAllRuns, dataFile } from './allRuns.js';
import { decisionOf, loadScenes } from './score.js';
const runs = loadAllRuns();
const entries = JSON.parse(readFileSync(dataFile('report4-entries.json'), 'utf8')) as Array<{ scene: string; variant: string; rep: number | string; verdict: string; failed: string[] }>;
const feet = new Map<string, { x: number; y: number; z: number }>();
for (const scene of loadScenes()) { const m = /\((-?\d+),(-?\d+),(-?\d+)\)/.exec(String((decisionOf(runs, scene).live as any).body.state.at)); feet.set(scene.id, { x: +m![1]!, y: +m![2]!, z: +m![3]! }); }
const out: Record<string, { near: number; far: number; list: string[] }> = {};
for (const e of entries) {
  for (const f of e.failed) {
    const m = /^塞がったマスへ歩く: 手\d+ walk \((-?\d+),(-?\d+),(-?\d+)\)/.exec(f);
    if (!m) continue;
    const p = feet.get(e.scene)!;
    const d = Math.max(Math.abs(+m[1]! - p.x), Math.abs(+m[3]! - p.z), Math.abs(+m[2]! - p.y));
    const o = (out[e.variant] ??= { near: 0, far: 0, list: [] });
    if (d <= 2) o.near += 1; else o.far += 1;
    o.list.push(`${e.scene.slice(0, 3)}r${e.rep}:${d}`);
  }
}
for (const [v, o] of Object.entries(out)) console.log(v, 'near(≤2)', o.near, 'far(>2)', o.far, o.list.join(' '));
