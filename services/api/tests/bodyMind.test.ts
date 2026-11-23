import { describe, expect, it } from 'vitest';
import { InMemoryCompanionStateStore } from '@shannon/cognition';
import { createLocalApiKernel } from '../src/wiring/apiKernelWiring.js';
import { SQLiteBodyStore } from '../src/surfaces/body/store/bodyStore.js';
import { BODY_MIND_LIMITS, BODY_MIND_PATH, type BodyMind } from '../src/contracts/bodyMindContract.js';
import { mindCauseLine } from '../src/surfaces/body/bodyMind.js';
import type { BodyPresence } from '../src/surfaces/body/shannonBody.js';
import { scope } from './autonomyLoopHarness.js';

const MINUTE = 60_000;
const START = '2026-11-24T01:00:00.000Z';

function harness() {
  const clock = { at: START };
  const now = () => clock.at;
  const stateStore = new InMemoryCompanionStateStore(now);
  const api = createLocalApiKernel(now, { stateStore, body: { store: new SQLiteBodyStore(':memory:'), ingestEnabled: true } });
  const get = (path: string) => api.dispatch({ method: 'GET', path, query: new URLSearchParams({ scopeKey: scope }), deviceId: 'body-pc' });
  const mind = async () => (await get(BODY_MIND_PATH)).body as BodyMind;
  const advance = (milliseconds: number) => { clock.at = new Date(Date.parse(clock.at) + milliseconds).toISOString(); };
  const feel = (primary: string, intensity: number, cause: string, extra: Record<string, unknown> = {}) => stateStore.apply(scope, {
    type: 'expressive-emotion-updated',
    emotion: { primary, secondary: [], intensity, target: 'マイクラ', cause, arousal: 0.6, valence: 0.3, visibility: 'expressed', startedAt: clock.at, decay: 0.2, carryover: 0.8,
      updatedAt: clock.at, ...extra } as never,
  });
  return { clock, api, get, mind, advance, feel, stateStore };
}

describe('GET /v1/body/mind', () => {
  it('answers a quiet mind as neutral with no reason and a one-point flow', async () => {
    const { mind } = harness();
    const view = await mind();
    expect(view).toMatchObject({ schemaVersion: 1, generatedAt: START, pollAfterSeconds: BODY_MIND_LIMITS.pollAfterSeconds,
      feeling: { primary: 'neutral', intensity: 0, cause: '' } });
    expect(view.feeling.since).toBeUndefined();
    expect(view.flow).toEqual([{ at: START, primary: 'neutral', intensity: 0 }]);
  });

  it('carries the game feeling with its reason, which presence leaves out', async () => {
    const { mind, feel, get } = harness();
    feel('frustrated', 0.6, 'マイクラで骨を取るのに何度も落ちてしまう');
    const view = await mind();
    expect(view.feeling).toMatchObject({ primary: 'frustrated', cause: '骨を取るのに何度も落ちてしまう', since: START });
    expect(view.feeling.intensity).toBeGreaterThan(0.3);
    const presence = (await get('/v1/body/presence')).body as BodyPresence;
    expect(JSON.stringify(presence)).not.toContain('骨を取る');
  });

  it('leaves the reason empty when the feeling came from talking or settled down, but still shows the feeling', async () => {
    const { mind, feel } = harness();
    for (const cause of ['生成した応答の内容と会話文脈', 'Jevの暫定判断と会話文脈', '直前の感情が自然に続いている', '前の気持ちは時間とともに落ち着いた']) {
      feel('happy', 0.6, cause);
      const view = await mind();
      expect(view.feeling.primary).toBe('happy');
      expect(view.feeling.cause).toBe('');
    }
  });

  it('builds the flow from reads: a change or a step of strength is a point, the same one is not, ten minutes is the edge', async () => {
    const { mind, feel, advance } = harness();
    await mind();
    advance(5_000);
    expect((await mind()).flow).toHaveLength(1);
    feel('happy', 0.6, 'マイクラで牛で満腹になれた');
    advance(5_000);
    expect((await mind()).flow.map(point => point.primary)).toEqual(['neutral', 'happy']);
    advance(5_000);
    expect((await mind()).flow).toHaveLength(2);
    advance(MINUTE);
    expect((await mind()).flow).toHaveLength(3);
    advance(11 * MINUTE);
    const late = await mind();
    expect(late.flow.every(point => Date.parse(late.generatedAt) - Date.parse(point.at) <= BODY_MIND_LIMITS.flowMilliseconds)).toBe(true);
    expect(late.flow.length).toBeLessThanOrEqual(BODY_MIND_LIMITS.flowPoints);
  });

  it('needs a scope key, like the rest of the body routes', async () => {
    const { api } = harness();
    expect((await api.dispatch({ method: 'GET', path: BODY_MIND_PATH, query: new URLSearchParams(), deviceId: 'body-pc' })).status).toBe(400);
  });
});

describe('mindCauseLine', () => {
  it('makes one short line without the game prefix, brackets or control characters', () => {
    expect(mindCauseLine('マイクラで「骨」を\n取った')).toBe('骨を 取った');
    expect(mindCauseLine('生成した応答の内容と会話文脈')).toBe('');
    expect(mindCauseLine('あ'.repeat(80))).toHaveLength(BODY_MIND_LIMITS.causeCharacters);
    expect(mindCauseLine(undefined)).toBe('');
  });
});
