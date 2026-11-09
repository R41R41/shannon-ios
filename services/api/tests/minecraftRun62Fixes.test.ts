import { afterEach, describe, expect, it } from 'vitest';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { packLines } from '../src/surfaces/minecraft/minecraftLlmcPack.js';
import { breakingWords } from '../src/surfaces/minecraft/minecraftLlmcPromises.js';
import { forgetTableHolds, TABLE_HOLDS, tableDescentHold } from '../src/surfaces/minecraft/minecraftLlmcTableHold.js';
import { V2_STAGES } from '../src/surfaces/minecraft/minecraftLlmcV2Knowledge.js';
import { doneFacts, parseDoneWhen, predicateHolds } from '../src/surfaces/minecraft/minecraftPlanDone.js';

/** run62 (11/5, the interim of 02:17): the wood node done at 4 logs, the descent with no table, the nightly bed as a broken promise, 81 drops. */
const frame = (items: Array<[string, number]>, world: Record<string, unknown> = {}): BodyObservation => ({ schemaVersion: 1, bodyId: 'b', sequence: 1,
  stateAt: 't', receivedAt: 't', connected: true, facts: {},
  state: { world: { dimension: 'overworld', position: { x: 0, y: 30, z: 0 }, health: 20, food: 20, inventory: items.map(([name, count]) => ({ name, count })),
    ...world } as never } });

afterEach(() => forgetTableHolds());

describe('run62 fixes', () => {
  it('does not take the pickaxe and the axe for the wood of the whole run (log 16, planks 64), only for the tools\' wood', () => {
    const tools = doneFacts(frame([['oak_log', 4], ['stone_pickaxe', 1], ['stone_axe', 1]]))!;
    expect(predicateHolds(parseDoneWhen('have:log>=16|have:planks>=64')!, tools)).toBe(false);
    expect(predicateHolds(parseDoneWhen('have:log>=8')!, tools)).toBe(true);
    expect(predicateHolds(parseDoneWhen('have:planks>=24')!, tools)).toBe(true);
  });
  it('holds the hand that goes 10 down with no table, planks or log, three times at most', () => {
    const down = { hands: [{ do: 'walk', to: { x: 1, y: 30, z: 0 } }, { do: 'vertical', dir: 'down', shape: 'stairs', toY: -11, canDig: ['stone'], liquid: 'stop' }] };
    let clock = 0;
    const now = () => clock;
    for (let i = 1; i <= TABLE_HOLDS; i += 1) {
      const held = tableDescentHold(down, frame([['iron_pickaxe', 1]]), 't', now)!;
      expect(held).toMatchObject({ hand: 2, kind: 'vertical' });
      expect(held.line).toContain(`作業台 無・板 0・原木 0 で 10 段以上下りる手は送らない（${i}/${TABLE_HOLDS} 回目）`);
      held.commit();
      clock += 1_000;
    }
    expect(tableDescentHold(down, frame([['iron_pickaxe', 1]]), 't', now)).toBeNull();
    expect(tableDescentHold(down, frame([['crafting_table', 1]]), 'u', now)).toBeNull();
    expect(tableDescentHold(down, frame([['oak_log', 1]]), 'u', now)).toBeNull();
    expect(tableDescentHold(down, frame([['oak_planks', 4]]), 'u', now)).toBeNull();
  });
  it('does not call the night\'s bed in the overworld a broken promise, and does in the End', () => {
    const promise = { id: 1, item: 'white_bed', count: 10, use: '竜用', state: 'open' } as never;
    const place = [{ do: 'place', block: 'white_bed', at: [{ x: 1, y: 30, z: 0 }] }] as never;
    expect(breakingWords([promise], place, frame([['white_bed', 10]]))).toEqual([]);
    expect(breakingWords([promise], place, frame([['white_bed', 10]], { dimension: 'the_end' })).join('')).toContain('約束 #1');
  });
  it('says to drop the rest of the stone in one act before going down, and to take coal first and not burn the wood', () => {
    const pack = packLines(['cobblestone×300', 'diorite×64', 'granite×40', 'iron_pickaxe×1']).join('\n');
    expect(pack).toContain('下りる前に、余り（');
    expect(pack).toContain('を 1 つの act の drop で一度に捨てる');
    expect(V2_STAGES.prep).toContain('かまどの燃料は石炭を先に取る');
    expect(V2_STAGES.prep).toMatch(/最初の延べ棒3個[\s\S]*所持・作成済みを引いた残り[\s\S]*総目安24〜36・石炭6/u);
  });
});
