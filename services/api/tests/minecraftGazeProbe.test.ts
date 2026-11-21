import { describe, expect, it } from 'vitest';
import { PROBE_DESCRIPTION, PROBE_INPUT_SCHEMA, PROBE_KINDS } from '../src/contracts/minecraftProbeContract.js';
import { prepareProbeInput, probeAnswerText, probeLabel } from '../src/surfaces/minecraft/minecraftLlmcProbeInput.js';
import { foreignToolNames } from '../src/contracts/minecraftLlmcToolWords.js';
import { llmcPrepare } from '../src/surfaces/minecraft/minecraftLlmc.js';

const context = { feet: { x: 0, y: 64, z: 0 }, creatures: [] };

describe('the gaze probe: the block a player is looking at', () => {
  it('is a kind of the probe contract, with its player field and its words', () => {
    expect(PROBE_KINDS).toContain('gaze');
    expect(PROBE_INPUT_SCHEMA.properties.player).toMatchObject({ type: 'string' });
    expect(PROBE_INPUT_SCHEMA.properties.kind.enum).toContain('gaze');
    expect(PROBE_DESCRIPTION).toContain('gaze(player');
    expect(foreignToolNames(PROBE_DESCRIPTION)).toEqual([]);
  });

  it('takes the player by in-game name, required, and a ray length of 1 to 64', () => {
    expect(prepareProbeInput({ kind: 'gaze', player: 'Rai_41' }, context)).toMatchObject({ input: { kind: 'gaze', player: 'Rai_41' }, problem: null, fixes: [] });
    expect(prepareProbeInput({ kind: 'gaze', player: '@Rai_41 ', range: 99 }, context).input).toEqual({ kind: 'gaze', player: 'Rai_41', range: 64 });
    expect(prepareProbeInput({ kind: 'looking_at', player: 'Yami', range: 40 }, context).input).toEqual({ kind: 'gaze', player: 'Yami', range: 40 });
    // A name that is not an in-game name (a display name) or none is sent as it is: the body answers for the people who are here.
    expect(prepareProbeInput({ kind: 'gaze' }, context)).toMatchObject({ input: { kind: 'gaze' }, problem: null });
    expect(prepareProbeInput({ kind: 'gaze', player: 'ユウ' }, context).input).toEqual({ kind: 'gaze', player: 'ユウ' });
    expect(prepareProbeInput({ kind: 'gaze', player: '#2', near: ' Oak Planks ' }, context).input).toEqual({ kind: 'gaze', player: '#2', near: 'oak_planks' });
    expect(prepareProbeInput({ kind: 'gaze', player: 'Yami', near: 'oak planks; drop' }, context).input).toEqual({ kind: 'gaze', player: 'Yami' });
    expect(PROBE_INPUT_SCHEMA.properties.range.maximum).toBe(64);
  });

  it('goes to the body as a tool call is made ready: the player is kept and the schema takes it', () => {
    expect(llmcPrepare('mc.probe', { kind: 'gaze', player: 'Yuu_7', range: 20 }, context)).toMatchObject({ input: { kind: 'gaze', player: 'Yuu_7', range: 20 }, problem: null });
    expect(llmcPrepare('mc.probe', { kind: 'gaze' }, context)).toMatchObject({ input: { kind: 'gaze' }, problem: null });
  });

  it('leaves out the fields the kind does not take, and is named in a line', () => {
    const extra = prepareProbeInput({ kind: 'gaze', player: 'Yami', radius: 9 }, context);
    expect(extra.input).toEqual({ kind: 'gaze', player: 'Yami' });
    expect(extra.fixes.join()).toContain('radius');
    expect(probeLabel({ kind: 'gaze', player: 'Yami' })).toBe('gaze→Yami');
  });

  it('reads the answer: the block, its face, where to put a thing, and whether the hand reaches', () => {
    const hit = JSON.stringify({ v: 1, kind: 'gaze', found: true, hit: true, text: 'Yami は oak_planks を見ている', block: { name: 'oak_planks', at: { x: 12, y: 64, z: -3 } },
      face: 'up', distance: 6.4, reach: false, placeAt: { x: 12, y: 65, z: -3 }, against: 'down', above: { x: 12, y: 65, z: -3 } });
    expect(probeAnswerText(hit, true)).toBe('Yami は oak_planks を見ている ／ 見ている先: oak_planks (12,64,-3) 面 up 距離 6.4m ／ 置くマス: (12,65,-3) against=down 真上: (12,65,-3) ／ 体の手は届かない（先に go で近づく）');
    const said = JSON.stringify({ v: 1, kind: 'gaze', hit: true, text: 'Yami は oak_planks (12,64,-3) を見ている', block: { name: 'oak_planks', at: { x: 12, y: 64, z: -3 } } });
    expect(probeAnswerText(said, true)).toBe('Yami は oak_planks (12,64,-3) を見ている');
    // The body's text names the cells; the direction a hand's face takes is still said (the live answer, where only the text is shown).
    const sayAgainst = JSON.stringify({ v: 1, kind: 'gaze', hit: true, text: 'Yami は oak_planks (12,64,-3) を見ている。置くマス (12,65,-3)', block: { name: 'oak_planks', at: { x: 12, y: 64, z: -3 } },
      face: 'up', placeAt: { x: 12, y: 65, z: -3 }, against: 'down' });
    expect(probeAnswerText(sayAgainst, true)).toBe('Yami は oak_planks (12,64,-3) を見ている。置くマス (12,65,-3) ／ place の face には against=down（置くマス (12,65,-3)）');
    expect(probeAnswerText(JSON.stringify({ v: 1, kind: 'gaze', hit: false, reason: 'none', text: 'Yami は空を見ている' }), true)).toBe('Yami は空を見ている');
  });
});
