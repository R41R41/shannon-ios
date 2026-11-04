import type { ActPos } from './minecraftActTypes.js';

export interface FillGroup { stand: ActPos; at: readonly ActPos[] }
export interface FillArgs { groups: readonly FillGroup[]; block: string; retreatHp: number; retreatTo: ActPos; seconds: number }
export type FillCode = 'HP_FLOOR' | 'TIME_LIMIT' | 'NO_STAND' | 'NO_BLOCKS' | 'RETREAT_BLOCKED' | 'REFLEX' | 'DEAD';
export interface FillResult {
  status: 'done' | 'partial' | 'retreated' | 'failed' | 'cut';
  code: FillCode | null;
  placed: number;
  /** Unfinished cells, at most 40. */
  remaining: ActPos[];
  skippedBy: { creature: number; reach: number; hazard: number; other: number };
  hpMin: number; hpEnd: number; elapsedMs: number; at: ActPos; safe: boolean;
  /** Reached retreatTo; separate from safe, which also requires no shooter seeing the end position. */
  reached?: boolean;
  /** Number of shooters seeing the end position. */
  seen?: number;
}

export const FILL_DESCRIPTION = 'fill: groups(1〜12組、各{stand:{x,y,z},at:[{x,y,z},…1〜8マス]})・block・'
  + 'retreatHp(1〜19の整数、以下で置くのを中止)・retreatTo({x,y,z}、遮蔽の足)・seconds(5〜60、帰還込み)は全て必須。'
  + '座標は絶対座標（rel不可）。'
  + '指定順に置き、帰還を試みる。'
  + '結果は行の fill。'
  + 'reached は退避先に着いたか、seen は見ている射手の数。'
  + 'safe は着き、かつ射手に見られていない時だけ true。'
  + 'safe:false だけでは未到着とは限らない。';

const objectOf = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const range = (value: unknown, low: number, high: number): boolean =>
  typeof value === 'number' && Number.isFinite(value) && value >= low && value <= high;
const pos = (value: unknown): boolean => {
  const cell = objectOf(value);
  return !!cell && Object.keys(cell).length === 3
    && ['x', 'y', 'z'].every(key => typeof cell[key] === 'number' && Number.isFinite(cell[key]));
};
const groups = (value: unknown): boolean => Array.isArray(value) && value.length >= 1 && value.length <= 12
  && value.every(raw => {
    const group = objectOf(raw);
    return !!group && Object.keys(group).every(key => key === 'stand' || key === 'at') && pos(group.stand)
      && Array.isArray(group.at) && group.at.length >= 1 && group.at.length <= 8 && group.at.every(pos);
  });
const ALLOWED = new Set(['do', 'groups', 'block', 'retreatHp', 'retreatTo', 'seconds', 'note', 'onFail', 'dependsOn']);
const FORMS: ReadonlyArray<readonly [keyof FillArgs, (value: unknown) => boolean, string]> = [
  ['groups', groups, '[{stand:{x,y,z},at:[{x,y,z},…]}]（1〜12組、at は1〜8マス、絶対座標）'],
  ['block', value => typeof value === 'string' && /^[a-z][a-z0-9_]{0,39}$/u.test(value), 'ブロックの id（小文字の英字・数字・_、40字まで）'],
  ['retreatHp', value => Number.isInteger(value) && range(value, 1, 19), '1〜19 の整数'],
  ['retreatTo', pos, '{x,y,z}（遮蔽の足の絶対座標）'],
  ['seconds', value => range(value, 5, 60), '5〜60 の数（帰還込み）'],
];

/** Validate the body's required permissions as written, without defaults or repairs. */
export function fillProblem(hand: Record<string, unknown>): string | null {
  const extra = Object.keys(hand).filter(key => !ALLOWED.has(key));
  if (extra.length) return `${extra.join('・')} は使えない（fill の欄: ${[...ALLOWED].join('・')}。座標は絶対座標）`;
  const invalid = FORMS.find(([key, valid]) => !valid(hand[key]));
  return invalid ? `${invalid[0]} は ${invalid[2]} が要る` : null;
}
