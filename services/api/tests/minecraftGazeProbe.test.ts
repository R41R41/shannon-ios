import { describe, expect, it } from 'vitest';
import { PROBE_DESCRIPTION, PROBE_INPUT_SCHEMA, PROBE_KINDS } from '../src/contracts/minecraftProbeContract.js';
import { prepareProbeInput, probeAnswerText, probeLabel } from '../src/surfaces/minecraft/minecraftLlmcProbeInput.js';
import { foreignToolNames } from '../src/contracts/minecraftLlmcToolWords.js';

const context = { feet: { x: 0, y: 64, z: 0 }, creatures: [] };

describe('the gaze probe: the block a player is looking at', () => {
  it('is a kind of the probe contract, with its player field and its words', () => {
    expect(PROBE_KINDS).toContain('gaze');
    expect(PROBE_INPUT_SCHEMA.properties.player).toMatchObject({ type: 'string' });
    expect(PROBE_INPUT_SCHEMA.properties.kind.enum).toContain('gaze');
    expect(PROBE_DESCRIPTION).toContain('gaze(player');
    expect(foreignToolNames(PROBE_DESCRIPTION)).toEqual([]);
  });

  it('takes a player by in-game name or #id, and the nearest player when none is named', () => {
    expect(prepareProbeInput({ kind: 'gaze', player: 'Rai_41' }, context)).toMatchObject({ input: { kind: 'gaze', player: 'Rai_41' }, problem: null, fixes: [] });
    expect(prepareProbeInput({ kind: 'gaze', player: '@Rai_41 ' }, context).input).toEqual({ kind: 'gaze', player: 'Rai_41' });
    expect(prepareProbeInput({ kind: 'gaze', player: 12 }, context).input).toEqual({ kind: 'gaze', player: '#12' });
    expect(prepareProbeInput({ kind: 'gaze' }, context).input).toEqual({ kind: 'gaze' });
    expect(prepareProbeInput({ kind: 'looking_at', player: 'Yami' }, context).input).toEqual({ kind: 'gaze', player: 'Yami' });
  });

  it('refuses a player that is not a name, and leaves out the fields the kind does not take', () => {
    expect(prepareProbeInput({ kind: 'gaze', player: 'ライ 氏; drop' }, context)).toMatchObject({ input: null, problem: expect.stringContaining('gaze の player') });
    const extra = prepareProbeInput({ kind: 'gaze', player: 'Yami', radius: 9 }, context);
    expect(extra.input).toEqual({ kind: 'gaze', player: 'Yami' });
    expect(extra.fixes.join()).toContain('radius');
  });

  it('is named in a line, and its answer carries the block, its cell, the distance and the face', () => {
    expect(probeLabel({ kind: 'gaze', player: 'Yami' })).toBe('gaze→Yami');
    expect(probeLabel({ kind: 'gaze' })).toBe('gaze→近くの人');
    const answer = JSON.stringify({ v: 1, kind: 'gaze', text: 'Yami は oak_planks を見ている', block: 'oak_planks', at: { x: 12, y: 64, z: -3 }, distance: 5.43, face: 'up' });
    expect(probeAnswerText(answer, true)).toBe('Yami は oak_planks を見ている ／ 見ている先: oak_planks (12,64,-3) 距離 5.4m 面 up');
    // The cell already in the body's text is not said twice.
    const said = JSON.stringify({ v: 1, kind: 'gaze', text: 'Yami は oak_planks (12,64,-3) を見ている', block: 'oak_planks', at: { x: 12, y: 64, z: -3 } });
    expect(probeAnswerText(said, true)).toBe('Yami は oak_planks (12,64,-3) を見ている');
    expect(probeAnswerText(JSON.stringify({ v: 1, kind: 'gaze', text: 'Yami は空を見ている' }), true)).toBe('Yami は空を見ている');
  });
});
