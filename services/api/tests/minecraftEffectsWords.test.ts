import { describe, expect, it } from 'vitest';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { vitalsLine } from '../src/surfaces/minecraft/minecraftLlmcFacts.js';
import { V2_STAGES } from '../src/surfaces/minecraft/minecraftLlmcV2Knowledge.js';

/** The body's effects with their seconds, in the vitals line, and the night's and the End bed's rules (the coordinator's list for 11/4, item 6). */
const frame = (world: Record<string, unknown>): BodyObservation => ({ schemaVersion: 1, bodyId: 'b', sequence: 1, stateAt: 't', receivedAt: 't', connected: true, facts: {},
  state: { world: { health: 14, food: 18, inventory: [], ...world } as never } });

describe('the effects on the body', () => {
  it('says each effect with the seconds left (from seconds or ticks) and a burning body', () => {
    const line = vitalsLine(frame({ effects: [{ name: 'weakness', remainingTicks: 460 }, { id: 'minecraft:slowness', seconds: 12 }, { name: 'glowing' }], onFire: true }))!;
    expect(line).toContain('効果 weakness 残り 23 秒・slowness 残り 12 秒・glowing・燃えている');
  });
  it('is the line it was when the frame has none', () => {
    expect(vitalsLine(frame({}))).not.toContain('効果');
    expect(vitalsLine(frame({ effects: [] }))).not.toContain('効果');
  });
});

describe('the night and the End bed', () => {
  it('sleeps in a carried bed on the overworld night, not in the Nether or the End', () => {
    expect(V2_STAGES.prep).toContain('夜（オーバーワールド）は、sleep の手で寝て朝にする（体が持っているベッドを置き、朝に拾い直す）');
    expect(V2_STAGES.prep).toContain('ネザー・エンドでは寝ない（爆発する）');
  });
  it('uses a bed in the End only when the expected damage to herself is 4 or less', () => {
    expect(V2_STAGES.end).toContain('エンドで使うのは、結果の文の「自分への被害」の見込みが 4 以下の時だけ');
  });
});
