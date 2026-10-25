import { describe, expect, it } from 'vitest';
import {
  SHANNON_GAME_DANGERS, SHANNON_GAME_DANGER_FEELINGS, SHANNON_GAME_MILESTONES, SHANNON_GAME_MILESTONE_FEELINGS, SHANNON_GAME_MOOD_STEP,
  SHANNON_GAME_THOUGHT_INTENSITY, SHANNON_GAME_THOUGHT_KINDS, createInitialCompanionState, faceForEmotionKind, feelGame, gameCause, gameFeeling,
  gameThoughtWords, isGameFeeling, isShannonEmotionKind, reduceCompanionState, type CompanionStateSnapshot, type ShannonGameMoment,
} from '../src/index.js';

const START = '2026-10-26T06:00:00.000Z';
const later = (minutes: number) => new Date(Date.parse(START) + minutes * 60_000).toISOString();
const fresh = () => createInitialCompanionState('owner', START);
const felt = (state: CompanionStateSnapshot, moment: ShannonGameMoment, at = START) => reduceCompanionState(state, { type: 'game-felt', moment }, at);

describe('the game → feeling table', () => {
  it('has a row for every first and danger, with feelings and faces that exist', () => {
    expect(Object.keys(SHANNON_GAME_MILESTONE_FEELINGS).sort()).toEqual([...SHANNON_GAME_MILESTONES].sort());
    expect(Object.keys(SHANNON_GAME_DANGER_FEELINGS).sort()).toEqual([...SHANNON_GAME_DANGERS].sort());
    for (const row of [...Object.values(SHANNON_GAME_MILESTONE_FEELINGS), ...Object.values(SHANNON_GAME_DANGER_FEELINGS)]) {
      expect(isShannonEmotionKind(row.primary)).toBe(true);
      expect(faceForEmotionKind(row.primary).expression).toBeTruthy();
      expect(row.intensity).toBeGreaterThanOrEqual(0.4);
      expect(row.intensity).toBeLessThanOrEqual(0.85);
    }
    for (const kind of SHANNON_GAME_THOUGHT_KINDS) expect(isShannonEmotionKind(kind)).toBe(true);
  });

  it('words every cause after 「マイクラで」, and tells a game feeling by it', () => {
    expect(gameCause({ kind: 'milestone', milestone: 'nether_entered' })).toBe('マイクラでネザーに着いた');
    expect(gameCause({ kind: 'died' })).toBe('マイクラで死んでしまった');
    expect(gameCause({ kind: 'ownerNear' })).toBe('マイクラでライ氏がそばに来た');
    expect(isGameFeeling({ cause: 'マイクラでダイヤを見つけた' })).toBe(true);
    expect(isGameFeeling({ cause: 'ライ氏に頭をなでてもらった' })).toBe(false);
  });

  it('takes a bad hit, a long run of failures and a thought by their own rows, and nothing it cannot name', () => {
    expect(gameFeeling({ kind: 'hurt', strength: 0.1 })?.primary).toBe('surprised');
    expect(gameFeeling({ kind: 'hurt', strength: 0.4 })?.primary).toBe('shocked');
    expect(gameFeeling({ kind: 'stuck', count: 2 })).toBeNull();
    expect(gameFeeling({ kind: 'stuck', count: 3 })?.primary).toBe('frustrated');
    expect(gameFeeling({ kind: 'stuck', count: 6 })?.primary).toBe('annoyed');
    expect(gameFeeling({ kind: 'danger' })).toBeNull();
    expect(gameFeeling({ kind: 'milestone', milestone: 'first_cake' as never })).toBeNull();
    // A thought brings only a kind of playing, held inside its bounds, with its words as the cause.
    const thought = gameFeeling({ kind: 'thought', thought: { primary: 'smug', intensity: 0.95, words: '「計画どおり」鉄が集まった' } });
    expect(thought).toMatchObject({ primary: 'smug', intensity: SHANNON_GAME_THOUGHT_INTENSITY.maximum, done: '計画どおり 鉄が集まった' });
    expect(gameFeeling({ kind: 'thought', thought: { primary: 'jealous', intensity: 0.5, words: '誰か' } })).toBeNull();
    expect(gameFeeling({ kind: 'thought', thought: { primary: 'fun', intensity: 0.5, words: '   ' } })).toBeNull();
    expect(gameThoughtWords('マイクラで同じ所で止まった')).toBe('同じ所で止まった');
  });
});

describe('a game moment in the one emotion state', () => {
  it('a first lifts her mood a bounded step and gives her a feeling of the game', () => {
    const before = fresh();
    const after = felt(before, { kind: 'milestone', milestone: 'first_diamond' });
    expect(after.expressiveEmotion).toMatchObject({ primary: 'excited', cause: 'マイクラでダイヤを見つけた', target: 'マイクラの世界' });
    expect(after.emotion.valence).toBeGreaterThan(before.emotion.valence);
    for (const key of ['valence', 'arousal', 'openness'] as const) {
      expect(Math.abs(after.emotion[key] - before.emotion[key])).toBeLessThanOrEqual(SHANNON_GAME_MOOD_STEP + 1e-9);
    }
  });

  it('dying after a first turns the feeling, and a stronger feeling is not covered by a weak hit', () => {
    const joyful = felt(fresh(), { kind: 'milestone', milestone: 'dragon_killed' });
    expect(joyful.expressiveEmotion?.primary).toBe('triumphant');
    // A slight hit a moment later does not cover the triumph.
    const hit = felt(joyful, { kind: 'hurt', strength: 0.1 }, later(1));
    expect(hit.expressiveEmotion?.primary).toBe('triumphant');
    // Dying is contrary and strong enough: it takes the place.
    const died = felt(joyful, { kind: 'died' }, later(30));
    expect(died.expressiveEmotion).toMatchObject({ primary: 'frustrated', cause: 'マイクラで死んでしまった' });
  });

  it('a thought moves only how pleasant she is, and gently', () => {
    const before = fresh();
    const after = felt(before, { kind: 'thought', thought: { primary: 'frustrated', intensity: 0.5, words: '同じ所で何度も止まった' } });
    expect(after.emotion.arousal).toBe(before.emotion.arousal);
    expect(after.emotion.openness).toBe(before.emotion.openness);
    expect(after.emotion.valence).toBeLessThan(before.emotion.valence);
    expect(after.expressiveEmotion).toMatchObject({ primary: 'frustrated', cause: 'マイクラで同じ所で何度も止まった' });
  });

  it('a moment it cannot name changes nothing, and feelGame is pure', () => {
    const state = fresh();
    expect(felt(state, { kind: 'stuck', count: 1 })).toBe(state);
    const copy = JSON.stringify(state);
    feelGame(state, { kind: 'died' }, START);
    expect(JSON.stringify(state)).toBe(copy);
  });
});
