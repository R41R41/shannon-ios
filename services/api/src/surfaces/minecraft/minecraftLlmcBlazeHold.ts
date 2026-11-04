import { countMatching } from './minecraftItems.js';
import { stacks } from './minecraftLlmcLive.js';
import { blazeThreats, onBlaze } from './minecraftLlmcBlazeThreats.js';
import type { readinessOf } from './minecraftLlmcReadiness.js';
import { readPos } from './minecraftLlmcProbeInput.js';

type Facts = NonNullable<ReturnType<typeof readinessOf>>;
type Rec = Record<string, unknown>;
type Cell = { x: number; y: number; z: number };
const rec = (value: unknown): Rec | null => value && typeof value === 'object' ? value as Rec : null;
const holds = new Map<string, number[]>();
const sites = new Map<string, Cell>();
export const BLAZE_HOLDS = 3;
export const BLAZE_WINDOW_MS = 10 * 60_000;
const PICK = /^[a-z]+_pickaxe$/u;
const MEAT = /^(?:(?:cooked_)?(?:beef|porkchop|mutton|chicken|rabbit)|steak)$/u;

export function forgetBlazeHolds(): void {
  holds.clear();
  sites.clear();
}

/** Unknown wear is left unknown; one usable or unmeasured spare pickaxe keeps the way out available. */
function pickaxeLack(facts: Facts): string | null {
  const total = countMatching(facts.counts, PICK);
  if (!total) return 'ツルハシ 0（掘って退く道も使えない）';
  const picks = stacks(facts.world.inventory).filter(line => /^[a-z]+_pickaxe(?:×|\()/u.test(line));
  const low = picks.every(line => {
    const wear = /耐久(\d+)\/(\d+)/u.exec(line);
    return wear !== null && Number(wear[2]) > 0 && Number(wear[1]) / Number(wear[2]) < 0.2;
  });
  const listed = picks.reduce((sum, line) => sum + Number(/×(\d+)/u.exec(line)?.[1] ?? 1), 0);
  return low && listed >= total ? 'ツルハシの耐久がすべて 2 割未満' : null;
}

function shieldLack(facts: Facts): string | null {
  const total = facts.counts.get('shield') ?? 0;
  if (!total) return '盾 0';
  const worn = typeof facts.world.worn === 'string' ? /shield\((?:残り|耐久)\s*(\d+)/u.exec(facts.world.worn) : null;
  const listed = stacks(facts.world.inventory).filter(line => /^shield(?:×|\()/u.test(line));
  const known = listed.map(line => /耐久(\d+)\//u.exec(line)).filter(match => match !== null);
  const left = worn ? Number(worn[1]) : known.length === total ? Math.max(...known.map(match => Number(match[1]))) : null;
  if (left === null) return null;
  if (left <= 30) return `盾の耐久 ${left}（退く合図の 30 以下）`;
  return left <= 60 && total <= 1 ? `盾の耐久 ${left}（60 以下）・予備の盾なし` : null;
}

function retreatReasons(facts: Facts): string[] {
  const visible = blazeThreats(facts.world).filter(blaze => blaze.visible).length;
  const meat = countMatching(facts.counts, MEAT);
  return [pickaxeLack(facts), shieldLack(facts), visible >= 3 ? `射線の中のブレイズ ${visible} 体` : null,
    facts.world.onFire === true ? '燃えている' : null,
    facts.health !== null && facts.health <= 8 ? `体力 ${facts.health}（退く合図の 8 以下）` : null,
    meat <= 3 ? `肉が残り ${meat} 個（退く合図の 3 個以下）` : null].filter((line): line is string => line !== null);
}

const distance = (a: Cell, b: Cell): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const cellText = (at: Cell): string => `(${at.x},${at.y},${at.z})`;

/** Map marks supplement the local map; a camp standing cell alone is not evidence of cover. */
function spawnerOf(world: Rec, cells: readonly Cell[]): Cell | null {
  const marks = (Array.isArray(world.mapLandmarks) ? world.mapLandmarks : []).flatMap(line => {
    if (typeof line !== 'string' || line.startsWith('[') || !/^S\s/u.test(line)) return [];
    const at = /\((-?\d+),(-?\d+),(-?\d+)\)/u.exec(line);
    return at ? [{ x: Number(at[1]), y: Number(at[2]), z: Number(at[3]) }] : [];
  });
  const here = readPos(world.position);
  const all = [...cells, ...marks];
  return here ? all.sort((a, b) => distance(a, here) - distance(b, here))[0] ?? null : all[0] ?? null;
}

/** Only an effective hold consumes a slot; an earlier guard or a harmless inspection consumes none. */
export function blazeFightHold(input: unknown, facts: Facts, spawners: readonly Cell[], taskId?: string, now: () => number = Date.now):
  { hand: number; kind: string; line: string; commit(): void } | null {
  const hands = rec(input)?.hands;
  if (!Array.isArray(hands)) return null;
  const at = hands.findIndex(raw => onBlaze(rec(raw) ?? {}, facts.world));
  if (at < 0) return null;
  const reasons = retreatReasons(facts);
  if (!reasons.length) return null;
  const task = taskId ?? 'unscoped';
  const site = spawnerOf(facts.world, spawners) ?? sites.get(task) ?? null;
  const key = `${task}:${site ? cellText(site) : 'unknown'}`;
  const clock = now();
  const recent = (holds.get(key) ?? []).filter(when => clock - when < BLAZE_WINDOW_MS);
  if (recent.length >= BLAZE_HOLDS) return null;
  const where = site ? `湧き場 ${cellText(site)} から 17m 以上離れた岩の壁の陰` : '湧き場から 17m 以上離れた岩の壁の陰（座標未確認）';
  const line = [`ブレイズと戦う手は送らない: ${reasons.join('・')}。`,
    `退く先は${where}で、射線を切る（経路と遮蔽は地図・around で確認する）。`,
    'ツルハシ・盾・食料を補い、火が消えて体力 20・満腹 18 以上に戻ってから出る。',
    `この湧き場では 10 分に ${BLAZE_HOLDS} 回まで止める（${recent.length + 1}/${BLAZE_HOLDS} 回目）。`].join('\n');
  return { hand: at + 1, kind: String(rec(hands[at])?.do), line, commit: () => {
    holds.set(key, [...recent, clock]);
    if (site) sites.set(task, site);
    if (holds.size > 256) holds.delete(holds.keys().next().value as string);
    if (sites.size > 32) sites.delete(sites.keys().next().value as string);
  } };
}
