import { describe, expect, it } from 'vitest';
import { sceneVerdict } from '../src/surfaces/minecraft/minecraftLlmcSceneCheck.js';

const shoot = (target: string) => ({ do: 'shoot', target });

describe('the checks of a replayed scene', () => {
  it('passes the hands that hold what the scene asks for and names what is missing otherwise', () => {
    const check = { anyHand: ['shoot'], match: ['"target":"#(?:12|11)"'], noMatch: ['"target":"#15"', '"do":"fight"'] };
    expect(sceneVerdict(check, [shoot('#12')])).toEqual({ pass: true, why: [] });
    expect(sceneVerdict(check, [shoot('#15')]).why).toEqual(['"target":"#(?:12|11)" に合う所が無い', '"target":"#15" に合う所がある']);
    expect(sceneVerdict(check, [{ do: 'go' }]).pass).toBe(false);
    expect(sceneVerdict(check, [shoot('#11'), { do: 'fight', target: 'zombie' }]).why).toEqual(['"do":"fight" に合う所がある']);
  });

  it('wants every group of eachOf, a hand kind kept out by noHand, and the order of the kinds', () => {
    const check = { eachOf: [['go', 'walk'], ['attack']], noHand: ['shoot'], order: ['go', 'attack'] };
    expect(sceneVerdict(check, [{ do: 'walk' }, { do: 'attack', target: 'ender_dragon' }]).why).toEqual(['手の順が go→attack でない（walk→attack）']);
    expect(sceneVerdict(check, [{ do: 'go' }, { do: 'look' }, { do: 'attack' }]).pass).toBe(true);
    expect(sceneVerdict(check, [{ do: 'attack' }]).why).toEqual(['go・walk のどれかの手が無い', '手の順が go→attack でない（attack）']);
    expect(sceneVerdict(check, [{ do: 'go' }, { do: 'attack' }, { do: 'shoot' }]).why).toEqual(['shoot の手がある']);
  });

  it('counts a scene with no check as met by any hand, and a decision with no hand as not met', () => {
    expect(sceneVerdict(undefined, [{ do: 'wait' }]).pass).toBe(true);
    expect(sceneVerdict(undefined, []).why).toEqual(['手が無い']);
    expect(sceneVerdict({ anyHand: ['use'] }, []).pass).toBe(false);
  });
});
