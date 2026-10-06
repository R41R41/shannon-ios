import { describe, expect, it } from 'vitest';
import { appraiseChoice, appraiseTouch } from '../src/index.js';

/** Syzygy ADR-0008 stage 1, step 7b: a settled choice moves her by the stage-2 step, or only a share of it (the hourly safeguard). */
describe('appraiseChoice', () => {
  const emotion = { valence: 0.1, arousal: 0.3, openness: 0.35 };
  const outcome = { error: 0.6, expectation: 0.2, unexpected: 0.7 };

  it('is the touch\'s bounded step at full share, half of it at half, and nothing at zero', () => {
    const full = appraiseTouch(emotion, outcome);
    expect(appraiseChoice(emotion, outcome)).toEqual(full);
    const half = appraiseChoice(emotion, outcome, 0.5);
    expect(half.valence - emotion.valence).toBeCloseTo((full.valence - emotion.valence) / 2, 12);
    expect(half.arousal - emotion.arousal).toBeCloseTo((full.arousal - emotion.arousal) / 2, 12);
    expect(appraiseChoice(emotion, outcome, 0)).toEqual(emotion);
    expect(appraiseChoice(emotion, outcome, 3)).toEqual(full);
  });
});
