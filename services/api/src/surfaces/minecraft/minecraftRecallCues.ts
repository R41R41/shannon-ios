import type { BodyObservation } from '../../contracts/bodyControlContract.js';
import type { BodyRecallCues } from '../../mind/recall/bodyTaskRecall.js';
import type { MinecraftSituation } from './minecraftSkillPointers.js';

/**
 * What a body task's recall looks for now (`bodyTaskRecall.ts`), from the situation the skill pointers read (`minecraftSituation`), the
 * threats in view, the latest failed calls and a death the body reports: words its records are written in (Japanese and the game's ids),
 * the words of a danger now (`urgent`), and closed tags for the measurement line. Facts only; nothing here is shown to the model.
 */
const STAGE_WORDS: Readonly<Record<number, readonly string[]>> = Object.freeze({
  1: ['原木', '作業台', '木のツルハシ', 'wooden_pickaxe', 'oak_log'],
  2: ['丸石', '石のツルハシ', 'stone_pickaxe', 'ベッド', '羊', '石炭', 'coal'],
  3: ['鉄', 'iron', 'かまど', 'furnace', '精錬', 'バケツ'],
  4: ['鉄のツルハシ', 'iron_pickaxe', 'ダイヤ', 'diamond', '黒曜石', 'obsidian', 'ネザー'],
});
const ENTITY_WORDS: Readonly<Record<string, string>> = Object.freeze({ zombie: 'ゾンビ', skeleton: 'スケルトン', creeper: 'クリーパー',
  spider: 'クモ', enderman: 'エンダーマン', blaze: 'ブレイズ', piglin: 'ピグリン', ghast: 'ガスト', wither_skeleton: 'ウィザースケルトン',
  drowned: 'ドラウンド', witch: 'ウィッチ', phantom: 'ファントム', ender_dragon: 'ドラゴン' });
const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
type Add = (tag: string, ...found: readonly string[]) => void;

/** The threats in view, by the game's id and in Japanese. */
function threatWords(world: Record<string, unknown>): string[] {
  const names = list(world.nearbyThreats).flatMap(item => {
    const name = record(item)?.name;
    return typeof name === 'string' ? [name.replace(/^minecraft:/u, '')] : [];
  });
  return [...new Set(names.flatMap(name => [name, ...(ENTITY_WORDS[name] ? [ENTITY_WORDS[name]!] : [])]))];
}

/** A death counts as now for this long: the body lists those of the last day (B's `world.deaths`, newest last), not all of them news. */
const RECENT_DEATH_MILLISECONDS = 15 * 60_000;

/** The body's newest death, when it was recent: the entities its cause names (`cause` is the server's line), by id and in Japanese. */
function recentDeath(world: Record<string, unknown>, now: number): string[] | null {
  const newest = record(list(world.deaths).at(-1));
  const at = typeof newest?.at === 'string' ? Date.parse(newest.at) : NaN;
  if (!newest || !Number.isFinite(at) || now - at > RECENT_DEATH_MILLISECONDS) return null;
  const cause = typeof newest.cause === 'string' ? newest.cause.toLowerCase() : '';
  return Object.entries(ENTITY_WORDS).filter(([id]) => cause.includes(id.replace(/_/gu, ' ')) || cause.includes(id)).flat();
}

/** The dangers now: night, a threat, low health, a death the body reports in its frame's `deaths` (structured; `lastDeath` is a line). */
function dangerCues(world: Record<string, unknown>, situation: MinecraftSituation, now: number, danger: Add): void {
  if (situation.night || situation.darkSoon) danger('night', '夜', '暗', '退避', '縦穴', '地下');
  if (situation.threatNear) danger('threat', '敵', '逃げ', ...threatWords(world));
  if (situation.lowHealth) danger('lowHealth', '体力', '回復', '逃げ', '死');
  const death = recentDeath(world, now);
  if (death) danger('died', '死', '死んだ', ...death);
}

/** Where she is on the way: hunger, the bed, the dimension, the stage, a stall and the calls that failed last. */
function progressCues(world: Record<string, unknown>, situation: MinecraftSituation, recent: ReadonlyArray<{ name: string; ok: boolean }>, add: Add): void {
  if (situation.hungry) add('hungry', '食料', '空腹', '肉', '食べ');
  if (situation.bedWanted) add('bed', 'ベッド', '羊', 'bed', 'wool');
  if (situation.inNether) add('nether', 'ネザー', 'nether', ...(situation.blazeNear ? ['ブレイズ', 'blaze'] : []));
  if (world.dimension === 'the_end') add('end', 'エンド', '虚空', 'ドラゴン', 'ender_dragon');
  if (situation.stage !== null) add(`stage${situation.stage}`, ...STAGE_WORDS[situation.stage] ?? []);
  if (situation.stalled) add('stalled', '進まない', '失敗');
  const failed = [...new Set(recent.filter(result => !result.ok).slice(-3).map(result => result.name.replace(/^(?:mc|minecraft)\./u, '')))];
  if (failed.length) add('failure', ...failed);
}

export function minecraftRecallCues(observation: BodyObservation | null, situation: MinecraftSituation,
  recent: ReadonlyArray<{ name: string; ok: boolean }>, now = Date.now()): BodyRecallCues {
  const words: string[] = [], tags: string[] = [], urgent: string[] = [];
  const world = record(observation?.state.world) ?? {};
  dangerCues(world, situation, now, (tag, ...found) => {
    tags.push(tag);
    urgent.push(...found);
  });
  progressCues(world, situation, recent, (tag, ...found) => {
    tags.push(tag);
    words.push(...found);
  });
  return { words: [...new Set(words)], tags: [...new Set(tags)], urgent: [...new Set(urgent)] };
}
