import { relText } from './minecraftLlmcLiveEnemies.js';
import type { P } from './minecraftLlmcWalkRules.js';

/**
 * 2026-11-11 (the owner on run 7: 「周囲のブロック情報の渡し方を工夫したい」): what is near, by purpose, one line each. In run 7 the live state said where the logs
 * were once (the scan, the first decision) and never where the animals or the village's food were; the model hunted the cow it was told of and cut the
 * least wood while trees stood round it. The body counts (`state.world.nearbyResources`: the count, the range and the nearest three sites of each
 * purpose); the head works the place out from her feet now and writes a line for each. Facts only: no hand and no choice is made here.
 */
export type NearbyPurpose = 'wood' | 'food_animal' | 'food_village' | 'plant' | 'ore' | 'bed' | 'water' | 'lava';
export interface NearbySite { x: number; y: number; z: number; note?: string }
export interface NearbyResource { purpose: NearbyPurpose; kind: string; count: number; range: number; sites: NearbySite[]; trees?: number; pools?: number }

const LABEL: Readonly<Record<NearbyPurpose, readonly [string, string]>> = {
  wood: ['木', '本'], food_animal: ['食料（動物）', '体'], food_village: ['食料（村）', '個'], plant: ['植物（材料）', '個'], ore: ['鉱石（空気に面した物）', '個'], bed: ['寝床', '台'], water: ['水', 'マス'],
  lava: ['溶岩の溜まり', 'マス'],
};
/**
 * Run 8 (11/13: four pools were loaded at 7 to 40 m and only the nearest source, 27 below across a hollow, reached the head): `lava` is the pools of
 * the overworld near her (the body joins the sources into pools: `count` is the sources and `pools` the pools they make, each site a pool's nearest
 * source with 「源 N・…・覆い ○/×」 in its note; the line says 「源 N マス・溜まり P」). Last in the order; first while the plan's now is the obsidian
 * (`firstPurpose`).
 */
const ORDER: readonly NearbyPurpose[] = ['wood', 'food_animal', 'food_village', 'plant', 'ore', 'bed', 'water', 'lava'];
const PURPOSES = new Set<string>(ORDER);
/** The crops that have a growth stage (a grown one is dug for its food; a young one only gives its seed back). */
const CROPS: ReadonlySet<string> = new Set(['wheat', 'beetroots']);

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
    const trees = finite(entry.trees), pools = finite(entry.pools);
    return [{ purpose: entry.purpose as NearbyPurpose, kind: entry.kind.slice(0, 40), count, range, sites, ...(trees !== null && trees >= 0 ? { trees } : {}),
      ...(pools !== null && pools >= 0 ? { pools } : {}) }];
  });
}

/**
 * 2026-11-23 (replays of the four wheat decisions, luna low, 26 rounds a row): with the crop's place and the dig's warning at its row, luna still dug the planted
 * wheat in 38 of 208 (82% did not). It wrote 「触らず」 in the why and put `dig` on the crop's cell in the hands: it went to check the growth, and the one
 * cell in the row read as a thing to aim a hand at. Said as it is here (the place left out of a young crop's row, the growth said to be counted again at each
 * input, no go, look or dig needed) it dug in 0 of 104. The place comes back with 「育った」. Not said while she holds bone meal: using it needs the cell
 * (`use bone_meal at=`), so the decision then reads the row as before. Only the decision's own `nearby` takes this (the plan's brief and the facts keep the places).
 */
const QUIET_UNRIPE_WORDS = '。この株は植えた物で、手を向ける物ではない。育ちを確かめるのに go・look・dig は要らない（この行の「育ち中 age/最大」が毎回数え直される。「育った」と出たら座標つきで出る）。育ち中に dig すると種に戻り、植えた分が消える';

/** The purpose a plan's now words are about, put first (the other lines stay: nothing is hidden). */
function firstPurpose(hint: string): NearbyPurpose | null {
  if (/黒曜石|溶岩|obsidian|lava/u.test(hint)) return 'lava';
  if (/原木|木材|木を|wood|stock:wood/u.test(hint)) return 'wood';
  if (/サトウキビ|砂糖|sugar|小麦|wheat|ニンジン|ジャガイモ|カボチャ|スイカ|ベリー|ビートルート/u.test(hint)) return 'plant';
  if (/食料|食べ物|動物|干し草|food|狩/u.test(hint)) return 'food_animal';
  if (/ベッド|羊|bed/u.test(hint)) return 'bed';
  if (/鉄|石炭|ダイヤ|鉱石|iron|coal|diamond/u.test(hint)) return 'ore';
  return null;
}

const dist = (feet: P, at: NearbySite): number => Math.round(Math.hypot(at.x - feet.x, at.y - feet.y, at.z - feet.z));
function siteWords(feet: P, site: NearbySite, first: boolean, quiet = false): string {
  const at = `(${site.x},${site.y},${site.z})`, note = site.note ? `（${site.note}）` : '';
  // A young crop in the decision's own input has no place (see `QUIET_UNRIPE_WORDS`): the way is still said, the cell to aim a hand at is not.
  if (quiet) return first ? `最寄り ${relText({ ...feet }, { x: site.x, y: site.y, z: site.z })} ${dist(feet, site)}m${note}` : `${dist(feet, site)}m${note}`;
  return first ? `最寄り ${at} ${relText({ ...feet }, { x: site.x, y: site.y, z: site.z })} ${dist(feet, site)}m${note}` : `${at} ${dist(feet, site)}m${note}`;
}

/**
 * One line a purpose: 「木: oak_log 64m 内に 60 本。最寄り (232,66,-127) 西28・北36 46m（幹 5 本）/ (232,66,-133) 52m」, nearest sites first, the place from her
 * feet now. A count of 0 says 「なし」 within the range. `hint` (the plan's now) puts the purpose it is about first.
 */
export function nearbyLines(resources: readonly NearbyResource[], feet: P | null, hint = '', quietUnripe = false): string[] {
  if (!resources.length) return [];
  const first = firstPurpose(hint), order = first ? [first, ...ORDER.filter(purpose => purpose !== first)] : [...ORDER];
  const lines: string[] = [];
  for (const purpose of order) {
    const group = resources.filter(item => item.purpose === purpose);
    if (!group.length) continue;
    const [label, unit] = LABEL[purpose];
    const parts = group.map(item => {
      if (item.count <= 0 || !item.sites.length) return `${item.kind} ${item.range}m 内に なし`;
      // A plan not about the plants gets each plant's nearest place only (every kind stays said; the input stays short).
      const sites = [...item.sites].sort((a, b) => feet ? dist(feet, a) - dist(feet, b) : 0).slice(0, purpose === 'plant' && first !== 'plant' ? 1 : 3);
      const youngHere = (site: NearbySite): boolean => quietUnripe && (purpose === 'plant' || purpose === 'food_village') && CROPS.has(item.kind) && /育ち中/u.test(site.note ?? '');
      const where = feet ? sites.map((site, index) => siteWords(feet, site, index === 0, youngHere(site))).join(' / ')
        : sites.map(site => `${youngHere(site) ? '' : `(${site.x},${site.y},${site.z})`}${site.note ? `（${site.note}）` : ''}`).join(' / ');
      // The lava's count is the sources (the body's `count`), with the pools they make when the body says (`pools`).
      // A cane is counted by its stand (a column of canes), so its unit is 株, not 個 (the body's `plant` entry of sugar_cane).
      const many = purpose === 'lava' ? `源 ${item.count} マス${item.pools !== undefined ? `・溜まり ${item.pools}` : ''}` : `${item.count}${purpose === 'plant' && item.kind === 'sugar_cane' ? '株' : unit}${purpose === 'plant' && item.kind !== 'sugar_cane' && item.count >= 256 ? '以上' : ''}`;
      // A crop that is not grown gives only a seed when it is dug (the planting is lost): said at the row she reads the dig's target from, with the way to grow it.
      const unripe = (purpose === 'plant' || purpose === 'food_village') && CROPS.has(item.kind) && item.sites.some(site => /育ち中/u.test(site.note ?? ''))
        ? (quietUnripe ? QUIET_UNRIPE_WORDS : `。育ち中の株は dig すると種に戻る（植えた分が消える）。育ちは「育ち中 age/最大」で、最大になるまで待つか、骨粉を use して進めてから dig（育った株だけ dig）`) : '';
      return `${item.kind} ${item.range}m 内に ${many}。${where}${unripe}`;
    });
    lines.push(`${label}: ${parts.join('／')}`);
  }
  return lines;
}

/** A pool of the body's `lava` line as the head wrote it (`nearbyLines`): the place, and the sources and the cover its note says. */
export interface LavaSite { x: number; y: number; z: number; sources: number | null; covered: boolean | null }
/**
 * The pools of the `lava` line of `nearby` (the lines `nearbyLines` wrote), nearest first; `range` when the line says 「なし」 (none within it);
 * null when there is no lava line (an older body, or the line was cut).
 */
export function lavaSitesIn(lines: readonly string[]): { range: number; sites: LavaSite[] } | null {
  const line = lines.find(item => item.startsWith(`${LABEL.lava[0]}: `));
  if (!line) return null;
  const range = Number(/(\d+)m 内に/u.exec(line)?.[1] ?? 0);
  const sites = [...line.matchAll(/\((-?\d+),(-?\d+),(-?\d+)\)[^(/／]*?(?:（([^）]*)）)?(?=\s*(?:\/|／|$))/gu)].map((match): LavaSite => {
    const note = match[4] ?? '', sources = /源\s*(\d+)/u.exec(note), cover = /覆い\s*([○×])/u.exec(note);
    return { x: Number(match[1]), y: Number(match[2]), z: Number(match[3]), sources: sources ? Number(sources[1]) : null,
      covered: cover ? cover[1] === '○' : null };
  });
  return { range, sites };
}
