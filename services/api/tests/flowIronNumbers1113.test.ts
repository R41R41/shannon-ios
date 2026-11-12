import { describe, expect, it } from 'vitest';
import { inFurnaceOf, ironArmorLine, ironLack } from '../src/surfaces/minecraft/minecraftLlmcIronNumbers.js';
import { rewriteLlmcLive } from '../src/surfaces/minecraft/minecraftLlmcLiveRewrite.js';

/**
 * 2026-11-13 (flow design E, run 9: six ores could be smelted at +857 s and 14 were dug anew): the iron armour's numbers in one line, only while the
 * armour is the current or next node; raw ore in hand with a furnace near says smelt before digging.
 */
const base = { ingots: 1, raw: 4, inFurnace: 2, haveHelmet: false, haveChestplate: false, furnaceNear: false };

describe('the iron armour line', () => {
  it('counts the helmet and the chestplate against the ingots, the raw ore and the furnace, and says how many are lacking', () => {
    expect(ironLack(base)).toEqual({ need: 13, lack: 6 });
    expect(ironArmorLine(base)).toBe('鉄の防具: 兜 5＋胸当て 8＝13、今 インゴット 1・原石 4・炉の中 2 → あと 6');
  });
  it('leaves out a piece she has, says enough when nothing is lacking, and is null with both pieces', () => {
    expect(ironArmorLine({ ...base, haveHelmet: true })).toBe('鉄の防具: 胸当て 8＝8、今 インゴット 1・原石 4・炉の中 2 → あと 1');
    expect(ironArmorLine({ ...base, ingots: 9, haveHelmet: true })).toContain('あと 0（足りる。焼けたら作る）');
    expect(ironArmorLine({ ...base, haveHelmet: true, haveChestplate: true })).toBeNull();
  });
  it('says smelt before digging only with raw ore and a furnace near, and the dig is the lack alone', () => {
    expect(ironArmorLine(base)).not.toContain('焼いてから掘る');
    expect(ironArmorLine({ ...base, furnaceNear: true })).toContain('原石 raw_iron×4 は焼いてから掘る（tidy か smelt。掘るのは足りない 6 個だけ・1 手 16 まで）');
    expect(ironArmorLine({ ...base, raw: 0, furnaceNear: true })).not.toContain('焼いてから掘る');
  });
  it('reads the ore in the furnace from job lines and objects', () => {
    expect(inFurnaceOf(['furnace (188,35,-195): raw_iron×5', 'furnace (1,2,3): raw_beef×4'], [{ input: 'raw_iron', count: 3 }, { input: 'beef', count: 9 }])).toBe(8);
    expect(inFurnaceOf(undefined, 'x')).toBe(0);
  });
});

describe('in body.pack of the live state', () => {
  const live = (kind: string, extra: Record<string, unknown> = {}) => ({ body: { inventory: ['iron_ingot×1', 'raw_iron×4', 'coal×3', 'cobblestone×20'],
    state: { freeSlots: 20, rememberedPlaces: { furnace: '5m 北 (1,2,3)' }, ...extra }, planFacts: { now: { id: 'p1', kind }, above: [], next: [] } } });
  const pack = (value: Record<string, unknown>): string[] => ((rewriteLlmcLive(value).live.body as { pack?: string[] }).pack ?? []);
  it('adds the line while the node is the iron armour (with the furnace near, smelt first), and not for another node', () => {
    const lines = pack(live('iron_armor'));
    expect(lines.find(line => line.startsWith('鉄の防具:'))).toContain('あと 8');
    expect(lines.join('\n')).toContain('焼いてから掘る');
    expect(pack(live('wood')).join('\n')).not.toContain('鉄の防具');
  });
  it('leaves out the pieces worn and does not say smelt first when the furnace is far', () => {
    const lines = pack({ body: { ...(live('iron_armor').body), state: { freeSlots: 20, worn: '頭: iron_helmet(残り 160)、胴: なし', rememberedPlaces: { furnace: '40m 北 (1,2,3)' } } } });
    const line = lines.find(item => item.startsWith('鉄の防具:'))!;
    expect(line).toContain('胸当て 8＝8');
    expect(line).not.toContain('焼いてから掘る');
  });
});
