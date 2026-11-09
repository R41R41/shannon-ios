import { describe, expect, it } from 'vitest';
import { createFoodTrend, minecraftLlmcLive } from '../src/surfaces/minecraft/minecraftLlmcLive.js';
import { V2_STAGES } from '../src/surfaces/minecraft/minecraftLlmcV2Knowledge.js';

// Rig end1109f01 (c1): a zombified piglin no one had struck stood in the threats and cut the act as urgent, the decision struck it
// and its group killed her; and a go to the spawner with canPlace laid a bridge over a 17-deep gap and she fell.
describe('the fortress seam of end1109f01: a neutral one said as neutral, and no bridge near the fortress', () => {
  const live = (nearbyEntities: unknown[], nearbyThreats: unknown[] = []) => minecraftLlmcLive({ elapsedMinutes: 1, trend: createFoodTrend(), events: [],
    investigation: [], observation: { schemaVersion: 1, bodyId: 'b', sequence: 1, stateAt: 't', receivedAt: 't', connected: true,
      state: { world: { position: { x: 0, y: 70, z: 0 }, health: 20, nearbyEntities, nearbyThreats } }, facts: {} } } as never);

  it('says an unprovoked one among the creatures as neutral, and a hostile among the threats as before', () => {
    const piglin = { name: 'zombified_piglin', id: 931, kind: 'neutral', distance: 10.6, position: { x: 10, y: 70, z: 0 } };
    const skeleton = { name: 'wither_skeleton', id: 742, kind: 'hostile', distance: 6, position: { x: 6, y: 70, z: 0 } };
    const shown = live([skeleton, piglin], [skeleton]);
    expect(shown.near).toEqual(['#931 zombified_piglin 10.6m (10,70,0)・中立（殴らなければ来ない）']);
    expect(JSON.stringify(shown.threats)).toContain('#742 wither_skeleton');
    expect(JSON.stringify(shown.threats)).not.toContain('zombified_piglin');
  });

  it("says a calm enderman as angered by a look as well as a blow, not as one that comes only when struck", () => {
    const enderman = { name: 'enderman', id: 619, kind: 'neutral', distance: 12.3, position: { x: 12, y: 70, z: 0 } };
    expect(live([enderman]).near).toEqual(['#619 enderman 12.3m (12,70,0)・中立（目を合わせるか殴ると怒る）']);
  });

  it('tells the Nether decision not to strike a neutral one and to leave canPlace off a go near the fortress', () => {
    const words = V2_STAGES.nether;
    expect(words).toContain('地図の & は attack・accept しない');
    expect(words).toContain('要塞・スポナーの近く（要塞が見えてから、スポナーの足場まで）の go は canPlace を付けず');
    expect(words).toContain('遠い go（要塞が見えるまでの道）');
  });
});
