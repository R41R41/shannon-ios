import { afterEach, describe, expect, it } from 'vitest';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { heldOfFrame } from '../src/surfaces/minecraft/minecraftLlmcPartial.js';
import { deathReturnHold, forgetDeathHolds, RETURN_HOLDS, suicideHold } from '../src/surfaces/minecraft/minecraftLlmcDeathHolds.js';

/** run62 (11/5): twenty decisions to die on purpose, and five deaths to the same wither skeletons straight from the respawn. */
const frame = (items: Array<[string, number]>, world: Record<string, unknown> = {}): BodyObservation => ({ schemaVersion: 1, bodyId: 'b', sequence: 1,
  stateAt: 't', receivedAt: 't', connected: true, facts: {},
  state: { world: { dimension: 'the_nether', position: { x: 0, y: 64, z: 0 }, health: 20, food: 20, inventory: items.map(([name, count]) => ({ name, count })),
    lastDeath: '2分前 the_nether (100,64,100) 「wither_skeleton に倒された」 落とした物: iron_sword×1', ...world } as never } });

afterEach(() => forgetDeathHolds());

describe('the deaths of run62', () => {
  it('holds an act whose why says it goes to die, whole', () => {
    const act = { why: '[n31] 持ち物なし。溶岩／マグマ／落下で倒れて地上で再開', hands: [{ do: 'go', to: { x: 16, y: 67, z: 15 } }] };
    expect(suicideHold(act)).toMatchObject({ hand: 1, kind: 'go' });
    expect(suicideHold(act)!.line).toContain('わざと死ぬ手は送らない');
    expect(heldOfFrame(act, frame([]), 's')).toMatchObject({ hand: 1, code: 'no_suicide' });
    expect(suicideHold({ why: '[n12] ゾンビを倒してから進む', hands: [{ do: 'fight', target: 'zombie' }] })).toBeNull();
  });
  it('holds a go back to the place of a fresh death and a fight on its killer with no iron sword, twice a death', () => {
    const back = { hands: [{ do: 'go', to: { x: 95, y: 64, z: 98 } }] };
    for (let i = 1; i <= RETURN_HOLDS; i += 1) {
      const held = deathReturnHold(back, frame([['stone_sword', 1]]), 't')!;
      expect(held.line).toContain(`最後の死から 2 分（wither_skeleton に倒された）`);
      expect(held.line).toContain(`${i}/${RETURN_HOLDS} 回目`);
      held.commit();
    }
    expect(deathReturnHold(back, frame([['stone_sword', 1]]), 't')).toBeNull();
    expect(deathReturnHold({ hands: [{ do: 'fight', target: 'wither_skeleton' }] }, frame([]), 'u')).toMatchObject({ hand: 1, kind: 'fight' });
  });
  it('lets the return go with an iron sword, far from the place, or once the death is five minutes old', () => {
    const back = { hands: [{ do: 'go', to: { x: 95, y: 64, z: 98 } }] };
    expect(deathReturnHold(back, frame([['iron_sword', 1]]), 'v')).toBeNull();
    expect(deathReturnHold({ hands: [{ do: 'go', to: { x: 0, y: 64, z: 40 } }] }, frame([]), 'v')).toBeNull();
    expect(deathReturnHold(back, frame([], { lastDeath: '6分前 the_nether (100,64,100) 「lava」' }), 'v')).toBeNull();
  });
});
