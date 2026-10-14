import { describe, expect, it } from 'vitest';
import { createReflexGovernor, reflexPlace } from '../src/mind/action/reflex/reflexGovernor.js';

const visual = { mode: 'visual' as const };
const stuck = (place: string | null = '1,32,1') => ({ mode: 'stuck' as const, place });
const danger = (kind: 'health' | 'oxygen' | 'threat', value: number) => ({ mode: 'danger' as const, danger: { kind, value } });

describe('reflex governor (Minecraft run 10: 44 automatic sessions, one action, the FCA starved)', () => {
  it('holds a mode for its cooldown after a session without effect, and not after one that acted', () => {
    const governor = createReflexGovernor();
    governor.began('task', 0, visual); governor.ended('task', 4_000, visual, false);
    expect(governor.admit('task', 10_000, visual)).toEqual({ admit: false, reason: 'reflex_cooldown' });
    expect(governor.admit('task', 34_000, visual)).toEqual({ admit: true, escalated: false });
    governor.began('task', 40_000, visual); governor.ended('task', 41_000, visual, true);
    expect(governor.admit('task', 42_000, visual)).toEqual({ admit: true, escalated: false });
    expect(governor.admit('other', 10_000, visual)).toEqual({ admit: true, escalated: false });
  });

  it('gives danger a short cooldown, and never holds danger that is getting worse', () => {
    const governor = createReflexGovernor();
    governor.began('task', 0, danger('health', 7)); governor.ended('task', 1_000, danger('health', 7), false);
    expect(governor.admit('task', 3_000, danger('health', 7))).toEqual({ admit: false, reason: 'reflex_cooldown' });
    expect(governor.admit('task', 3_000, danger('threat', 2))).toEqual({ admit: false, reason: 'reflex_cooldown' });
    expect(governor.admit('task', 6_100, danger('health', 7))).toEqual({ admit: true, escalated: false });
    // Lower health than at the last danger entry, or critical health: admitted at once.
    expect(governor.admit('task', 3_000, danger('health', 6))).toEqual({ admit: true, escalated: true });
    expect(governor.admit('task', 3_000, danger('health', 4))).toEqual({ admit: true, escalated: true });
  });

  it('keeps automatic sessions under the per-minute budget, except worsening danger', () => {
    const governor = createReflexGovernor();
    governor.began('task', 0, visual); governor.ended('task', 20_000, visual, true);
    expect(governor.admit('task', 21_000, visual)).toEqual({ admit: false, reason: 'reflex_budget' });
    expect(governor.admit('task', 21_000, danger('threat', 3))).toEqual({ admit: false, reason: 'reflex_budget' });
    governor.began('task', 21_000, danger('oxygen', 6)); governor.ended('task', 22_000, danger('oxygen', 6), true);
    expect(governor.admit('task', 23_000, danger('oxygen', 4))).toEqual({ admit: true, escalated: true });
    // The window slides: once the old session leaves the last minute, there is room again.
    expect(governor.admit('task', 75_000, visual)).toEqual({ admit: true, escalated: false });
  });

  it('enters a stuck place once until the FCA decides again, a new place, or the latch expires', () => {
    const governor = createReflexGovernor();
    governor.began('task', 0, stuck()); governor.ended('task', 2_000, stuck(), true);
    expect(governor.admit('task', 5_000, stuck())).toEqual({ admit: false, reason: 'stuck_latched' });
    expect(governor.admit('task', 5_000, stuck('9,32,1'))).toEqual({ admit: true, escalated: false });
    expect(governor.admit('task', 5_000, visual)).toEqual({ admit: true, escalated: false });
    expect(governor.admit('task', 123_000, stuck())).toEqual({ admit: true, escalated: false });
    governor.decided('task', 6_000);
    expect(governor.admit('task', 7_000, stuck())).toEqual({ admit: true, escalated: false });
  });

  it('reads a place as a 2-block cell of the world position', () => {
    expect(reflexPlace({ position: { x: 3.4, y: 64, z: -0.5 } })).toBe('1,32,-1');
    expect(reflexPlace({ position: { x: 3 } })).toBeNull();
    expect(reflexPlace(null)).toBeNull();
  });
});
