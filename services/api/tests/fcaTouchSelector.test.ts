import { describe, expect, it } from 'vitest';
import { InMemoryCompanionStateStore } from '@shannon/cognition';
import { JevChoiceClient, JevChooser, type JevChoiceTrace } from '../src/infra/models/jev/jevChoice.js';
import { JevTouchSelector, type FcaTouchInput } from '../src/mind/action/reflex/fcaTouchPorts.js';
const input: FcaTouchInput = { scopeKey: 'owner', deviceId: 'phone', touchId: 'one', experienceId: 'existing', observedAt: '2026-10-09T00:00:00Z', audience: 'owner',
  touch: { type: 'poke', part: 'head', reflex: 'drawBack' }, emotion: new InMemoryCompanionStateStore(() => '2026-10-09T00:00:00Z').snapshot('owner').emotion,
  stateVersion: 1, stances: ['uneasy'], stanceSourceIds: ['prior'], gestures: ['wave', 'nod'] };
function selector(answer: unknown) {
  const requests: Record<string, unknown>[] = [], traces: JevChoiceTrace[] = [];
  const jev = new JevChooser(new JevChoiceClient({ apiKey: 'synthetic', fetcher: (async (_url, init) => {
    requests.push(JSON.parse(String(init?.body))); return Response.json({ answers: answer });
  }) as typeof fetch }), { cacheMilliseconds: 0, usdPerCall: null, trace: (_scope, trace) => { traces.push(trace); } });
  return { selector: new JevTouchSelector(jev), requests, traces };
}
describe('closed touch gesture candidate selection', () => {
  it('parses the real Jev choice envelope, carries stance and local reflex context, and keeps traces content-free', async () => {
    const f = selector({ gesture: { type: 'choice', choice: 'g1' } });
    expect(await f.selector.select(input, new AbortController().signal)).toBe('nod');
    expect(f.requests[0]?.state).toMatchObject({ toucher: 'unknown', immediateReflex: 'drawBack', priorStances: ['uneasy'], posture: 'not_reported' });
    expect(JSON.stringify(f.traces)).not.toContain('uneasy');
    expect(f.traces[0]?.answers).toMatchObject({ qv: ['fca_touch_reflex.v1'], choice: 'g1' });
  });
  it('distinguishes choosing none from unknown or invented results and avoids a call after abort', async () => {
    expect(await selector({ gesture: { choice: 'none' } }).selector.select(input, new AbortController().signal)).toBeNull();
    await expect(selector({ gesture: { choice: 'invented' } }).selector.select(input, new AbortController().signal)).rejects.toThrow('UNKNOWN');
    const f = selector({ gesture: { choice: 'g0' } }), controller = new AbortController(); controller.abort();
    await expect(f.selector.select(input, controller.signal)).rejects.toThrow(); expect(f.requests).toEqual([]);
  });
});
