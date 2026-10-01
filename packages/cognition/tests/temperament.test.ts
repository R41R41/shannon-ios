import { describe, expect, it } from 'vitest';
import {
  createInitialCompanionState,
  explainTemperament,
  reduceCompanionState,
  restoreCompanionState,
  type CompanionStateEvent,
  type CompanionStateSnapshot,
} from '../src/index.js';

const START = '2026-09-01T00:00:00.000Z';
const day = (offset: number) => new Date(Date.UTC(2026, 8, 1 + offset)).toISOString().slice(0, 10);
const apply = (state: CompanionStateSnapshot, event: CompanionStateEvent, at = START) => reduceCompanionState(state, event, at);

describe('temperament moves only with stored evidence', () => {
  it('starts from the adopted values and does not invent closeness without evidence', () => {
    const initial = createInitialCompanionState('owner', START);
    expect(initial.temperament.closeness).toBe(0.15);
    const calibrated = apply(initial, { type: 'shared-time-observed', days: [], today: day(0) });
    expect(calibrated.temperament.closeness).toBe(0.15);
    expect(calibrated.temperament.curiosity).toBe(0.5);
    expect(calibrated.temperament).toMatchObject({ initiative: 0.25, calmness: 0.6, needForContinuity: 0.7 });
  });

  it('grows closeness slowly with days talked and returns when the owner is away', () => {
    let state = createInitialCompanionState('owner', START);
    state = apply(state, { type: 'shared-time-observed', days: [day(0)], today: day(0) });
    expect(state.temperament.closeness).toBe(0.17);
    const sameDay = apply(state, { type: 'shared-time-observed', days: [day(0)], today: day(0) });
    expect(sameDay).toBe(state);
    for (let offset = 1; offset < 30; offset += 1) {
      state = apply(state, { type: 'shared-time-observed', days: [day(offset)], today: day(offset) });
    }
    expect(state.sharedDays).toHaveLength(30);
    expect(state.temperament.closeness).toBe(0.65);
    // Twenty days of silence, then one conversation: only ten earlier days remain in the window.
    state = apply(state, { type: 'shared-time-observed', days: [day(49)], today: day(49) });
    expect(state.sharedDays).toHaveLength(11);
    expect(state.temperament.closeness).toBe(0.33);
    expect(explainTemperament(state, day(49)).closeness).toBe('この30日で11日話した');
  });

  it('counts kept promises and remembered facts, and gives them back when forgotten', () => {
    let state = createInitialCompanionState('owner', START);
    for (let index = 0; index < 5; index += 1) {
      state = apply(state, { type: 'prospective-memory-upserted', memory: {
        id: `promise-${index}`, summary: `約束${index}`, status: 'pending', createdAt: START, updatedAt: START,
      } });
      state = apply(state, { type: 'prospective-memory-status-changed', memoryId: `promise-${index}`, status: 'completed' });
    }
    state = apply(state, { type: 'user-fact-upserted', fact: {
      id: 'fact-1', statement: 'コーヒーが好き', confidence: 1, observedAt: START,
    } });
    state = apply(state, { type: 'interest-observed', interest: '天体観測' });
    state = apply(state, { type: 'shared-time-observed', days: [day(0)], today: day(0) });
    expect(state.temperament).toMatchObject({ closeness: 0.37, curiosity: 0.53, confidenceAboutUser: 0.08 });
    expect(explainTemperament(state, day(0))).toEqual({
      closeness: 'この30日で1日話した・守れた約束5件（90日以内）',
      curiosity: 'いま育っている関心1件',
      confidenceAboutUser: '覚えていること1件から',
    });
    state = apply(state, { type: 'memory-control-upserted', control: {
      memoryId: 'fact-1', kind: 'user-fact', status: 'forgotten', pinned: false, updatedAt: START, changeReason: '忘れて',
    } });
    state = apply(state, { type: 'shared-time-observed', days: [day(1)], today: day(1) });
    expect(state.temperament.confidenceAboutUser).toBe(0.05);
  });

  it('survives a restore and reads snapshots written before the evidence existed', () => {
    let state = createInitialCompanionState('owner', START);
    state = apply(state, { type: 'shared-time-observed', days: [day(0), day(1), 'not-a-day'], today: day(1) });
    const restored = restoreCompanionState('owner', JSON.parse(JSON.stringify(state)), START);
    expect(restored.sharedDays).toEqual([day(0), day(1)]);
    expect(restored.temperament.closeness).toBe(state.temperament.closeness);
    const legacy = JSON.parse(JSON.stringify(createInitialCompanionState('owner', START)));
    expect(restoreCompanionState('owner', legacy, START).sharedDays).toBeUndefined();
  });
});
