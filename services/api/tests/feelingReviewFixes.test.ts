import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { feelingActor, type FeelingEvent } from '@shannon/cognition';
import { FeelingStrongChatModel } from '../src/infra/models/feelingStrongChatModel.js';
import { SQLiteFeelingEventStore } from '../src/mind/emotion/store/feelingEventStore.js';
import { feelingVoice } from '../src/mind/emotion/feelingPorts.js';
import { feelingPort } from './support/feelingHarness.js';
import type { ShannonChatModel, ShannonChatModelRequest } from '../src/infra/models/chatModel.js';

/** The independent review of stage 1 (2026-10-14): what must hold once the switches are on. */
const request = (extra: Partial<ShannonChatModelRequest> = {}) => ({ scopeKey: 'owner', systemPrompt: '', message: 'x', ...extra }) as ShannonChatModelRequest;
const answering = (model: string, calls: string[], fail = false): ShannonChatModel => ({
  mode: 'local-stub', model, generate: async () => {
    calls.push(model);
    if (fail) throw new Error('down');
    return { mode: 'local-stub', model, reply: model };
  },
});

describe('review of stage 1', () => {
  it('P2-1: keeps the per-turn model of before (its mode pinned at admission) behind the strong wrapper', async () => {
    const calls: string[] = [];
    const pinned = answering('pinned', calls);
    const inner: ShannonChatModel = { ...answering('unpinned', calls), forTurn: () => pinned };
    const wrapper = new FeelingStrongChatModel(inner, answering('sonnet', calls) as never);
    const turn = wrapper.forTurn('owner');
    await turn.generate(request());
    expect(calls).toEqual(['pinned']);
    expect(turn).toBeInstanceOf(FeelingStrongChatModel);
  });

  it('P3a: a strong turn that fails stops counting against the day\'s cap', async () => {
    const calls: string[] = [];
    const released: string[] = [];
    const sonnet = { ...answering('sonnet', calls, true), outOfTimeTurn: async () => ({ mode: 'anthropic', model: 'sonnet', reply: '' }) };
    const wrapper = new FeelingStrongChatModel(answering('haiku', calls, true), sonnet as never, { released: scope => released.push(scope), log: () => {} });
    await expect(wrapper.generate(request({ feelingStrong: true }))).rejects.toThrow('down');
    expect(released).toEqual(['owner']);
  });

  it('P2-3: stores the presentation id the voice turn answered with, stance included', () => {
    const at = '2026-10-14T04:00:00.000Z';
    const port = feelingPort(() => at);
    const snapshot = { emotion: { valence: 0, arousal: 0.3, openness: 0.35 }, memoryControls: [] } as never;
    const handle = feelingVoice.start(port, { scopeKey: 'owner', alone: true, guest: false, threadId: 't', transcript: 'お前ポンコツだな', at, snapshot })!;
    handle.decision = { stance: 'snipe', intensity: 'strong', drawer: 'none', register: 'normal', source: 'jev' };
    const answered = feelingVoice.presented(handle, { primary: 'happy', intensity: 0.4 } as never, snapshot, at, 'u1');
    expect(answered.presentationId).toBe('irked');
    const stored = feelingVoice.stored(port, { expression: 'joyful', valence: 0, arousal: 0, openness: 0 }, { scopeKey: 'owner', utteranceId: 'u1', at });
    expect(stored.presentationId).toBe('irked');
    const later = feelingVoice.stored(port, { expression: 'joyful', valence: 0, arousal: 0, openness: 0 }, { scopeKey: 'owner', utteranceId: 'u1', at });
    expect(later.presentationId).toBe('joyful');
  });

  it('P3b: a long day keeps its newest events, returned oldest first', () => {
    const store = new SQLiteFeelingEventStore(new DatabaseSync(':memory:'));
    const actor = feelingActor({ ownerAlone: true });
    for (const minute of [1, 2, 3]) {
      const event: FeelingEvent = { ...actor, id: `e${minute}`, kind: 'spoke', identity: 'registered', channel: 'text', sourceId: null, facts: {},
        occurredAt: new Date(Date.UTC(2026, 9, 14, 4, minute)).toISOString() };
      store.record('owner', event, event.occurredAt);
    }
    expect(store.between('owner', '2026-10-14T00:00:00.000Z', '2026-10-14T05:00:00.000Z', 2).map(event => event.id)).toEqual(['e2', 'e3']);
  });
});
