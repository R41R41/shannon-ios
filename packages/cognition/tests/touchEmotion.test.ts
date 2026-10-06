import { describe, expect, it } from 'vitest';
import {
  SHANNON_EMOTION_CARRY_THRESHOLD, SHANNON_EMOTION_TIME, SHANNON_TOUCH_FEELINGS, SHANNON_TOUCH_KINDS, SHANNON_TOUCH_MOOD_STEP, SHANNON_TOUCH_REFLEX,
  carriedShannonEmotion, createInitialCompanionState, currentShannonEmotion, faceForEmotionKind, feelTouch, isShannonEmotionKind,
  isShannonTouchKind, isTouchFeeling, keepsFeelingThroughTouch, presentShannonMood, reduceCompanionState, touchCause, touchFeeling,
  type CompanionStateSnapshot, type ShannonTouch, type ShannonTouchKind,
} from '../src/index.js';

const START = '2026-10-02T06:00:00.000Z';
const later = (minutes: number) => new Date(Date.parse(START) + minutes * 60_000).toISOString();
const fresh = () => createInitialCompanionState('owner', START);
const touch = (kind: ShannonTouchKind, countInWindow = 1, extra: Partial<ShannonTouch> = {}): ShannonTouch => ({ kind, countInWindow, ...extra });
const touched = (state: CompanionStateSnapshot, value: ShannonTouch, at = START) => reduceCompanionState(state, { type: 'body-touched', touch: value }, at);

describe('the touch → feeling table', () => {
  it('has one row per touch of the body contract, ascending steps, and only feelings and faces that exist', () => {
    expect(Object.keys(SHANNON_TOUCH_FEELINGS).sort()).toEqual([...SHANNON_TOUCH_KINDS].sort());
    for (const kind of SHANNON_TOUCH_KINDS) {
      const row = SHANNON_TOUCH_FEELINGS[kind];
      expect(row.done.length).toBeGreaterThan(3);
      expect(row.steps[0]!.fromCount).toBe(1);
      expect(row.steps.map(step => step.fromCount)).toEqual([...row.steps.map(step => step.fromCount)].sort((left, right) => left - right));
      for (const step of row.steps) {
        expect(isShannonEmotionKind(step.primary)).toBe(true);
        expect(faceForEmotionKind(step.primary).expression).toBeTruthy();
        // Visible on her face, never overwhelming.
        expect(step.intensity).toBeGreaterThanOrEqual(0.3);
        expect(step.intensity).toBeLessThanOrEqual(0.7);
        expect(Math.abs(step.mood.valence)).toBeLessThanOrEqual(0.6);
      }
    }
    expect(isShannonTouchKind('pet')).toBe(true);
    expect(isShannonTouchKind('kiss')).toBe(false);
  });

  it('gives each kind of touch its own feeling, and changes it when the touch is repeated', () => {
    const feelings = (kind: ShannonTouchKind, counts: readonly number[]) => counts.map(count => touchFeeling(touch(kind, count)).step.primary);
    // Being patted pleases her, more shyly and then more warmly as it goes on.
    expect(feelings('pet', [1, 2, 3, 5, 6, 40])).toEqual(['happy', 'happy', 'bashful', 'bashful', 'affectionate', 'affectionate']);
    expect(feelings('tickle', [1, 3, 5])).toEqual(['giggle', 'flustered', 'cuteAngry']);
    // Being poked again and again makes her sulk.
    expect(feelings('poke', [1, 2, 3, 4, 9])).toEqual(['surprised', 'cuteAngry', 'cuteAngry', 'sulky', 'sulky']);
    // Being carried flusters her.
    expect(feelings('carry', [1, 2, 3])).toEqual(['flustered', 'flustered', 'cuteAngry']);
    expect(feelings('holdHand', [1, 3])).toEqual(['shy', 'affectionate']);
    // A count that is not a positive whole number is one touch.
    expect(touchFeeling(touch('poke', 0)).step.primary).toBe('surprised');
    expect(touchFeeling(touch('poke', Number.NaN)).step.primary).toBe('surprised');
  });

  it('feels a firm, long touch more than a light, short one, inside fixed bounds', () => {
    const light = touchFeeling(touch('pet', 1, { strength: 0, durationMs: 0 }));
    const plain = touchFeeling(touch('pet', 1));
    const firm = touchFeeling(touch('pet', 1, { strength: 1, durationMs: 600_000 }));
    expect(light.intensity).toBeLessThan(plain.intensity);
    expect(firm.intensity).toBeGreaterThan(plain.intensity);
    expect(light.weight).toBeCloseTo(0.7);
    expect(firm.weight).toBeCloseTo(1.3);
    for (const value of [light, plain, firm]) {
      expect(value.intensity).toBeGreaterThanOrEqual(0.3);
      expect(value.intensity).toBeLessThanOrEqual(0.9);
    }
  });

  it('names the touch as the cause, with the owner only when he was alone with her', () => {
    expect(touchCause(touch('pet'))).toBe('ライ氏に頭をなでてもらった');
    expect(touchCause(touch('pet', 3))).toBe('ライ氏に頭をなでてもらった（続けて3回目）');
    expect(touchCause(touch('poke', 2, { ownerAlone: false }))).toBe('つつかれた（続けて2回目）');
  });
});

describe('body-touched in the one emotion state', () => {
  it('moves the continuous mood a small bounded step and sets the conversational feeling', () => {
    const before = fresh();
    const after = touched(before, touch('pet', 1, { durationMs: 3_000, strength: 0.3 }));
    expect(after.version).toBe(before.version + 1);
    expect(after.emotion.valence).toBeGreaterThan(before.emotion.valence);
    expect(after.emotion.openness).toBeGreaterThan(before.emotion.openness);
    for (const key of ['valence', 'arousal', 'openness'] as const) {
      expect(Math.abs(after.emotion[key] - before.emotion[key])).toBeLessThanOrEqual(SHANNON_TOUCH_MOOD_STEP + 1e-9);
    }
    expect(after.expressiveEmotion).toMatchObject({ primary: 'happy', target: 'ライ氏', cause: 'ライ氏に頭をなでてもらった', updatedAt: START });
    expect(after.expressiveEmotion!.visibility).not.toBe('hidden');
    // The same projection every screen uses now shows it.
    expect(presentShannonMood(after, START)).toMatchObject({ expression: 'joyful', fromConversation: true, cause: 'ライ氏に頭をなでてもらった' });
    // Nothing else of the state is touched.
    expect(after.userFacts).toEqual(before.userFacts);
    expect(after.temperament).toEqual(before.temperament);
  });

  it('moves each kind its own way', () => {
    const poked = [1, 2, 3, 4].reduce((state, count) => touched(state, touch('poke', count)), fresh());
    expect(poked.expressiveEmotion!.primary).toBe('sulky');
    expect(poked.emotion.valence).toBeLessThan(0);
    expect(presentShannonMood(poked, START).expression).toBe('annoyed');
    const carried = touched(fresh(), touch('carry'));
    expect(carried.expressiveEmotion!.primary).toBe('flustered');
    expect(presentShannonMood(carried, START)).toMatchObject({ expression: 'embarrassed', feeling: 'flustered' });
    expect(carried.emotion.arousal).toBeGreaterThan(fresh().emotion.arousal);
    expect(touched(fresh(), touch('tickle')).expressiveEmotion!.primary).toBe('giggle');
    expect(touched(fresh(), touch('holdHand')).expressiveEmotion!.primary).toBe('shy');
  });

  it('stays bounded however often she is touched: the mood approaches the row and never passes it', () => {
    let state = fresh();
    for (let count = 1; count <= 300; count += 1) state = touched(state, touch('pet', count, { strength: 1, durationMs: 600_000 }));
    const row = SHANNON_TOUCH_FEELINGS.pet.steps.at(-1)!.mood;
    expect(state.emotion.valence).toBeLessThanOrEqual(row.valence + 1e-9);
    expect(state.emotion.valence).toBeGreaterThan(row.valence - 0.02);
    expect(state.emotion.openness).toBeLessThanOrEqual(row.openness + 1e-9);
    expect(state.expressiveEmotion!.carryover).toBeLessThanOrEqual(1);
    expect(state.expressiveEmotion!.intensity).toBeLessThanOrEqual(0.9);
  });

  it('decays by the shared carry-over rule, like a feeling from conversation', () => {
    const after = touched(fresh(), touch('pet', 3));
    expect(currentShannonEmotion(after.expressiveEmotion, START).primary).toBe('bashful');
    const soon = currentShannonEmotion(after.expressiveEmotion, later(10));
    expect(soon.primary).toBe('bashful');
    expect(soon.intensity).toBeLessThan(after.expressiveEmotion!.intensity);
    // An hour later it has settled, and the face is the quiet mood again.
    expect(currentShannonEmotion(after.expressiveEmotion, later(60)).primary).toBe('neutral');
    expect(presentShannonMood(after, later(60)).fromConversation).toBe(false);
    // A touch after it settled starts a new episode.
    const again = touched(after, touch('pet', 1), later(60));
    expect(again.expressiveEmotion).toMatchObject({ primary: 'happy', startedAt: later(60) });
  });

  it('keeps the earlier feeling as a secondary one, as any change of feeling does', () => {
    const patted = touched(fresh(), touch('pet'));
    const poked = touched(patted, touch('poke'), later(1));
    expect(poked.expressiveEmotion).toMatchObject({ primary: 'surprised', secondary: ['happy'] });
  });

  it('does not replace a feeling she holds for the owner\'s safety or grief; only the mood moves', () => {
    const base = fresh();
    const protective = reduceCompanionState(base, { type: 'expressive-emotion-updated', emotion: {
      primary: 'protective', secondary: [], intensity: 0.8, target: 'ライ氏', cause: '相手の安全を最優先する必要がある', arousal: 0.6, valence: 0.6,
      visibility: 'expressed', startedAt: START, decay: 0.48, carryover: 0.7, updatedAt: START, overrideReason: 'emergency',
    } }, START);
    const after = touched(protective, touch('tickle'), later(1));
    expect(after.expressiveEmotion).toEqual(protective.expressiveEmotion);
    expect(after.emotion.arousal).toBeGreaterThan(protective.emotion.arousal);
    // Once that feeling has settled with time she was awake, a touch is felt again.
    const settled = later(120);
    let awake = protective;
    for (let minutes = 10; minutes <= 110; minutes += 10) awake = reduceCompanionState(awake, { type: 'awake-observed' }, later(minutes));
    expect(touched(awake, touch('tickle'), settled).expressiveEmotion!.primary).toBe('giggle');
    // On the wall clock (the kill switch) the two hours alone settle it, as before.
    const wall = { ...SHANNON_EMOTION_TIME, clock: 'wall' as const };
    const stored = reduceCompanionState(base, { type: 'expressive-emotion-updated', emotion: protective.expressiveEmotion! }, START, wall);
    expect(carriedShannonEmotion(stored.expressiveEmotion!, settled).carryover).toBeLessThan(SHANNON_EMOTION_CARRY_THRESHOLD);
    expect(reduceCompanionState(stored, { type: 'body-touched', touch: touch('tickle') }, settled, wall).expressiveEmotion!.primary).toBe('giggle');
  });

  it('keeps a feeling from conversation that is stronger than the touch, and lets a touch replace a weaker one or another touch', () => {
    const feeling = (primary: 'sad' | 'curiosity', intensity: number) => reduceCompanionState(fresh(), { type: 'expressive-emotion-updated', emotion: {
      primary, secondary: [], intensity, target: 'ライ氏', cause: '生成した応答の内容と会話文脈', arousal: 0.3, valence: -0.5,
      visibility: 'expressed', startedAt: START, decay: 0.24, carryover: 0.6, updatedAt: START,
    } }, START);
    // She is sad at 0.8: one pat does not make her happy. The mood still lifts a little.
    const sad = feeling('sad', 0.8);
    const patted = touched(sad, touch('pet'), later(1));
    expect(patted.expressiveEmotion).toEqual(sad.expressiveEmotion);
    expect(patted.emotion.valence).toBeGreaterThan(sad.emotion.valence);
    expect(keepsFeelingThroughTouch(sad.expressiveEmotion, 0.5, later(1))).toBe(true);
    // A faint feeling gives way to the touch and stays as the secondary one.
    const curious = feeling('curiosity', 0.35);
    expect(touched(curious, touch('pet'), later(1)).expressiveEmotion).toMatchObject({ primary: 'happy', secondary: ['curiosity'] });
    // A feeling that came from a touch always gives way to the next touch, however strong it was.
    const fond = [1, 2, 3, 4, 5, 6].reduce((state, count) => touched(state, touch('pet', count, { strength: 1 })), fresh());
    expect(fond.expressiveEmotion!.primary).toBe('affectionate');
    expect(isTouchFeeling(fond.expressiveEmotion)).toBe(true);
    expect(isTouchFeeling(sad.expressiveEmotion)).toBe(false);
    expect(touched(fond, touch('poke'), later(1)).expressiveEmotion!.primary).toBe('surprised');
    expect(keepsFeelingThroughTouch(undefined, 0.5, START)).toBe(false);
  });

  it('is pure: the same touch on the same state gives the same result, and the input is not changed', () => {
    const state = fresh();
    const first = feelTouch(state, touch('holdHand', 2, { strength: 0.4 }), START);
    expect(feelTouch(state, touch('holdHand', 2, { strength: 0.4 }), START)).toEqual(first);
    expect(state.emotion).toEqual(fresh().emotion);
    expect(touched(fresh(), touch('pet', 1, { ownerAlone: false })).expressiveEmotion).toMatchObject({ target: '触れた人', cause: '頭をなでてもらった' });
  });
});

describe('a part where her body flinches first: the reflex alone (Syzygy ADR-0005 stage 1b)', () => {
  const PARTS = ['首', '胸', '腰', '脚', 'スカート'];
  const reflex = (kind: ShannonTouchKind, count = 1, extra: Partial<ShannonTouch> = {}) => touch(kind, count, { reflexPart: '首', ...extra });

  it('moves no pleasantness: valence and openness stay, arousal only rises, for every part, way of touching and count', () => {
    for (const reflexPart of PARTS) {
      for (const kind of SHANNON_TOUCH_KINDS) {
        let state = fresh();
        for (let count = 1; count <= 12; count += 1) {
          const after = touched(state, touch(kind, count, { reflexPart, strength: 1, durationMs: 600_000 }), later(count));
          expect(after.emotion.valence).toBe(state.emotion.valence);
          expect(after.emotion.openness).toBe(state.emotion.openness);
          expect(after.emotion.arousal).toBeGreaterThanOrEqual(state.emotion.arousal);
          expect(after.emotion.arousal - state.emotion.arousal).toBeLessThanOrEqual(SHANNON_TOUCH_MOOD_STEP + 1e-9);
          state = after;
        }
      }
    }
  });

  it('is the table\'s own startle at every count, never a row of the table: no joy from a stroke, no sulk from pokes', () => {
    expect(SHANNON_TOUCH_REFLEX).toBe(SHANNON_TOUCH_FEELINGS.poke.steps[0]);
    for (const kind of SHANNON_TOUCH_KINDS) {
      for (const count of [1, 3, 6, 40]) expect(touchFeeling(reflex(kind, count)).step).toBe(SHANNON_TOUCH_REFLEX);
    }
    const stroked = [1, 2, 3, 4, 5, 6].reduce((state, count) => touched(state, reflex('pet', count), later(count)), fresh());
    expect(stroked.expressiveEmotion!.primary).toBe('surprised');
    const poked = [1, 2, 3, 4, 5].reduce((state, count) => touched(state, reflex('poke', count), later(count)), fresh());
    expect(poked.expressiveEmotion!.primary).toBe('surprised');
    expect(poked.emotion.valence).toBe(fresh().emotion.valence);
    // Firmness and length are felt as for any touch.
    expect(touchFeeling(reflex('poke', 1, { strength: 1 })).intensity).toBeGreaterThan(touchFeeling(reflex('poke', 1, { strength: 0 })).intensity);
  });

  it('names the part as the cause, keeps it a feeling from a touch, and gives way to the next touch', () => {
    expect(touchCause(touch('poke', 1, { reflexPart: '首' }))).toBe('ライ氏に首をつつかれた');
    // The verbs of the reaction prompt, by gesture: a stroke, and a touch that rests.
    expect(touchCause(touch('pet', 2, { reflexPart: '胸' }))).toBe('ライ氏に胸をなでられた（続けて2回目）');
    expect(touchCause(touch('pet', 1, { reflexPart: '胸', resting: true }))).toBe('ライ氏に胸に触れられた');
    expect(touchCause(touch('pet', 1, { resting: true }))).toBe('ライ氏に頭をなでてもらった');
    expect(touchCause(touch('tickle', 1, { reflexPart: '腰', ownerAlone: false }))).toBe('腰をくすぐられた');
    expect(touchCause(touch('carry', 1, { reflexPart: 'スカート' }))).toBe('ライ氏に持ち上げて運ばれた');
    const startled = touched(fresh(), touch('pet', 1, { reflexPart: '胸' }));
    expect(startled.expressiveEmotion).toMatchObject({ primary: 'surprised', target: 'ライ氏', cause: 'ライ氏に胸をなでられた' });
    expect(isTouchFeeling(touched(fresh(), touch('pet', 1, { reflexPart: '脚', resting: true })).expressiveEmotion)).toBe(true);
    expect(isTouchFeeling(startled.expressiveEmotion)).toBe(true);
    expect(touched(startled, touch('holdHand'), later(1)).expressiveEmotion!.primary).toBe('shy');
  });

  it('leaves a touch without a part exactly as the table has it', () => {
    for (const kind of SHANNON_TOUCH_KINDS) {
      for (const count of [1, 3, 6]) {
        expect(touchFeeling(touch(kind, count, { reflexPart: '' }))).toEqual(touchFeeling(touch(kind, count)));
        expect(touched(fresh(), touch(kind, count, { reflexPart: undefined }))).toEqual(touched(fresh(), touch(kind, count)));
      }
    }
  });
});
