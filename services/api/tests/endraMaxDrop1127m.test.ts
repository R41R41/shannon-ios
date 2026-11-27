import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ACT_DESCRIPTION, ACT_INPUT_SCHEMA } from '../src/contracts/minecraftActContract.js';
import { lineToHand } from '../src/contracts/minecraftActShortHands.js';
import { llmcInputProblem } from '../src/surfaces/minecraft/minecraftLlmc.js';
import { validSkillInput } from '../src/surfaces/minecraft/minecraftControlValidation.js';
import { MAX_DROP_CAP } from '../src/surfaces/minecraft/minecraftEndFacts.js';

/**
 * Run 15 (Haiku, 11/27, run c45d48a1): the head refused the descent's `go ... maxDrop=32` (d0090) and `maxDrop=36` (d0102) with "0〜10", while the body (f92e6460) takes 0 to 70.
 * The fixture is the mc.act inputs of those decisions as the model wrote them (read from the VM's decision record), with the refusals the record holds. Written in 1127m.
 */
interface Real { decision: string; recordedRefusal: string; input: { hands: Array<Record<string, any>> } }
const REAL = JSON.parse(readFileSync(new URL('./fixtures/endra1127m/real-hands-c45d48a1.json', import.meta.url), 'utf8')) as Real[];
const byId = (id: string) => REAL.find(item => item.decision === id)!;
/** What 58af8cf6's contract said: the same schema with maxDrop's top at 10. */
const before = JSON.parse(JSON.stringify(ACT_INPUT_SCHEMA)) as typeof ACT_INPUT_SCHEMA;
(before.properties.hands.items.properties as Record<string, any>).maxDrop.maximum = 10;

describe('go maxDrop up to 70, as the body takes it (1127m)', () => {
  it('has the cap of the body: the schema, and the cap of the End line', () => {
    expect((ACT_INPUT_SCHEMA.properties.hands.items.properties as Record<string, any>).maxDrop).toMatchObject({ type: 'integer', minimum: 0, maximum: 70 });
    expect(MAX_DROP_CAP).toBe(70);
  });
  it('says what 11 and over mean (the End only, the bucket, health 18, the dragon not reaching; the body judges and says what is missing) in the schema and the tool text', () => {
    const description = String((ACT_INPUT_SCHEMA.properties.hands.items.properties as Record<string, any>).maxDrop.description);
    for (const part of ['10 まで', '11 以上はエンドだけ', '水バケツ', '体力 18 以上', '火の玉', '息の雲', '70 まで', '欠けた条件を返す']) expect(description).toContain(part);
    expect(ACT_DESCRIPTION).toContain('maxDrop（10 まで。11 以上はエンドだけ');
  });
  it.each(['d0090', 'd0102'])('takes the hands of %s as the model wrote them (it refused them before: 0〜10)', id => {
    const { input, recordedRefusal } = byId(id);
    expect(recordedRefusal).toContain('maxDrop は 0〜10');
    expect(llmcInputProblem('mc.act', input)).toBeNull();
    expect(validSkillInput(input, ACT_INPUT_SCHEMA)).toBe(true);
    expect(validSkillInput(input, before)).toBe(false);
  });
  it('still refuses 71 and a negative or fractional drop', () => {
    const go = (maxDrop: number) => ({ hands: [{ do: 'go', to: { x: 3, y: 66, z: -12 }, maxDrop }], why: '[p1] x' });
    expect(llmcInputProblem('mc.act', go(70))).toBeNull();
    for (const bad of [71, -1, 2.5]) expect(llmcInputProblem('mc.act', go(bad))).toContain('maxDrop');
  });
  it('takes the line the descent writes, "go x,y,z range=3 maxDrop=N", behind an equip', () => {
    for (const drop of [11, 42, 70]) {
      const hand = lineToHand(`go 4,65,11 range=3 maxDrop=${drop}`);
      expect(hand).toMatchObject({ do: 'go', range: 3, maxDrop: drop });
      expect(llmcInputProblem('mc.act', { hands: [{ do: 'equip', item: 'water_bucket' }, hand], why: '[p1] x' })).toBeNull();
    }
  });
  it('leaves d0097 refused: canDig [] is outside 1〜12 in the head and in the body (act.ts: min(1)), a type mistake of the model and not a drift', () => {
    const { input, recordedRefusal } = byId('d0097');
    expect(recordedRefusal).toContain('canDig は 1〜12 個');
    expect(llmcInputProblem('mc.act', input)).toContain('canDig は 1〜12 個');
    const mended = { ...input, hands: [{ ...input.hands[0], canDig: undefined }] };
    expect(llmcInputProblem('mc.act', JSON.parse(JSON.stringify(mended)))).toBeNull();
  });
});
