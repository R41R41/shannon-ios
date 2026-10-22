import { writeFileSync } from 'node:fs';
import { loadAllRuns } from './allRuns.js';
import { decisionOf, loadScenes } from './score.js';
import { OMIT, relText, rewriteLive, staleStand } from './rewriteLive.js';
import { mapView, readLayers } from './rewriteMap.js';

/**
 * 点検の機械で数えられる所（10/23）。live（Opus が見た物）と、書き直した live の両方に同じ数え方をかける。
 *   node --import tsx tests/decisionReplay/inspectMech.ts [出力 json]
 * 数える物: 要らない欄 / 誤った値・食い違い / 省略 / 地図の読みにくさ。
 */
export interface Mech {
  scene: string; chars: number; landmarkRows: number;
  /** 要らない欄（ownerClock・waiting・observations・recall の項目・plan.now/path が planNow と同じ・plan.rules の重複・今の地図と合わない古い注意）。 */
  useless: { ownerClock: number; waiting: number; observations: number; recallItems: number; planDup: number; ruleDup: number; staleRule: number };
  /** 誤り・食い違い。 */
  wrong: { biome: number; invDupNames: number; urgentDupLines: number; enemyDistConflicts: number; urgentVsUnreachable: number; landmarkStale: number; undefinedText: number };
  /** 省略。 */
  omit: { markers: number; hidden: number; truncatedLines: number; byField: Record<string, number> };
  /** 地図。 */
  map: { mode: string; layers: number; distinctRanges: number; mainDiffersFromLayers: boolean; chars: number; compactAround: number };
}
const DIM_OK: Record<string, RegExp> = { the_nether: /^(nether_wastes|soul_sand_valley|crimson_forest|warped_forest|basalt_deltas)$/u };
const pos = (t: string) => { const m = /\((-?\d+),(-?\d+),(-?\d+)\)/u.exec(t); return m ? { x: +m[1]!, y: +m[2]!, z: +m[3]! } : null; };

export function mechOf(id: string, live: Record<string, any>): Mech {
  const body = (live.body ?? {}) as Record<string, any>;
  const self = pos(String(body.state?.at ?? ''));
  const plan = (live.plan ?? {}) as Record<string, any>;
  const text = typeof body.map === 'string' ? body.map : '';
  const layers = readLayers(text);
  const view = layers ? mapView(layers) : null;
  const ranges = new Set<string>();
  const lines = text.split('\n');
  for (const line of lines) { const m = /^y=-?\d+(?: (x=-?\d+\.\.-?\d+ z=-?\d+\.\.-?\d+))?/u.exec(line); if (m) ranges.add(m[1] ?? '(範囲なし)'); }
  const unified = text.includes('同じ範囲');
  const main = /x=-?\d+\.\.-?\d+ z=-?\d+\.\.-?\d+/u.exec(lines[0] ?? '')?.[0] ?? '';
  const byField: Record<string, number> = {};
  let markers = 0, hidden = 0;
  for (const [field, value] of Object.entries(body)) {
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      const o = typeof item === 'string' ? (OMIT.exec(item) ?? /^（?ほか(\d+)件は略）?$/u.exec(item)) : null;
      if (o) { markers += 1; hidden += Number(o[1]); byField[field] = (byField[field] ?? 0) + Number(o[1]); }
    }
  }
  const lastResults = (Array.isArray(body.lastResults) ? body.lastResults : []) as string[];
  const truncatedLines = lastResults.flatMap(item => item.split('\n')).filter(line => /…$/u.test(line.trim())).length;
  const rules = (Array.isArray(plan.rules) ? plan.rules : []) as string[];
  const norm = rules.map(rule => rule.replace(/（p\d+(?:\.\d+)*）/u, ''));
  const planId = /^(p\d+(?:\.\d+)*|r\d+)\s/u.exec(String(plan.now ?? ''))?.[1];
  const inv = (Array.isArray(body.inventory) ? body.inventory : []) as string[];
  const invNames = inv.flatMap(line => { const m = /^([a-z_0-9]+)×\d+$/u.exec(line); return m ? [m[1]!] : []; });
  const urgent = (Array.isArray(body.urgent) ? body.urgent : []) as string[];
  const unreachable = (Array.isArray(body.unreachable) ? body.unreachable : []) as string[];
  const ids = urgent.flatMap(line => /#(\d+) [\d.]+m/u.exec(line)?.[1] ?? []);
  const conflicts = (() => {
    const dists = new Map<string, Set<string>>();
    for (const line of [...urgent, ...unreachable]) {
      const m = /#(\d+) ([\d.]+)m/u.exec(line);
      if (m) { if (!dists.has(m[1]!)) dists.set(m[1]!, new Set()); dists.get(m[1]!)!.add(m[2]!); }
    }
    for (const line of (Array.isArray(body.threats) ? body.threats : []) as string[]) {
      const m = /^#(\d+) \S+ ([\d.]+)m/u.exec(line);
      if (m && dists.has(m[1]!) && ![...dists.get(m[1]!)!].some(d => Math.abs(Number(d) - Number(m[2])) < 0.75)) dists.get(m[1]!)!.add(m[2]!);
    }
    return [...dists.values()].filter(set => set.size > 1).length;
  })();
  const anonymous = urgent.filter(line => /^\S+ [\d.]+m$/u.test(line));
  const unreachNames = unreachable.map(line => /^(\S+) #\d+ ([\d.]+)m/u.exec(line)).filter((m): m is RegExpExecArray => !!m);
  const contra = anonymous.filter(line => {
    const m = /^(\S+) ([\d.]+)m$/u.exec(line)!;
    return unreachNames.some(u => u[1] === m[1] && Math.abs(Number(u[2]) - Number(m[2])) <= 0.6);
  }).length;
  const landmarks = (Array.isArray(body.landmarks) ? body.landmarks : []) as string[];
  const stale = self ? landmarks.filter(line => {
    const m = /^.*? \((-?\d+),(-?\d+),(-?\d+)\) ((?:[東西南北上下]\d+)(?:・[東西南北上下]\d+)*)/u.exec(line);
    return !!m && relText(self, { x: +m[1]!, y: +m[2]!, z: +m[3]! }) !== m[4];
  }).length : 0;
  const biome = String(body.state?.biome ?? ''), dimension = String(body.state?.dimension ?? '');
  return {
    scene: id, chars: JSON.stringify(live).length, landmarkRows: landmarks.filter(line => /\(-?\d+,-?\d+,-?\d+\) [東西南北上下]/u.test(line)).length,
    useless: { ownerClock: live.ownerClock ? 1 : 0, waiting: live.waiting ? 1 : 0, observations: live.observations ? 1 : 0, recallItems: Array.isArray(live.recall?.items) ? live.recall.items.length : 0,
      planDup: planId && typeof body.planNow === 'string' && body.planNow.startsWith(`[${planId}]`) ? 1 : 0, ruleDup: norm.length - new Set(norm).size,
      staleRule: view ? rules.filter(rule => staleStand(rule, view)).length : 0 },
    wrong: { biome: biome && DIM_OK[dimension] && !DIM_OK[dimension]!.test(biome) ? 1 : 0, invDupNames: invNames.length - new Set(invNames).size,
      urgentDupLines: ids.length - new Set(ids).size, enemyDistConflicts: conflicts, urgentVsUnreachable: contra, landmarkStale: stale, undefinedText: (JSON.stringify(live).match(/undefined/gu) ?? []).length },
    omit: { markers, hidden, truncatedLines, byField },
    map: { mode: layers?.mode ?? '-', layers: lines.filter(line => /^y=-?\d+/u.test(line)).length, distinctRanges: unified ? 1 : ranges.size, mainDiffersFromLayers: unified ? false : !!main && [...ranges].some(r => r !== main), chars: text.length,
      compactAround: lastResults.join('\n').split('\n').filter(line => /周り（上の層から/u.test(line)).length },
  };
}

if (process.argv[1]?.endsWith('inspectMech.ts')) {
  const runs = loadAllRuns();
  const rows: Array<{ before: Mech; after: Mech }> = [];
  for (const scene of loadScenes()) {
    const live = decisionOf(runs, scene).live as Record<string, any>;
    rows.push({ before: mechOf(scene.id, live), after: mechOf(scene.id, rewriteLive(live).live) });
  }
  const out = process.argv[2];
  if (out) writeFileSync(out, JSON.stringify(rows, null, 1));
  const sum = (pick: (m: Mech) => number, side: 'before' | 'after') => rows.reduce((a, r) => a + pick(r[side]), 0);
  const show = (name: string, pick: (m: Mech) => number) => console.log(name.padEnd(28), String(sum(pick, 'before')).padStart(7), String(sum(pick, 'after')).padStart(7));
  show('chars', m => m.chars); show('landmarkRows', m => m.landmarkRows); show('ownerClock', m => m.useless.ownerClock); show('waiting', m => m.useless.waiting); show('observations', m => m.useless.observations);
  show('recallItems', m => m.useless.recallItems); show('planDup', m => m.useless.planDup); show('ruleDup', m => m.useless.ruleDup); show('staleRule', m => m.useless.staleRule);
  show('biome', m => m.wrong.biome); show('invDupNames', m => m.wrong.invDupNames); show('urgentDupLines', m => m.wrong.urgentDupLines); show('enemyDistConflicts', m => m.wrong.enemyDistConflicts);
  show('urgentVsUnreachable', m => m.wrong.urgentVsUnreachable); show('landmarkStale', m => m.wrong.landmarkStale); show('undefinedText', m => m.wrong.undefinedText);
  show('omit markers', m => m.omit.markers); show('omit hidden', m => m.omit.hidden); show('truncatedLines', m => m.omit.truncatedLines);
  show('layers', m => m.map.layers); show('distinctRanges', m => m.map.distinctRanges); show('mainDiffers', m => m.map.mainDiffersFromLayers ? 1 : 0);
  show('compactAround', m => m.map.compactAround); show('mapChars', m => m.map.chars);
}
