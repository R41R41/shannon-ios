import { describe, expect, it } from 'vitest';
import { nextInitiativeDelayMilliseconds } from '../src/initiativeSchedule.js';

describe('initiative decision cadence', () => {
  it('waits until 07:00 Tokyo after a successful daily initiative', () => {
    expect(nextInitiativeDelayMilliseconds(
      { considered: 80, sent: 1, stopped: null },
      '2026-09-03T22:00:57.000Z',
    )).toBe(86_343_000);
  });

  it('wakes exactly at 07:00 Tokyo from quiet hours', () => {
    expect(nextInitiativeDelayMilliseconds(
      { considered: 0, sent: 0, stopped: 'quiet-hours' },
      '2026-09-03T19:36:51.000Z',
    )).toBe(8_589_000);
  });

  it('rechecks changing candidates without delaying push delivery', () => {
    expect(nextInitiativeDelayMilliseconds(
      { considered: 12, sent: 0, stopped: 'nothing-worth-saying' },
    )).toBe(900_000);
    expect(nextInitiativeDelayMilliseconds(
      { considered: 0, sent: 0, stopped: 'recent-conversation' },
    )).toBe(900_000);
  });
});
