type Cell = { x: number; y: number; z: number };
interface RushArea { center: Cell; radius: number; maxDrop: number }
export type RushCode = 'TARGET_LOST' | 'HEIGHT_UNREACHABLE' | 'NO_ATTACK_WINDOW' | 'CROSSFIRE' | 'SHIELD_LOW'
  | 'RETREAT_BLOCKED' | 'PICKUP_UNSAFE' | 'TIME_LIMIT' | 'REFLEX' | 'DEAD';
export type RushState = 'BLOCK' | 'CLOSE' | 'STRIKE' | 'PICKUP' | 'RETREAT';
export interface ShieldRushArgs {
  target: string; seconds: number; retreatHp: number; retreatTo: Cell; area: RushArea;
  shieldReserve: number; onCrossfire: 'retreat' | 'continue'; pickup: 'target_drops' | 'none';
}
export interface ShieldRushResult {
  status: 'killed' | 'retreated' | 'failed' | 'cut'; targetDead: boolean | null; code: RushCode | null;
  hits: number; rodsDelta: number; hpMin: number; hpEnd: number; shieldBefore: number; shieldAfter: number; elapsedMs: number;
  at: Cell; safe: boolean; pendingDrops: Array<{ id: number; at: Cell }>;
}

export const SHIELD_RUSH_DESCRIPTION = 'attack style=shield_rush: 見たブレイズ1体の target(#id)・seconds(5〜60、帰還込み)・retreatHp(1〜19の整数)・retreatTo({x,y,z})・'
  + 'area({center:{x,y,z},radius:1〜16,maxDrop:0〜3の整数})・shieldReserve(0〜335)・onCrossfire(retreat/continue)・pickup(target_drops/none)は全て必須。座標は絶対座標（rel不可）。'
  + '盾を構えて詰めて打ち、指定した落とし物を拾って退避先へ戻る。再出撃・食事はしない。施工はretreatToがarea外の退避goだけで、cobblestone/netherrackを最大6個置ける。'
  + '結果の shieldRush は status(killed/retreated/failed/cut)・targetDead(true/false/null)・'
  + 'code(TARGET_LOST/HEIGHT_UNREACHABLE/NO_ATTACK_WINDOW/CROSSFIRE/SHIELD_LOW/RETREAT_BLOCKED/PICKUP_UNSAFE/TIME_LIMIT/REFLEX/DEAD/null)と実測値。'
  + 'retreatHpで帰れた時はretreated/code:null。';

const objectOf = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const range = (value: unknown, low: number, high: number): boolean =>
  typeof value === 'number' && Number.isFinite(value) && value >= low && value <= high;
const pos = (value: unknown): boolean => {
  const cell = objectOf(value);
  return !!cell && Object.keys(cell).length === 3 && ['x', 'y', 'z'].every(key => typeof cell[key] === 'number' && Number.isFinite(cell[key]));
};
const ALLOWED = new Set(['do', 'style', 'target', 'seconds', 'retreatHp', 'retreatTo', 'area', 'shieldReserve',
  'onCrossfire', 'pickup', 'note', 'onFail', 'dependsOn']);
const area = (value: unknown): boolean => {
  const a = objectOf(value);
  return !!a && Object.keys(a).every(key => ['center', 'radius', 'maxDrop'].includes(key)) && pos(a.center)
    && range(a.radius, 1, 16) && Number.isInteger(a.maxDrop) && range(a.maxDrop, 0, 3);
};
const FORMS: ReadonlyArray<readonly [keyof ShieldRushArgs, (value: unknown) => boolean, string]> = [
  ['target', value => typeof value === 'string' && /^#\d+$/u.test(value) && Number.isSafeInteger(Number(value.slice(1))), '"#id"（ブレイズ1体）'],
  ['seconds', value => range(value, 5, 60), '5〜60 の数（帰還込み）'],
  ['retreatHp', value => Number.isInteger(value) && range(value, 1, 19), '1〜19 の整数'],
  ['retreatTo', pos, '{x,y,z}（絶対座標）'],
  ['area', area, '{center:{x,y,z},radius:1〜16,maxDrop:0〜3の整数}'],
  ['shieldReserve', value => range(value, 0, 335), '0〜335 の数'],
  ['onCrossfire', value => value === 'retreat' || value === 'continue', '"retreat" か "continue"'],
  ['pickup', value => value === 'target_drops' || value === 'none', '"target_drops" か "none"'],
];

/** Check the body's permissions as written; no defaults or repairs. */
export function shieldRushProblem(hand: Record<string, unknown>): string | null {
  const extra = Object.keys(hand).filter(key => !ALLOWED.has(key));
  if (extra.length) return `${extra.join('・')} は使えない（shield_rush の欄: ${[...ALLOWED].join('・')}。座標は絶対座標）`;
  const invalid = FORMS.find(([key, valid]) => !valid(hand[key]));
  return invalid ? `${invalid[0]} は ${invalid[2]} が要る` : null;
}
