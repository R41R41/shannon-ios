import { beforeEach, describe, expect, it } from 'vitest';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { heldOfFrame } from '../src/surfaces/minecraft/minecraftLlmcPartial.js';
import { forgetNightWaitHolds, NIGHT_WAIT_HOLDS, NIGHT_WAIT_WINDOW_MS, nightWaitHold } from '../src/surfaces/minecraft/minecraftLlmcNightWaitHold.js';
import { forgetSleepHolds } from '../src/surfaces/minecraft/minecraftLlmcSleepHold.js';
import { forgetTableHolds, tableDescentHold } from '../src/surfaces/minecraft/minecraftLlmcTableHold.js';
import { expandShortAct } from '../src/contracts/minecraftActShortContract.js';
import { llmcPrepare } from '../src/surfaces/minecraft/minecraftLlmc.js';
import { MC_ACT_TOOL } from '../src/contracts/minecraftActTypes.js';

/**
 * The night's wait while the way down is open (the coordinator, 11/10 6:55; end1110r1 night 2: a hole and `wait 30` ten times). With no bed, a pickaxe
 * and the night line's dig choice, the first wait is held unless a hand before it works down; at most three holds in ten minutes.
 */
const pack = (items: ReadonlyArray<readonly [string, number]>) => items.map(([name, count]) => ({ name, count }));
const frame = (items: ReadonlyArray<readonly [string, number]>, world: Record<string, unknown> = {}): BodyObservation => ({ schemaVersion: 1, bodyId: 'b',
  sequence: 1, stateAt: 't', receivedAt: 't', connected: true, facts: {},
  state: { world: { dimension: 'overworld', position: { x: -21.5, y: 62, z: 18.5 }, health: 20, food: 18, time: '14000', inventory: pack(items), worn: '',
    mapLandmarks: [], ...world } as never } });
const KIT: Array<[string, number]> = [['stone_pickaxe', 1], ['crafting_table', 1], ['oak_planks', 8], ['stick', 4]];
const sealWait = { hands: [{ do: 'vertical', dir: 'down', toY: 60 }, { do: 'place', block: 'dirt', at: { x: -22, y: 62, z: 18 } }, { do: 'wait', seconds: 30 }] };

beforeEach(() => { forgetNightWaitHolds(); forgetSleepHolds(); forgetTableHolds(); });

describe('the night\'s wait with the way down open', () => {
  it('sends the seal and holds the wait, with the night line\'s act', () => {
    const held = nightWaitHold(sealWait, frame(KIT), 't1');
    expect(held).toMatchObject({ hand: 3, kind: 'wait' });
    for (const word of ['穴で待つ wait は送らない', '1/3 回目', '次の 1 手 mc_act ["vertical down shaft y=60', 'vertical down stairs north y=16']) expect(held!.line, word).toContain(word);
    expect(heldOfFrame(sealWait, frame(KIT), 't1')).toMatchObject({ hand: 3, code: 'night_dig', kind: 'wait' });
  });
  it('G23: with no table, planks or log the held wait is given the sealed shaft 9 down, an act the checks and the table hold take', () => {
    const bare = frame([['stone_pickaxe', 1]]);
    const held = nightWaitHold(sealWait, bare, 'g23')!;
    const hands = JSON.parse(/mc_act (\[[^\]]*\])/u.exec(held.line)![1]!) as string[];
    expect(hands).toHaveLength(3);
    expect(hands[2]).toMatch(/^vertical down shaft y=53 dig=/u);
    expect(hands.some(hand => hand.startsWith('go '))).toBe(false);
    const expanded = expandShortAct({ hands, why: 'test' });
    expect(expanded.errors).toEqual([]);
    expect(llmcPrepare(MC_ACT_TOOL, expanded.input).problem).toBeNull();
    expect(tableDescentHold(expanded.input, bare, 'g23')).toBeNull();
  });
  it('holds with a wooden pickaxe too (the stone pickaxe made in the shaft), and the wait alone', () => {
    const wooden = nightWaitHold({ hands: [{ do: 'wait', seconds: 30 }] }, frame([['wooden_pickaxe', 1], ['crafting_table', 1], ['oak_planks', 8], ['stick', 5]]), 'w');
    expect(wooden).toMatchObject({ hand: 1 });
    expect(wooden!.line).toContain('craft stone_pickaxe 1');
  });
  it('passes by day, with a bed, with no pickaxe, an enemy within 8 m, or a hand before the wait that works down', () => {
    expect(nightWaitHold(sealWait, frame(KIT, { time: '6000' }), 'a')).toBeNull();
    expect(nightWaitHold(sealWait, frame([...KIT, ['white_bed', 1]]), 'b')).toBeNull();
    expect(nightWaitHold(sealWait, frame([['oak_planks', 8]]), 'c')).toBeNull();
    expect(nightWaitHold(sealWait, frame(KIT, { nearbyThreats: [{ name: 'zombie', distance: 5 }] }), 'd')).toBeNull();
    expect(nightWaitHold({ hands: [{ do: 'vertical', dir: 'down', toY: 16 }, { do: 'wait', seconds: 5 }] }, frame(KIT), 'e')).toBeNull();
    expect(nightWaitHold({ hands: [{ do: 'mine', block: 'iron_ore', count: 3 }, { do: 'wait', seconds: 5 }] }, frame(KIT), 'f')).toBeNull();
    expect(nightWaitHold({ hands: [{ do: 'go', to: { x: 0, y: 62, z: 0 } }] }, frame(KIT), 'g')).toBeNull();
  });
  it('holds at most three times in ten minutes for a task, counted only when it stops the act', () => {
    let clock = 1_000_000;
    for (let index = 0; index < NIGHT_WAIT_HOLDS; index += 1) nightWaitHold(sealWait, frame(KIT), 'n', () => clock)!.commit();
    expect(nightWaitHold(sealWait, frame(KIT), 'n', () => clock)).toBeNull();
    clock += NIGHT_WAIT_WINDOW_MS;
    expect(nightWaitHold(sealWait, frame(KIT), 'n', () => clock)).not.toBeNull();
    expect(nightWaitHold(sealWait, frame(KIT), 'other', () => 0)).not.toBeNull();
  });
});
