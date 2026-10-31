import { COOKED_FOOD } from './minecraftFoodPreparation.js';

/** Shared by the initial/revised strategy and the preparation's procedural knowledge. */
export const FOOD_ACQUISITION_KNOWLEDGE = [
  '### 食料源の選び方',
  '- 不足分を補うまでの移動・捕獲・回収・調理の手間と危険、1個の食料点と入手見込み数を比べる。'
    + '見えている数や距離だけでは、取れる数・通れる道・安全は分からない。',
  '- 手持ちの加工、到達できる陸上動物、確認した村の干し草・育った畑・箱を優先して比べる。'
    + '炉・燃料・作業台・安全な作業位置も含め、無い食料源を想定しない。周りに無ければ地表の未探索方向と帰路を調べる。',
  '- 魚は、岸や浅瀬から短く安全に取れて、回収と戻り方が確認できる時の補助。'
    + '潜水・追跡・掘削が要る魚を主食の目標にしない。熱帯魚は低栄養で調理不可、焼けるタラ・サケと分ける。',
  '- 短い試行で食料在庫が増えなければ、続ける費用と他の食料源を評価し直す。'
    + '届かない・接近できない時は、射程や秒数だけを増やさず、経路や回収が成立する条件の変化が無ければ別候補や地表探索へ切り替える。',
  '- 瀕死・飢えでは、今ある食事と安全な退避を先にする。加工見込み・攻撃回数を確保済みの食料には数えない。',
].join('\n');

/** A food item's value, not a claim about how many drops this creature will give. */
const FOOD_DROP: Readonly<Record<string, string>> = Object.freeze({
  cow: 'beef', mooshroom: 'beef', pig: 'porkchop', sheep: 'mutton', chicken: 'chicken', rabbit: 'rabbit',
  cod: 'cod', salmon: 'salmon', tropical_fish: 'tropical_fish',
});

export function foodYieldWords(name: string, values: Readonly<Record<string, number>>): string {
  const item = FOOD_DROP[name], raw = values[item], cooked = COOKED_FOOD[item];
  if (!Number.isFinite(raw)) return '';
  const after = values[cooked];
  return `（${item} ${raw}点${Number.isFinite(after) ? `→調理後${after}点` : '・調理不可'}）`;
}

/** Presentation only: a school of nearby fish cannot crowd land food out of a shortened input.
 * Retain a nearby fish alternative too; an accessible fish may be safer than an unverified land route. */
export function foodChoices<T extends { name: string }>(all: readonly T[], limit: number, fishNames: ReadonlySet<string>): T[] {
  if (!Number.isFinite(limit) || limit < 1) return [];
  const count = Math.floor(limit), land = all.filter(item => !fishNames.has(item.name)), fish = all.filter(item => fishNames.has(item.name));
  const landCount = land.length && fish.length && count > 1 ? Math.min(land.length, count - 1) : Math.min(land.length, count);
  return [...land.slice(0, landCount), ...fish.slice(0, count - landCount)];
}
