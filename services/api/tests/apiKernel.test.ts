import { describe, expect, it } from 'vitest';
import { createLocalApiKernel } from '../src/apiKernel.js';
import type { ShannonChatModel, ShannonChatModelRequest } from '../src/chatModel.js';

class RecordingChatModel implements ShannonChatModel {
  readonly mode = 'openai' as const;
  readonly model = 'test-model';
  readonly requests: ShannonChatModelRequest[] = [];

  async generate(request: ShannonChatModelRequest) {
    this.requests.push(request);
    return { mode: this.mode, model: this.model, reply: `返答${this.requests.length}` };
  }
}

describe('Shannon local API kernel', () => {
  it('reports the configured LLM in health', async () => {
    const api = createLocalApiKernel(() => '2026-08-31T00:00:00.000Z');
    expect(await api.dispatch({ method: 'GET', path: '/health' })).toEqual({
      status: 200,
      body: {
        ok: true,
        service: 'shannon-ios-api',
        mode: 'local',
        llm: { mode: 'local-stub', model: 'local-stub' },
      },
    });
  });

  it('captures one immutable state version for a chat turn', async () => {
    let tick = 0;
    const api = createLocalApiKernel(() => `2026-08-31T00:00:0${tick++}.000Z`);
    const first = await api.dispatch({
      method: 'POST', path: '/v1/chat', body: { scopeKey: 'owner-a', message: 'こんにちは' },
    });
    await api.waitForBackground('owner-a');
    await api.dispatch({ method: 'POST', path: '/v1/events', body: {
      scopeKey: 'owner-a', event: { type: 'interest-observed', interest: '脳科学' },
    } });
    const second = await api.dispatch({
      method: 'POST', path: '/v1/chat', body: { scopeKey: 'owner-a', message: '続き' },
    });
    expect(first).toMatchObject({
      status: 200,
      body: { mode: 'local-stub', snapshotVersion: 0, messageEmotion: { expression: 'calm' } },
    });
    expect(second).toMatchObject({ status: 200, body: { mode: 'local-stub', snapshotVersion: 2 } });
    expect(JSON.stringify(first.body)).not.toContain('脳科学');
    expect(JSON.stringify(second.body)).toContain('脳科学');
  });

  it('passes bounded history and the latest state prompt to the LLM', async () => {
    let tick = 0;
    const model = new RecordingChatModel();
    const api = createLocalApiKernel(
      () => `2026-08-31T00:00:0${tick++}.000Z`,
      { chatModel: model },
    );
    await api.dispatch({ method: 'POST', path: '/v1/chat', body: { scopeKey: 'owner-a', message: '最初' } });
    await api.waitForBackground('owner-a');
    await api.dispatch({ method: 'POST', path: '/v1/chat', body: { scopeKey: 'owner-a', message: '次' } });
    expect(model.requests[0]?.history).toEqual([]);
    expect(model.requests[1]?.history).toEqual([
      { role: 'user', content: '最初' },
      { role: 'assistant', content: '返答1' },
    ]);
    expect(model.requests[1]?.systemPrompt).toContain('[Shannon shared state v1]');
  });

  it('updates emotion and recalled memories only behind the response lane', async () => {
    let tick = 0;
    const api = createLocalApiKernel(() => `2026-08-31T00:00:0${tick++}.000Z`);
    const first = await api.dispatch({
      method: 'POST', path: '/v1/chat', body: { scopeKey: 'owner-a', message: '創作を進められて嬉しい！' },
    });
    expect(first).toMatchObject({ body: { snapshotVersion: 0 } });
    const durableBeforeBackground = await api.dispatch({
      method: 'GET', path: '/v1/conversation', query: new URLSearchParams({ scopeKey: 'owner-a' }),
    });
    expect(durableBeforeBackground).toMatchObject({
      status: 200,
      body: { messages: [{ role: 'user' }, { role: 'assistant' }], state: { version: 0 } },
    });
    await api.waitForBackground('owner-a');

    const second = await api.dispatch({
      method: 'POST', path: '/v1/chat', body: { scopeKey: 'owner-a', message: '創作の続きを考えたい' },
    });
    expect(second).toMatchObject({ body: { snapshotVersion: 1 } });
    await api.waitForBackground('owner-a');
    const state = await api.dispatch({
      method: 'GET', path: '/v1/state', query: new URLSearchParams({ scopeKey: 'owner-a' }),
    });
    expect(state).toMatchObject({
      status: 200,
      body: {
        version: 4,
        interests: ['創作'],
        activeMemories: [{ summary: expect.stringContaining('創作を進められて嬉しい') }],
      },
    });
  });

  it('keeps scope state isolated', async () => {
    const api = createLocalApiKernel(() => '2026-08-31T00:00:00.000Z');
    await api.dispatch({ method: 'POST', path: '/v1/events', body: {
      scopeKey: 'owner-a', event: { type: 'emotion-adjusted', delta: { valence: 0.5 } },
    } });
    const a = await api.dispatch({
      method: 'GET', path: '/v1/state', query: new URLSearchParams({ scopeKey: 'owner-a' }),
    });
    const b = await api.dispatch({
      method: 'GET', path: '/v1/state', query: new URLSearchParams({ scopeKey: 'owner-b' }),
    });
    expect(a).toMatchObject({ status: 200, body: { version: 1, emotion: { valence: 0.5 } } });
    expect(b).toMatchObject({ status: 200, body: { version: 0, emotion: { valence: 0 } } });
  });

  it('rejects missing scope, malformed events, and long messages', async () => {
    const api = createLocalApiKernel(() => '2026-08-31T00:00:00.000Z');
    expect((await api.dispatch({ method: 'GET', path: '/v1/state' })).status).toBe(400);
    expect((await api.dispatch({ method: 'POST', path: '/v1/events', body: {
      scopeKey: 'a', event: { type: 'prediction' },
    } })).status).toBe(400);
    expect((await api.dispatch({ method: 'POST', path: '/v1/chat', body: {
      scopeKey: 'a', message: 'x'.repeat(8_001),
    } })).status).toBe(400);
  });
});
