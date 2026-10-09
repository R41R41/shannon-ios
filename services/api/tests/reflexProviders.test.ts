import { describe, expect, it } from 'vitest';
import { createReflexProviders } from '../src/infra/models/reflexProviders.js';
import { OpenAIReflexSelector, type ReflexDecisionUsage } from '../src/infra/models/openAIReflexSelector.js';
import { JevReflexEntrySelector, JevReflexSelector } from '../src/infra/models/jev/jevReflex.js';
import { JevChoiceClient, JevChooser, type JevChoiceTrace } from '../src/infra/models/jev/jevChoice.js';
import { countedJevFetch } from '../src/infra/models/jev/jevClient.js';
import { installObserverSink, withObserverRun } from '../src/infra/observer/observerContext.js';
import type { ObserverDraft } from '../src/contracts/observerContract.js';
import type { ReflexChoiceInput } from '../src/mind/action/reflex/reflexPorts.js';

const now = () => Date.parse('2026-10-09T00:00:00.000Z'), signal = () => new AbortController().signal;
const frame = { ref: 'authorized-frame', capturedAt: '2026-10-08T23:59:59.000Z', expiresAt: '2026-10-09T00:00:10.000Z' };
const picture = 'data:image/png;base64,aW1hZ2UtZml4dHVyZQ==';
function input(): ReflexChoiceInput {
  const context = { scopeKey: 'owner', taskId: 'task', taskRevision: 3, bodyId: 'body', sessionId: 'session', generation: 2,
    goal: 'PRIVATE_GOAL', completionCondition: 'PRIVATE_COMPLETION', taskState: { phase: 'executing', progress: 'PRIVATE_TASK_STATE',
      activeAction: { name: 'mc.move-to', operationId: 'private-operation', input: { x: 12, y: 64, z: 4 } }, recentResults: [] } };
  const observation = { schemaVersion: 1 as const, bodyId: 'body', sequence: 10, stateAt: frame.capturedAt, receivedAt: frame.capturedAt,
    connected: true, state: { self: { health: 12 }, environment: { threat: 'PRIVATE_OBSERVATION' } }, facts: { target: 'entity-1' }, image: frame };
  return { context, observation, previousObservation: { ...observation, sequence: 9, image: { ...frame, ref: 'previous-frame' } },
    candidates: [{ id: 'candidate-private-ID', kind: 'action', label: 'PRIVATE_LABEL', operation: 'move', arguments: { direction: 'backward', durationMs: 100 },
      preconditions: [{ key: 'target', value: 'entity-1' }], maxDurationMs: 100, expiresAt: frame.expiresAt, requiresImage: true,
      sessionId: 'session', generation: 2, taskRevision: 3, observationSequence: 10 }],
    recent: [{ schemaVersion: 1, operationId: 'operation-private-ID', bodyId: 'body', sessionId: 'session', generation: 2, outcome: 'unknown',
      observedAt: frame.capturedAt, inputsReleased: true, evidenceId: 'PRIVATE_EVIDENCE' }] };
}
const answer = (overrides: Record<string, unknown> = {}) => ({ model: 'gpt-6-luna',
  answers: [{ type: 'choice', name: 'reflex_action.v1', choice: 'candidate-private-ID', confidence: 0.7,
    probabilities: [{ value: 'candidate-private-ID', probability: 0.7 }] }],
  usage: { input_tokens: 120, input_tokens_details: { cached_tokens: 20, cache_write_tokens: 0 }, output_tokens: 0,
    output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 120, compute_units: 3 }, ...overrides });
function openai(respond: (body: Record<string, unknown>, init: RequestInit) => Promise<Response> | Response = () => Response.json(answer())) {
  const bodies: Record<string, unknown>[] = [], urls: string[] = [], usage: ReflexDecisionUsage[] = [], frames: string[] = [];
  const options = { apiKey: 'synthetic', now, unknownCostUpperBoundUsd: 0.02, recordUsage: (item: ReflexDecisionUsage) => { usage.push(item); },
    loadImage: async (reference: typeof frame) => { frames.push(reference.ref); return picture; },
    fetcher: (async (url, init) => { urls.push(String(url)); const body = JSON.parse(String(init?.body)); bodies.push(body); return respond(body, init!); }) as typeof fetch };
  return { selector: new OpenAIReflexSelector(options), options, bodies, urls, usage, frames };
}
function jev(respond: (init: RequestInit) => Promise<Response> | Response = () => Response.json({ answers: { action: { type: 'choice', choice: 'candidate_0' } } })) {
  const bodies: Record<string, unknown>[] = [], traces: JevChoiceTrace[] = [], signals: AbortSignal[] = [];
  const fetcher = countedJevFetch((async (_url, init) => { bodies.push(JSON.parse(String(init?.body))); signals.push(init!.signal as AbortSignal); return respond(init!); }) as typeof fetch);
  const chooser = new JevChooser(new JevChoiceClient({ apiKey: 'synthetic', fetcher }), { cacheMilliseconds: 0, usdPerCall: 0.001,
    trace: (_scope, trace) => { traces.push(trace); }, now: () => new Date(now()).toISOString() });
  return { chooser, bodies, traces, signals };
}

describe('tool-free native Decisions body selection', () => {
  it('uses the documented choice schema with both inline images and all supplied state, returning only the chosen registered ID', async () => {
    const f = openai(), result = await f.selector.choose(input(), signal());
    expect(result).toEqual({ sessionId: 'session', generation: 2, candidateId: 'candidate-private-ID' });
    expect(f.urls).toEqual(['https://api.openai.com/v1/decisions']); expect(f.frames).toEqual(['previous-frame', 'authorized-frame']);
    expect(Object.keys(f.bodies[0]!)).toEqual(['model', 'input', 'questions']);
    expect(f.bodies[0]!.questions).toMatchObject([{ type: 'choice', name: 'reflex_action.v1', choices: [{ value: 'candidate-private-ID' }] }]);
    const messages = f.bodies[0]!.input as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    expect(messages.map(message => message.role)).toEqual(['user']);
    expect(messages[0]!.content.filter(part => part.type === 'input_image')).toEqual([{ type: 'input_image', image_url: picture, detail: 'low' }, { type: 'input_image', image_url: picture, detail: 'low' }]);
    const evidence = JSON.parse(String(messages[0]!.content[0]!.text));
    expect(evidence).toMatchObject({ task: { goal: 'PRIVATE_GOAL', completionCondition: 'PRIVATE_COMPLETION', taskState: input().context.taskState }, observation: { state: input().observation.state }, recent: [{ outcome: 'unknown' }] });
    expect(JSON.stringify(messages)).not.toContain('authorized-frame');
    expect(f.usage).toMatchObject([{ usageComplete: true, inputTokens: 120, cachedInputTokens: 20, totalTokens: 120, computeUnits: 3, estimatedCostUsd: 0.000012 }]);
  });
  it('has no request, image read or configuration validation while disabled', () => {
    const f = openai();
    expect(createReflexProviders({ decisions: { ...f.options, apiKey: '' } })).toBeNull();
    expect(f.bodies).toEqual([]); expect(f.frames).toEqual([]);
  });
  it('supports text-only observations, provider refusal, and candidate expiry without synthesizing an action', async () => {
    const noImage = input(); delete noImage.observation.image; delete noImage.previousObservation; noImage.candidates = noImage.candidates.map(candidate => ({ ...candidate, requiresImage: false }));
    const f = openai(() => Response.json(answer({ answers: [{ type: 'refusal', name: 'reflex_action.v1' }] })));
    expect(await f.selector.choose(noImage, signal())).toBeNull(); expect(f.frames).toEqual([]); expect(f.usage).toHaveLength(1);
    const expired = openai(); noImage.candidates = noImage.candidates.map(candidate => ({ ...candidate, expiresAt: '2026-10-08T00:00:00Z' }));
    expect(await expired.selector.choose(noImage, signal())).toBeNull();
  });
  it.each([
    [{ answers: [{ type: 'choice', name: 'reflex_action.v1', choice: 'invented-attack' }] }, 'REFLEX_DECISIONS_ANSWER_INVALID'],
    [{ answers: [] }, 'REFLEX_DECISIONS_ANSWER_INVALID'],
    [{ usage: { input_tokens: 90 } }, 'REFLEX_DECISIONS_USAGE_UNKNOWN'],
    [{ usage: null }, 'REFLEX_DECISIONS_USAGE_UNKNOWN'],
  ])('accounts for unusable responses before rejecting them, without retry %#', async (reply, code) => {
    const f = openai(() => Response.json(answer(reply)));
    await expect(f.selector.choose(input(), signal())).rejects.toThrow(code); expect(f.bodies).toHaveLength(1); expect(f.usage).toHaveLength(1);
    if (code.includes('USAGE')) { expect(f.usage[0]!.usageComplete).toBe(false); expect(f.usage[0]!.estimatedCostUsd).toBeGreaterThanOrEqual(0.02); }
    else expect(f.usage[0]!.inputTokens).toBe(120);
  });
  it('retains interrupted unknown spend and does not follow remote image URLs', async () => {
    const f = openai(async () => { throw new Error('PRIVATE_TRANSPORT_ERROR'); });
    await expect(f.selector.choose(input(), signal())).rejects.toThrow('REFLEX_DECISIONS_RESPONSE_UNKNOWN');
    expect(f.bodies).toHaveLength(1); expect(f.usage[0]).toMatchObject({ usageComplete: false, estimatedCostUsd: 0.02 });
    const bad = new OpenAIReflexSelector({ ...f.options, loadImage: async () => 'https://private.invalid/frame' });
    await expect(bad.choose(input(), signal())).rejects.toThrow('REFLEX_IMAGE_INVALID'); expect(f.bodies).toHaveLength(1);
  });
  it('rejects a late answer after cancellation while recording its known usage and serializing calls to the same body', async () => {
    let finish!: (response: Response) => void;
    const f = openai(() => new Promise(resolve => { finish = resolve; })), controller = new AbortController();
    const pending = f.selector.choose(input(), controller.signal);
    while (!finish) await Promise.resolve();
    await expect(f.selector.choose(input(), signal())).rejects.toThrow('REFLEX_PROVIDER_BUSY');
    controller.abort(); finish(Response.json(answer())); await expect(pending).rejects.toThrow();
    expect(f.bodies).toHaveLength(1); expect(f.usage).toMatchObject([{ usageComplete: true, inputTokens: 120 }]);
    await expect(f.selector.choose(input(), controller.signal)).rejects.toThrow(); expect(f.bodies).toHaveLength(1);
  });
  it('projects no image, observation, goal, free arguments or IDs to Observer', async () => {
    const events: ObserverDraft[] = [], restore = installObserverSink(event => { events.push(event); });
    try {
      const f = openai(); await withObserverRun({ scopeKey: 'owner', surface: 'reflex' }, () => f.selector.choose(input(), signal()));
      expect(events.some(event => event.node === 'native')).toBe(true); expect(events.some(event => event.node === 'llm')).toBe(true);
      expect(JSON.stringify(events)).not.toMatch(/PRIVATE_|private-ID|image\/png|durationMs|direction/u);
    } finally { restore(); }
  });
});

describe('Jev entry and registered body choices', () => {
  it('classifies entry with a fixed question version, state and existing content-free usage trace', async () => {
    const f = jev(() => Response.json({ answers: { entry: { type: 'choice', choice: 'enter_danger' } } }));
    expect(await new JevReflexEntrySelector(f.chooser).evaluate({ ...input(), trigger: 'observation' }, signal()))
      .toEqual({ sessionId: 'session', generation: 2, decision: 'enter', reason: 'danger' });
    expect(f.bodies).toHaveLength(1); expect(f.traces[0]).toMatchObject({ costUsd: 0.001, outcome: 'ok', answers: { qv: ['reflex_entry.v1'] } });
    expect(JSON.stringify(f.traces)).not.toMatch(/PRIVATE_|private-ID/u);
  });
  it('maps ordinal choices back to resolved IDs without reconstructing arguments, and allows no action', async () => {
    const f = jev(), selector = new JevReflexSelector(f.chooser);
    const request = input(); request.candidates = request.candidates.map(candidate => ({ ...candidate, requiresImage: false }));
    expect(await selector.choose(request, signal())).toEqual({ sessionId: 'session', generation: 2, candidateId: 'candidate-private-ID' });
    expect(f.traces[0]).toMatchObject({ answers: { qv: ['reflex_action.v1'], selectedIndex: 0, 'a.action': 'candidate_0' } });
    expect(JSON.stringify(f.traces)).not.toMatch(/PRIVATE_|private-ID/u);
    const none = jev(() => Response.json({ answers: { action: { choice: 'none' } } }));
    expect(await new JevReflexSelector(none.chooser).choose(input(), signal())).toBeNull();
    expect(await selector.choose(input(), signal())).toBeNull(); // No unseen pixel-dependent action through Jev.
  });
  it.each(['timeout', 'invalid'] as const)('returns no action after %s and preserves one accounted Jev attempt', async kind => {
    const f = jev(() => { if (kind === 'timeout') throw new DOMException('private timeout', 'TimeoutError'); return Response.json({ answers: { action: { choice: 'invented' } } }); });
    expect(await new JevReflexSelector(f.chooser).choose(input(), signal())).toBeNull();
    expect(f.bodies).toHaveLength(1); expect(f.traces).toHaveLength(1); expect(f.traces[0]).toMatchObject({ outcome: kind === 'timeout' ? 'timeout' : 'fallback', costUsd: 0.001 });
  });
  it('passes abort to the existing HTTP client, records attempted cost, and never adopts a late response', async () => {
    let finish!: (response: Response) => void;
    const f = jev(() => new Promise(resolve => { finish = resolve; })), controller = new AbortController();
    const pending = new JevReflexSelector(f.chooser).choose(input(), controller.signal);
    while (!finish) await Promise.resolve(); controller.abort(); expect(f.signals[0]!.aborted).toBe(true);
    finish(Response.json({ answers: { action: { choice: 'candidate_0' } } })); await expect(pending).rejects.toThrow();
    expect(f.bodies).toHaveLength(1); expect(f.traces).toHaveLength(1); expect(f.traces[0]!.costUsd).toBe(0.001);
  });
});
