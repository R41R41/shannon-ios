/**
 * 2026-11-13 (flow design E, run 9: at +857 s six ores could be smelted, and 14 were dug anew; limit_dig and make-missing failures followed): while the plan's
 * current or next node is the iron armour, one line of the numbers: what the helmet and the chestplate cost, what she has (ingots, raw ore, ore in the
 * furnace) and how many are still lacking; with raw ore in hand and a furnace near, the way is smelt first, then dig only the lack. Facts and the
 * table's own numbers; nothing is sent or refused. The lack is what the dig's `count` may be (one dig hand takes 16 at most).
 */
export const HELMET = 5;
export const CHESTPLATE = 8;
export interface IronNumbers {
  ingots: number;
  raw: number;
  /** Ore being smelted now (it comes out as ingots). */
  inFurnace: number;
  /** The pieces already carried or worn. */
  haveHelmet: boolean;
  haveChestplate: boolean;
  furnaceNear: boolean;
}
/** The iron still lacking for the pieces not yet had, after the ingots, the raw ore and the furnace's ore (never below 0). */
export function ironLack(numbers: IronNumbers): { need: number; lack: number } {
  const need = (numbers.haveHelmet ? 0 : HELMET) + (numbers.haveChestplate ? 0 : CHESTPLATE);
  return { need, lack: Math.max(0, need - numbers.ingots - numbers.raw - numbers.inFurnace) };
}
/** The line, or null when both pieces are had. */
export function ironArmorLine(numbers: IronNumbers): string | null {
  const { need, lack } = ironLack(numbers);
  if (need === 0) return null;
  const parts = [...numbers.haveHelmet ? [] : [`兜 ${HELMET}`], ...numbers.haveChestplate ? [] : [`胸当て ${CHESTPLATE}`]].join('＋');
  const head = `鉄の防具: ${parts}＝${need}、今 インゴット ${numbers.ingots}・原石 ${numbers.raw}・炉の中 ${numbers.inFurnace} → あと ${lack}`;
  const smeltFirst = numbers.raw > 0 && numbers.furnaceNear ? `。原石 raw_iron×${numbers.raw} は焼いてから掘る（tidy か smelt。掘るのは足りない ${lack} 個だけ・1 手 16 まで）` : '';
  return `${head}${lack === 0 ? '（足りる。焼けたら作る）' : ''}${smeltFirst}`;
}
const text = (value: unknown): string => typeof value === 'string' ? value : '';
const num = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) ? value : 0;
/** Raw iron being smelted, from the body's job lines (`raw_iron×5` in a line, or `{input, count}`): `jobs` of the frame or of its state. */
export function inFurnaceOf(...sources: unknown[]): number {
  let total = 0;
  for (const source of sources) {
    for (const job of Array.isArray(source) ? source.slice(0, 16) : []) {
      if (typeof job === 'string') total += Number(/raw_iron[×x](\d+)/u.exec(job)?.[1] ?? 0);
      else if (job && typeof job === 'object' && /^(?:raw_)?iron(?:_ore)?$/u.test(text((job as { input?: unknown }).input))) total += num((job as { count?: unknown }).count);
    }
  }
  return total;
}
