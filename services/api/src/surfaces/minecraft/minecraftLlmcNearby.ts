import { relText } from './minecraftLlmcLiveEnemies.js';
import type { P } from './minecraftLlmcWalkRules.js';

/**
 * 2026-11-11 (the owner on run 7: 「周囲のブロック情報の渡し方を工夫したい」): what is near, by purpose, one line each. In run 7 the live state said where the logs
 * were once (the scan, the first decision) and never where the animals or the village's food were; the model hunted the cow it was told of and cut the
 * least wood while trees stood round it. The body counts (`state.world.nearbyResources`: the count, the range and the nearest three sites of each
 * purpose); the head works the place out from her feet now and writes a line for each. Facts only: no hand and no choice is made here.
 */
export type NearbyPurpose = 'wood' | 'food_animal' | 'food_village' | 'ore' | 'bed' | 'water';
export interface NearbySite { x: number; y: number; z: number; note?: string }
export interface NearbyResource { purpose: NearbyPurpose; kind: string; count: number; range: number; sites: NearbySite[]; trees?: number }

const LABEL: Readonly<Record<NearbyPurpose, readonly [string, string]>> = {
  wood: ['木', '本'], food_animal: ['食料（動物）', '体'], food_village: ['食料（村）', '個'], ore: ['鉱石（空気に面した物）', '個'], bed: ['寝床', '台'], water: ['水', 'マス'],
};
const ORDER: readonly NearbyPurpose[] = ['wood', 'food_animal', 'food_village', 'ore', 'bed', 'water'];
const PURPOSES = new Set<string>(ORDER);

const finite = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;

/** The body's `nearbyResources` as the head reads it; entries that do not read are left out. */
export function nearbyResourcesOf(raw: unknown): NearbyResource[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item): NearbyResource[] => {
    if (!item || typeof item !== 'object') return [];
    const entry = item as Record<string, unknown>, count = finite(entry.count), range = finite(entry.range);
    if (typeof entry.purpose !== 'string' || !PURPOSES.has(entry.purpose) || typeof entry.kind !== 'string' || count === null || range === null) return [];
    const sites = (Array.isArray(entry.sites) ? entry.sites : []).flatMap((site): NearbySite[] => {
      const at = site && typeof site === 'object' ? site as Record<string, unknown> : null;
      const [x, y, z] = [finite(at?.x), finite(at?.y), finite(at?.z)];
      return at && x !== null && y !== null && z !== null ? [{ x, y, z, ...typeof at.note === 'string' && at.note ? { note: at.note.slice(0, 40) } : {} }] : [];
    });
    const trees = finite(entry.trees);
    return [{ purpose: entry.purpose as NearbyPurpose, kind: entry.kind.slice(0, 40), count, range, sites, ...(trees !== null && trees >= 0 ? { trees } : {}) }];
  });
}

/** The purpose a plan's now words are about, put first (the other lines stay: nothing is hidden). */
function firstPurpose(hint: string): NearbyPurpose | null {
  if (/原木|木材|木を|wood|stock:wood/u.test(hint)) return 'wood';
  if (/食料|食べ物|動物|干し草|food|狩/u.test(hint)) return 'food_animal';
  if (/ベッド|羊|bed/u.test(hint)) return 'bed';
  if (/鉄|石炭|ダイヤ|鉱石|iron|coal|diamond/u.test(hint)) return 'ore';
  return null;
}

const dist = (feet: P, at: NearbySite): number => Math.round(Math.hypot(at.x - feet.x, at.y - feet.y, at.z - feet.z));
function siteWords(feet: P, site: NearbySite, first: boolean): string {
  const at = `(${site.x},${site.y},${site.z})`, note = site.note ? `（${site.note}）` : '';
  return first ? `最寄り ${at} ${relText({ ...feet }, { x: site.x, y: site.y, z: site.z })} ${dist(feet, site)}m${note}` : `${at} ${dist(feet, site)}m${note}`;
}

/**
 * One line a purpose: 「木: oak_log 64m 内に 60 本。最寄り (232,66,-127) 西28・北36 46m（幹 5 本）/ (232,66,-133) 52m」, nearest sites first, the place from her
 * feet now. A count of 0 says 「なし」 within the range. `hint` (the plan's now) puts the purpose it is about first.
 */
export function nearbyLines(resources: readonly NearbyResource[], feet: P | null, hint = ''): string[] {
  if (!resources.length) return [];
  const first = firstPurpose(hint), order = first ? [first, ...ORDER.filter(purpose => purpose !== first)] : [...ORDER];
  const lines: string[] = [];
  for (const purpose of order) {
    const group = resources.filter(item => item.purpose === purpose);
    if (!group.length) continue;
    const [label, unit] = LABEL[purpose];
    const parts = group.map(item => {
      if (item.count <= 0 || !item.sites.length) return `${item.kind} ${item.range}m 内に なし`;
      const sites = [...item.sites].sort((a, b) => feet ? dist(feet, a) - dist(feet, b) : 0).slice(0, 3);
      const where = feet ? sites.map((site, index) => siteWords(feet, site, index === 0)).join(' / ')
        : sites.map(site => `(${site.x},${site.y},${site.z})${site.note ? `（${site.note}）` : ''}`).join(' / ');
      return `${item.kind} ${item.range}m 内に ${item.count}${unit}。${where}`;
    });
    lines.push(`${label}: ${parts.join('／')}`);
  }
  return lines;
}
