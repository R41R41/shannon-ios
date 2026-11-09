import { afterEach, describe, expect, it } from 'vitest';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { heldOfFrame } from '../src/surfaces/minecraft/minecraftLlmcPartial.js';
import { deathReturnHold, forgetDeathHolds, RETURN_HOLDS, suicideHold } from '../src/surfaces/minecraft/minecraftLlmcDeathHolds.js';

/** run62 (11/5): twenty decisions to die on purpose, and five deaths to the same wither skeletons straight from the respawn. */
const DEATH = '2分前 the_nether (89,67,40) 「Wither Skeleton に倒された」 落とした物: iron_sword×1';
const frame = (items: Array<[string, number]>, world: Record<string, unknown> = {}): BodyObservation => ({ schemaVersion: 1, bodyId: 'b', sequence: 1,
  stateAt: 't', receivedAt: 't', connected: true, facts: {},
  state: { world: { dimension: 'the_nether', position: { x: 0, y: 64, z: 0 }, health: 20, food: 20, inventory: items.map(([name, count]) => ({ name, count })),
    lastDeath: DEATH, deaths: [{ dimension: 'the_nether' }], worn: '', ...world } as never } });

afterEach(() => forgetDeathHolds());

describe('the deaths of run62', () => {
  it('holds an act whose why says it goes to die, whole', () => {
    const act = { why: '[n31] 持ち物なし。溶岩／マグマ／落下で倒れて地上で再開', hands: [{ do: 'go', to: { x: 16, y: 67, z: 15 } }] };
    expect(suicideHold(act)).toMatchObject({ hand: 1, kind: 'go' });
    expect(suicideHold(act)!.line).toContain('わざと死ぬ手は送らない');
    expect(heldOfFrame(act, frame([]), 's')).toMatchObject({ hand: 1, code: 'no_suicide' });
    expect(suicideHold({ why: '[n12] ゾンビを倒してから進む', hands: [{ do: 'fight', target: 'zombie' }] })).toBeNull();
  });
  it('reads the whys of run62 with nothing in the pack, and leaves ordinary work with tools alone', () => {
    const whys = ['持ち物なし。溶岩で戻る', '持ち物なし。マグマで倒れ地上で再開', '持ち物なし。下の溶岩へ降り地上で再開', '持ち物なし。落下で倒れ地上で再開',
      '溶岩の縁へ。持ち物なし', '縁から落ちて地上で再開', '溶岩へ落ちる', '溶岩の上へ', '動けない。敵が来るのを待つ', 'マグマ床へ。倒れて地上再開',
      '崖へ出て落ちて地上再開', '溶岩へ掘り進み地上で再開'];
    for (const why of whys) expect(suicideHold({ why: `[n31] ${why}`, hands: [{ do: 'wait', seconds: 5 }] }, frame([])), why).not.toBeNull();
    const tools = frame([['iron_pickaxe', 1], ['iron_sword', 1]]);
    expect(suicideHold({ why: '[n5] 溶岩の縁を避けて地上へ戻る', hands: [{ do: 'go', to: { x: 1, y: 64, z: 1 } }] }, tools)).toBeNull();
    expect(suicideHold({ why: '[n5] 溶岩へ落ちる', hands: [{ do: 'go', to: { x: 1, y: 64, z: 1 } }] }, tools)).toBeNull();
  });
  it('holds the way back to a mob death within 32 m, the fight on its killer by name or #id, and an act that accepts it', () => {
    const entrance = { hands: [{ do: 'go', to: { x: 74, y: 66, z: 22 } }] };
    expect(deathReturnHold(entrance, frame([['stone_sword', 1]]), 't')).toMatchObject({ hand: 1, kind: 'go' });
    expect(deathReturnHold({ hands: [{ do: 'fight', target: 'wither_skeleton' }] }, frame([]), 'u')).toMatchObject({ hand: 1, kind: 'fight' });
    const live = { threats: ['#77 wither_skeleton 9.0m (80,66,30) 見える（射線の中）'] };
    expect(deathReturnHold({ hands: [{ do: 'eat', item: 'bread' }, { do: 'attack', target: '#77' }] }, frame([], live), 'v')).toMatchObject({ hand: 2 });
    expect(deathReturnHold({ accept: ['wither_skeleton'], hands: [{ do: 'wait', seconds: 3 }] }, frame([]), 'w')).toMatchObject({ hand: 1 });
  });
  it('counts its holds for each death, so a second death at the same place is held again', () => {
    const back = { hands: [{ do: 'go', to: { x: 85, y: 64, z: 38 } }] };
    for (let i = 1; i <= RETURN_HOLDS; i += 1) deathReturnHold(back, frame([]), 'x')!.commit();
    expect(deathReturnHold(back, frame([]), 'x')).toBeNull();
    expect(deathReturnHold(back, frame([], { deaths: [{}, {}] }), 'x')).not.toBeNull();
  });
  it('lets the return go with a chestplate worn and an iron sword, after a lava death, far away, or once the death is five minutes old', () => {
    const back = { hands: [{ do: 'go', to: { x: 85, y: 64, z: 38 } }] };
    expect(deathReturnHold(back, frame([['iron_sword', 1]]), 'y')).not.toBeNull();
    expect(deathReturnHold(back, frame([['iron_sword', 1]], { worn: '胴: iron_chestplate(残り 200/240)' }), 'y2')).toBeNull();
    expect(deathReturnHold(back, frame([], { lastDeath: '2分前 the_nether (89,67,40) 「lava」' }), 'y3')).toBeNull();
    expect(deathReturnHold({ hands: [{ do: 'go', to: { x: 0, y: 64, z: 0 } }] }, frame([]), 'y4')).toBeNull();
    expect(deathReturnHold(back, frame([], { lastDeath: DEATH.replace('2分前', '6分前') }), 'y5')).toBeNull();
  });
});
