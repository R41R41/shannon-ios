import { describe, expect, it } from 'vitest';
import { createLocalApiKernel } from '../src/apiKernel.js';
import type { ShannonChatModel, ShannonChatModelRequest, ShannonVoiceModelRequest } from '../src/chatModel.js';
import { InMemoryVoiceIdentityStore } from '../src/surfaces/voice/voiceIdentity.js';
import { InMemoryConversationStore } from '../src/mind/memory/store/conversationStore.js';
import { LocalVoiceDecisionGateway } from '../src/voiceDecision.js';
import type { WorldSubscription } from '../src/integrations/world/store/worldStore.js';
import { promptOf } from './modelPrompt.js';

class RecordingChatModel implements ShannonChatModel {
  readonly mode = 'openai' as const;
  readonly model = 'test-model';
  readonly requests: ShannonChatModelRequest[] = [];
  webSources: Array<{ title: string; url: string }> = [];
  replyOverride?: string;
  artifacts: Array<{ name: string; mimeType: string; content: string; summary?: string }> = [];
  places: Array<{ name: string; address: string; reason: string; mapQuery: string; mapUrl: string }> = [];
  taskProposal?: { title: string; goal: string; hostHint?: string; projectHint?: string; risk?: string };
  taskDecision?: { disposition: 'none' | 'clarify' | 'propose'; reason: string };

  async generate(request: ShannonChatModelRequest) {
    this.requests.push(request);
    return {
      mode: this.mode,
      model: this.model,
      reply: this.replyOverride ?? `返答${this.requests.length}`,
      ...(this.webSources.length ? { webSources: this.webSources } : {}),
      ...(this.artifacts.length ? { artifacts: this.artifacts } : {}),
      ...(this.places.length ? { places: this.places } : {}),
      ...(this.taskProposal ? { taskProposal: this.taskProposal } : {}),
      ...(this.taskDecision ? { taskDecision: this.taskDecision } : {}),
    };
  }
}

class VoiceAwareRecordingModel extends RecordingChatModel {
  readonly voiceRequests: ShannonVoiceModelRequest[] = [];

  async generateVoice(request: ShannonVoiceModelRequest) {
    this.voiceRequests.push(request);
    return { mode: this.mode, model: this.model, reply: `音声返答${this.voiceRequests.length}` };
  }
}

class StreamingVoiceRecordingModel extends VoiceAwareRecordingModel {
  readonly streamingVoiceRequests: ShannonVoiceModelRequest[] = [];

  async generateVoiceStreaming(
    request: ShannonVoiceModelRequest,
    onTextDelta: (delta: string) => void | Promise<void>,
  ) {
    this.streamingVoiceRequests.push(request);
    await onTextDelta('最初の文です。');
    await onTextDelta('次の文です。');
    return { mode: this.mode, model: this.model, reply: '最初の文です。次の文です。' };
  }
}

describe('Shannon local API kernel', () => {
  it('passes one-time place skill results into text synthesis with durable map links', async () => {
    const model = new RecordingChatModel();
    model.places = [{ name: '浜松城公園', address: '静岡県浜松市中央区元城町100-2',
      reason: '散歩できる', mapQuery: '浜松城公園 静岡県浜松市',
      mapUrl: 'https://maps.apple.com/?q=%E6%B5%9C%E6%9D%BE%E5%9F%8E%E5%85%AC%E5%9C%92' }];
    const api = createLocalApiKernel(() => '2026-09-22T01:38:00.000Z', { chatModel: model });
    const result = await api.dispatch({ method: 'POST', path: '/v1/chat', body: {
      scopeKey: 'owner-a', message: 'この近くの公園を地図で探して、今日の天気も教えて',
      placeLocation: { latitude: 34.7038, longitude: 137.7346, accuracyMeters: 24,
        observedAt: '2026-09-22T01:37:55.000Z' },
    } });
    expect(result).toMatchObject({ status: 200, body: {
      uiBlocks: [{ type: 'place_search', places: [expect.objectContaining({ name: '浜松城公園',
        mapUrl: expect.stringMatching(/^https:\/\/maps\.apple\.com\//) })] }],
    } });
    expect((result.body as { reply: string }).reply).toContain('https://maps.apple.com/');
    expect(model.requests[0]).toMatchObject({ useWebSearch: true,
      placeSearch: { latitude: 34.7038, longitude: 137.7346 } });
    expect(model.requests[0]?.history).toEqual([]);
    expect(model.requests[1]).toMatchObject({ useWebSearch: true,
      message: 'この近くの公園を地図で探して、今日の天気も教えて' });
    expect(model.requests[1]?.placeSearch).toBeUndefined();
    expect(promptOf(model.requests[1])).toContain('浜松城公園');
    expect(promptOf(model.requests[1])).toContain('Place discovery skill result');
  });

  it('passes place skill results into voice synthesis and keeps map links out of speech', async () => {
    const model = new VoiceAwareRecordingModel();
    model.replyOverride = '浜松城公園です。[地図](https://maps.apple.com/?q=hamamatsu) 今日の天気は晴れです。';
    model.places = [{ name: '浜松城公園', address: '静岡県浜松市', reason: '散歩できる',
      mapQuery: '浜松城公園 静岡県浜松市', mapUrl: 'https://maps.apple.com/?q=hamamatsu' }];
    const api = createLocalApiKernel(() => '2026-09-22T01:38:00.000Z', { chatModel: model });
    const result = await api.dispatch({ method: 'POST', path: '/v1/voice/live/delegations', body: {
      scopeKey: 'owner-a', transcript: '浜松の公園を地図で探して、今日の天気も教えて',
    } });
    expect(result).toMatchObject({ status: 200, body: { reply: '浜松城公園です。地図 今日の天気は晴れです。',
      uiBlocks: [{ type: 'place_search', places: [expect.objectContaining({ name: '浜松城公園' })] }] } });
    expect(model.requests[0]).toMatchObject({ useWebSearch: true, placeSearch: { spoken: true } });
    expect(promptOf(model.requests[1])).toContain('浜松城公園');
    expect(promptOf(model.requests[1])).toContain('Selected capabilities: current_web, place_discovery');
    expect(model.requests[1]?.placeSearch).toBeUndefined();
    expect(model.voiceRequests).toHaveLength(0);
  });
  it('uses the lightweight voice model without web tools for a direct conversation', async () => {
    const model = new VoiceAwareRecordingModel();
    const api = createLocalApiKernel(() => '2026-09-15T00:00:00.000Z', { chatModel: model });
    const result = await api.dispatch({
      method: 'POST', path: '/v1/voice/gemini/cascade/delegations', body: {
        scopeKey: 'owner-a', transcript: '今日はのんびり話そう',
      },
    });
    expect(result).toMatchObject({ status: 200, body: {
      reply: '音声返答1', voicePlan: { conversationClass: 'direct', selectedSkills: [] },
    } });
    expect(model.voiceRequests).toHaveLength(1);
    expect(model.voiceRequests[0]?.useWebSearch).toBe(false);
    expect(promptOf(model.voiceRequests[0])).toContain('short malformed fragment');
    expect(promptOf(model.voiceRequests[0])).toContain('Do not automatically append a question');
    expect(model.requests).toHaveLength(0);
  });

  it('streams ordinary voice deltas after routing without waiting for the completed reply', async () => {
    const model = new StreamingVoiceRecordingModel();
    const api = createLocalApiKernel(() => '2026-09-15T00:00:00.000Z', { chatModel: model });
    const plans: Array<Record<string, unknown>> = [];
    const deltas: string[] = [];

    const result = await api.streamLiveVoiceDelegation({
      method: 'POST', path: '/v1/voice/gemini/cascade/delegations', body: {
        scopeKey: 'owner-a', transcript: '聞こえる？',
      },
    }, {
      onPlan: plan => { plans.push(plan); },
      onTextDelta: delta => { deltas.push(delta); },
    });

    expect(result).toMatchObject({ status: 200, body: { reply: '最初の文です。次の文です。' } });
    expect(plans).toHaveLength(2);
    expect(plans[0]).toMatchObject({ shouldRespond: true, emotion: { target: 'ライ氏' } });
    // The reconciled plan follows; a plan goes to a device and carries the feeling without its cause.
    expect(plans[1]).toMatchObject({ shouldRespond: true, emotion: { target: 'ライ氏' } });
    expect(plans[1]).not.toHaveProperty('emotion.cause');
    expect(deltas).toEqual(['最初の文です。', '次の文です。']);
    expect(model.streamingVoiceRequests).toHaveLength(1);
    expect(promptOf(model.streamingVoiceRequests[0])).toContain('Current expressive emotion');
    expect(model.voiceRequests).toHaveLength(0);
    expect(result.body).not.toHaveProperty('truncated');
  });

  it('marks a voice reply that reached its length limit in the response', async () => {
    const model = new StreamingVoiceRecordingModel();
    model.generateVoiceStreaming = async (request, onTextDelta) => {
      model.streamingVoiceRequests.push(request);
      await onTextDelta('長いお話です。続きは');
      return { mode: model.mode, model: model.model, reply: '長いお話です。', truncated: true };
    };
    const api = createLocalApiKernel(() => '2026-10-05T00:00:00.000Z', { chatModel: model });
    const result = await api.streamLiveVoiceDelegation({
      method: 'POST', path: '/v1/voice/gemini/cascade/delegations', body: {
        scopeKey: 'owner-a', transcript: '一分以上のセリフを言って',
      },
    }, { onPlan: () => {}, onTextDelta: () => {} });
    expect(result).toMatchObject({ status: 200, body: { reply: '長いお話です。', truncated: true } });
  });

  it('returns one stable visible task proposal for an implementation request and its additions', async () => {
    const model = new RecordingChatModel();
    model.taskProposal = { title: 'Minebot音声対応', goal: 'Minebotへ音声会話を実装する', projectHint: 'minebot' };
    model.taskDecision = { disposition: 'propose', reason: '明示的な実装依頼' };
    const api = createLocalApiKernel(() => '2026-09-28T12:00:00.000Z', { chatModel: model });
    const first = await api.dispatch({ method: 'POST', path: '/v1/voice/gemini/cascade/delegations', body: {
      scopeKey: 'owner-a', threadId: 'thread-work', transcript: 'これをMinebotにも実装して',
    } });
    const addition = await api.dispatch({ method: 'POST', path: '/v1/voice/gemini/cascade/delegations', body: {
      scopeKey: 'owner-a', threadId: 'thread-work', transcript: 'あと、Voyagerのタスクも完了にして',
    } });
    const firstBlock = (first.body as { uiBlocks: Array<{ proposalId: string }> }).uiBlocks[0]!;
    const additionBlock = (addition.body as { uiBlocks: Array<{ proposalId: string }> }).uiBlocks[0]!;
    expect(firstBlock.proposalId).toBeTruthy();
    expect(additionBlock.proposalId).toBe(firstBlock.proposalId);
    expect(promptOf(model.requests[1])).toContain('addedRequirements=あと、Voyagerのタスクも完了にして');
    expect(model.requests).toHaveLength(2);
  });

  it('never reuses a started task identity for a later proposal in the same thread', async () => {
    const model = new RecordingChatModel();
    model.taskProposal = { title: 'ログイン修正', goal: 'ログイン画面を修正する', projectHint: 'shannon-ios' };
    model.taskDecision = { disposition: 'propose', reason: '明示的な実装依頼' };
    const api = createLocalApiKernel(() => '2026-09-28T12:00:00.000Z', { chatModel: model });
    const first = await api.dispatch({ method: 'POST', path: '/v1/chat', body: {
      scopeKey: 'owner-a', threadId: 'thread-work', message: 'ログイン画面を修正して',
    } });
    const firstBlock = (first.body as { uiBlocks: Array<{ proposalId: string }> }).uiBlocks[0]!;
    const start = await api.dispatch({ method: 'POST', path: '/v1/agent/tasks', body: {
      scopeKey: 'owner-a', taskId: firstBlock.proposalId, idempotencyKey: 'start-first',
      conversationThreadID: 'thread-work', title: 'ログイン修正', goal: 'ログイン画面を修正する', summary: '修正する',
    } });
    expect(start.status).toBeLessThan(300);

    model.taskProposal = { title: '別のバグ修正', goal: '別のバグを直す', projectHint: 'shannon-ios' };
    const second = await api.dispatch({ method: 'POST', path: '/v1/chat', body: {
      scopeKey: 'owner-a', threadId: 'thread-work', message: 'このバグも直せる？お願い',
    } });
    const secondBlock = (second.body as { uiBlocks: Array<{ proposalId: string; title: string }> }).uiBlocks[0]!;
    expect(secondBlock.title).toBe('別のバグ修正');
    expect(secondBlock.proposalId).toBeTruthy();
    expect(secondBlock.proposalId).not.toBe(firstBlock.proposalId);
  });

  it('routes a colloquial voice capability request to a visible implementation proposal', async () => {
    const model = new VoiceAwareRecordingModel();
    model.taskProposal = { title: 'センサー機能', goal: 'シャノンにセンサー機能を追加する',
      projectHint: 'shannon-ios' };
    const api = createLocalApiKernel(() => '2026-09-28T12:00:00.000Z', { chatModel: model });
    const result = await api.dispatch({ method: 'POST', path: '/v1/voice/gemini/cascade/delegations',
      body: { scopeKey: 'owner-a', threadId: 'thread-work',
        transcript: 'センサーを使う機能を、あの、作ってくれない？シャノンに。' } });
    expect(result).toMatchObject({ status: 200,
      body: { uiBlocks: [{ type: 'agent_task_proposal', projectHint: 'shannon-ios' }] } });
    expect(model.requests).toHaveLength(1);
    expect(model.voiceRequests).toHaveLength(0);
  });

  it('shows a proposal after a reliable confirmation of the immediately preceding voice clarification', async () => {
    const model = new VoiceAwareRecordingModel();
    const conversationStore = new InMemoryConversationStore();
    conversationStore.appendTurn('owner-a', 'thread-work',
      '現在時刻と現在地を取得するスキルを作ってほしい。',
      '現在時刻と現在地を取得するスキルの実装提案を出して進めてよいですか？',
      '2026-09-28T11:59:00.000Z');
    const gateway = new LocalVoiceDecisionGateway();
    const api = createLocalApiKernel(() => '2026-09-28T12:00:00.000Z', {
      chatModel: model, conversationStore,
      voiceDecision: { mode: 'jev', model: 'test', decide: async input => ({
        ...await gateway.decide(input), transcriptReliabilityProbability: 0.96,
      }) },
    });
    const result = await api.dispatch({ method: 'POST', path: '/v1/voice/gemini/cascade/delegations',
      body: { scopeKey: 'owner-a', threadId: 'thread-work', transcript: 'はい、進めて良いです。',
        deviceContext: { timeZoneIdentifier: 'Asia/Tokyo', requestedLocation: false,
          userUtterance: { id: 'u1', text: 'はい、進めて良いです。',
          rawText: 'はい、進めて良いです。', source: 'speech' } } } });
    expect(result).toMatchObject({ status: 200, body: {
      uiBlocks: [{ type: 'agent_task_proposal', goal: '現在時刻と現在地を取得するスキルを作ってほしい。' }],
      reply: expect.stringContaining('画面に出しました'),
    } });
    expect(model.requests).toHaveLength(1);
    expect(model.voiceRequests).toHaveLength(0);
    expect(promptOf(model.requests[0])).toContain('[Confirmed implementation clarification]');
  });

  it('shows a proposal for a confirmed skill improvement even when the assistant calls it a development task', async () => {
    const model = new VoiceAwareRecordingModel();
    const conversationStore = new InMemoryConversationStore();
    const request = 'シャノンの位置情報取得スキルをもっと高精度にしたい。「今東小金井駅のスターバックスにいますね」くらいの精度。';
    conversationStore.appendTurn('owner-a', 'thread-work', request,
      '開発タスクとして提案を出せますが、まず「現在地から駅・店舗名まで特定する機能を追加」で進めてよいですか？',
      '2026-09-28T11:59:00.000Z');
    const gateway = new LocalVoiceDecisionGateway();
    const api = createLocalApiKernel(() => '2026-09-28T12:00:00.000Z', {
      chatModel: model, conversationStore,
      voiceDecision: { mode: 'jev', model: 'test', decide: async input => ({
        ...await gateway.decide(input), transcriptReliabilityProbability: 0.96,
      }) },
    });
    const result = await api.dispatch({ method: 'POST', path: '/v1/voice/gemini/cascade/delegations',
      body: { scopeKey: 'owner-a', threadId: 'thread-work', transcript: '良いです。お願いします。',
        deviceContext: { timeZoneIdentifier: 'Asia/Tokyo', requestedLocation: false,
          userUtterance: { id: 'u1', text: '良いです。お願いします。',
            rawText: '良いです。お願いします。', source: 'speech' } } } });
    expect(result).toMatchObject({ status: 200, body: {
      uiBlocks: [{ type: 'agent_task_proposal', goal: request }],
      reply: expect.stringContaining('画面に出しました'),
    } });
  });

  it('does not promote an uncertain acknowledgement or a different prior question into an implementation proposal', async () => {
    for (const [priorReply, score, observedAt] of [
      ['現在時刻と現在地を取得するスキルの実装提案を出して進めてよいですか？', 0.4, '2026-09-28T11:59:00.000Z'],
      ['現在地はわかりますか？', 0.96, '2026-09-28T11:59:00.000Z'],
      ['現在時刻と現在地を取得するスキルの実装提案を出して進めてよいですか？', 0.96, '2026-09-28T11:00:00.000Z'],
    ] as const) {
      const model = new VoiceAwareRecordingModel();
      const conversationStore = new InMemoryConversationStore();
      conversationStore.appendTurn('owner-a', 'thread-work',
        '現在時刻と現在地を取得するスキルを作ってほしい。', priorReply,
        observedAt);
      const gateway = new LocalVoiceDecisionGateway();
      const api = createLocalApiKernel(() => '2026-09-28T12:00:00.000Z', {
        chatModel: model, conversationStore,
        voiceDecision: { mode: 'jev', model: 'test', decide: async input => ({
          ...await gateway.decide(input), transcriptReliabilityProbability: score,
        }) },
      });
      const result = await api.dispatch({ method: 'POST', path: '/v1/voice/gemini/cascade/delegations',
        body: { scopeKey: 'owner-a', threadId: 'thread-work', transcript: 'はい、進めて良いです。',
          deviceContext: { timeZoneIdentifier: 'Asia/Tokyo', requestedLocation: false,
            userUtterance: { id: 'u1', text: 'はい、進めて良いです。',
            rawText: 'はい、進めて良いです。', source: 'speech' } } } });
      expect(result.body).not.toHaveProperty('uiBlocks');
      expect(model.requests).toHaveLength(0);
      expect(model.voiceRequests).toHaveLength(1);
    }
  });

  it('skips the reply model when the voice decision says no response is needed', async () => {
    const model = new VoiceAwareRecordingModel();
    const api = createLocalApiKernel(() => '2026-09-15T00:00:00.000Z', {
      chatModel: model,
      voiceDecision: { mode: 'jev', model: 'test-jev', decide: async () => ({
        source: 'jev', shouldRespond: false, replyRequiredProbability: 0.08,
        solutionWantedProbability: 0.1, conversationClass: 'no_response', latencyClass: 'under_1s',
        affect: 'neutral', affectIntensity: 0.2, delivery: 'conversational',
        selectedSkills: [], skillScores: {
          current_web: 0, place_discovery: 0, conversation_memory: 0, daily_mind: 0, aether_notes: 0,
          voyager_tasks: 0, agent_status: 0, device_context: 0,
        }, elapsedMilliseconds: 72,
      }) },
    });
    const result = await api.dispatch({
      method: 'POST', path: '/v1/voice/gemini/cascade/delegations', body: {
        scopeKey: 'owner-a', transcript: 'うん',
      },
    });
    expect(result).toMatchObject({ status: 200, body: {
      reply: '', voicePlan: { shouldRespond: false, conversationClass: 'no_response' },
    } });
    expect(model.voiceRequests).toHaveLength(0);
    expect(model.requests).toHaveLength(0);
  });

  it('routes a GPT-Live client delegation through the read-only web backend', async () => {
    const model = new RecordingChatModel();
    model.webSources = [{ title: 'Weather source', url: 'https://example.com/weather' }];
    const api = createLocalApiKernel(
      () => '2026-09-15T00:00:00.000Z',
      { chatModel: model },
    );

    const result = await api.dispatch({
      method: 'POST', path: '/v1/voice/live/delegations', body: {
        scopeKey: 'owner-a',
        threadId: 'thread-travel',
        transcript: '浜松の今日の天気を調べて',
      },
    });

    expect(result).toMatchObject({
      status: 200,
      body: {
        threadId: 'thread-travel',
        model: 'test-model',
        reply: '返答1',
        webSources: [{ title: 'Weather source', url: 'https://example.com/weather' }],
        voicePlan: {
          shouldRespond: true,
          conversationClass: 'skill_simple',
          selectedSkills: ['current_web'],
          waitingPhrase: 'いまの天気を確認しますね。',
        },
      },
    });
    expect(model.requests).toHaveLength(1);
    expect(model.requests[0]).toMatchObject({
      scopeKey: 'owner-a',
      message: '浜松の今日の天気を調べて',
      useWebSearch: true,
      generateThreadTitle: false,
    });
    expect(promptOf(model.requests[0])).toContain('This lane is read-only');
    expect(promptOf(model.requests[0])).toContain('2026年9月15日');
  });

  it('passes fresh one-time device location and local clock to travel search without writing state', async () => {
    const model = new RecordingChatModel();
    const api = createLocalApiKernel(
      () => '2026-09-22T01:38:00.000Z',
      { chatModel: model },
    );
    const result = await api.dispatch({
      method: 'POST', path: '/v1/voice/live/delegations', body: {
        scopeKey: 'owner-a',
        transcript: 'ここから浜松城までバスでどう行く？',
        deviceContext: {
          timeZoneIdentifier: 'Asia/Tokyo',
          requestedLocation: true,
          location: {
            latitude: 34.7038,
            longitude: 137.7346,
            accuracyMeters: 24,
            observedAt: '2026-09-22T01:37:55.000Z',
          },
        },
      },
    });
    expect(result.status).toBe(200);
    expect(model.requests[0]?.message).toBe('ここから浜松城までバスでどう行く？');
    expect(promptOf(model.requests[0])).toContain('2026年9月22日');
    expect(promptOf(model.requests[0])).toContain('10:38');
    expect(promptOf(model.requests[0])).toContain('34.7038');
    expect(promptOf(model.requests[0])).toContain('137.7346');
    expect(promptOf(model.requests[0])).toContain('Give no exact departure');
    expect(model.requests[0]?.useWebSearch).toBe(true);
  });

  it('asks for a landmark when device location is unavailable and rejects stale or invalid coordinates', async () => {
    const model = new RecordingChatModel();
    const api = createLocalApiKernel(
      () => '2026-09-22T01:38:00.000Z',
      { chatModel: model },
    );
    const unavailable = await api.dispatch({
      method: 'POST', path: '/v1/voice/live/delegations', body: {
        scopeKey: 'owner-a',
        transcript: '現在地からの行き方を調べて',
        deviceContext: { timeZoneIdentifier: 'Asia/Tokyo', requestedLocation: true },
      },
    });
    expect(unavailable.status).toBe(200);
    expect(promptOf(model.requests[0])).toContain('could not provide a current location');

    const invalid = await api.dispatch({
      method: 'POST', path: '/v1/voice/live/delegations', body: {
        scopeKey: 'owner-a',
        transcript: 'ここからの電車を調べて',
        deviceContext: {
          timeZoneIdentifier: 'Asia/Tokyo',
          requestedLocation: true,
          location: {
            latitude: 34.7038, longitude: 137.7346, accuracyMeters: 24,
            observedAt: '2026-09-22T00:00:00.000Z',
          },
        },
      },
    });
    expect(invalid.status).toBe(400);
    expect(model.requests).toHaveLength(1);
  });

  it('rejects an empty GPT-Live client delegation before calling the model', async () => {
    const model = new RecordingChatModel();
    const api = createLocalApiKernel(() => '2026-09-15T00:00:00.000Z', { chatModel: model });

    await expect(api.dispatch({
      method: 'POST', path: '/v1/voice/live/delegations', body: {
        scopeKey: 'owner-a', transcript: '   ',
      },
    })).resolves.toMatchObject({ status: 400 });
    expect(model.requests).toHaveLength(0);
  });

  it('keeps temporary guest voice sessions outside owner context and history', async () => {
    const model = new RecordingChatModel();
    const api = createLocalApiKernel(
      () => '2026-09-18T00:00:00.000Z',
      { chatModel: model },
    );
    const privateTurn = await api.dispatch({
      method: 'POST', path: '/v1/chat', body: {
        scopeKey: 'owner-a', message: '秘密の合言葉はミズクラゲ',
      },
    });
    const privateThreadId = String((privateTurn.body as { threadId: string }).threadId);
    model.requests.length = 0;

    const session = api.realtimeVoiceSession('owner-a', undefined, { participantMode: 'guest' });
    expect(session.threadId).toBe('temporary-guest-session');
    expect(session.instructions).toContain('[Introduction mode — 友人も一緒]');
    expect(session.instructions).toContain('do not assume the current speaker is ライ氏');
    expect(session.instructions).not.toContain('conversation partner is ライ');
    expect(session.instructions).not.toContain('「ライ氏」と呼び、');
    expect(session.instructions).toContain('相手を「ライ氏」と呼ばない');
    expect(session.instructions).not.toContain('[Shannon shared state v1]');
    expect(session.instructions).not.toContain('ミズクラゲ');

    const delegated = await api.dispatch({
      method: 'POST', path: '/v1/voice/live/delegations', body: {
        scopeKey: 'owner-a', threadId: privateThreadId,
        transcript: '今日の天気を調べて', participantMode: 'guest',
      },
    });
    expect(delegated).toMatchObject({ status: 200, body: { threadId: privateThreadId } });
    expect(model.requests).toHaveLength(1);
    expect(model.requests[0]?.history).toEqual([]);
    expect(promptOf(model.requests[0])).toContain('[Introduction mode — 友人も一緒]');
    expect(promptOf(model.requests[0])).not.toContain('ミズクラゲ');
  });

  it('rejects an unknown live voice participant mode', async () => {
    const model = new RecordingChatModel();
    const api = createLocalApiKernel(() => '2026-09-18T00:00:00.000Z', { chatModel: model });
    await expect(api.dispatch({
      method: 'POST', path: '/v1/voice/live/delegations', body: {
        scopeKey: 'owner-a', transcript: '天気を調べて', participantMode: 'crowd',
      },
    })).resolves.toMatchObject({ status: 400 });
    expect(model.requests).toHaveLength(0);
  });

  it('shares a bounded voice choice and applies it when a new realtime session starts', async () => {
    const voiceIdentity = new InMemoryVoiceIdentityStore('marin');
    const api = createLocalApiKernel(
      () => '2026-09-11T01:10:00.000Z',
      { voiceIdentity },
    );

    expect(await api.dispatch({
      method: 'GET', path: '/v1/voice/identity', query: new URLSearchParams({ scopeKey: 'owner-a' }),
    })).toMatchObject({
      status: 200,
      body: {
        preference: { mode: 'automatic', selectedVoice: null, effectiveVoice: 'marin', updatedAt: null },
        candidates: [{ id: 'marin' }, { id: 'cedar' }, { id: 'coral' }],
      },
    });

    expect(await api.dispatch({
      method: 'POST', path: '/v1/voice/identity', body: {
        scopeKey: 'owner-a', mode: 'manual', selectedVoice: 'cedar',
      },
    })).toMatchObject({
      status: 200,
      body: { preference: { mode: 'manual', selectedVoice: 'cedar', effectiveVoice: 'cedar' } },
    });
    expect(api.realtimeVoiceSession('owner-a').voice).toBe('cedar');
    expect(api.realtimeVoiceSession('owner-b').voice).toBe('marin');

    expect(await api.dispatch({
      method: 'POST', path: '/v1/voice/identity', body: {
        scopeKey: 'owner-a', mode: 'automatic', selectedVoice: null,
      },
    })).toMatchObject({
      status: 200,
      body: { preference: { mode: 'automatic', selectedVoice: null, effectiveVoice: 'marin' } },
    });
    expect(api.realtimeVoiceSession('owner-a').voice).toBe('marin');
  });

  it('rejects unsupported or incomplete voice identity choices without changing the saved choice', async () => {
    const voiceIdentity = new InMemoryVoiceIdentityStore();
    const api = createLocalApiKernel(() => '2026-09-11T01:10:00.000Z', { voiceIdentity });

    for (const body of [
      { scopeKey: 'owner-a', mode: 'manual' },
      { scopeKey: 'owner-a', mode: 'manual', selectedVoice: 'unknown' },
      { scopeKey: 'owner-a', mode: 'automatic', selectedVoice: 'cedar' },
    ]) {
      await expect(api.dispatch({ method: 'POST', path: '/v1/voice/identity', body }))
        .resolves.toMatchObject({ status: 400 });
    }
    expect(voiceIdentity.read('owner-a')).toMatchObject({ mode: 'automatic', effectiveVoice: 'marin' });
  });

  it('reports the configured LLM in health', async () => {
    const api = createLocalApiKernel(() => '2026-08-31T00:00:00.000Z');
    expect(await api.dispatch({ method: 'GET', path: '/health' })).toEqual({
      status: 200,
      body: {
        ok: true,
        service: 'shannon-ios-api',
        mode: 'local',
        llm: { mode: 'local-stub', model: 'local-stub' },
        voiceRouting: { mode: 'fallback', model: 'local-rules' },
        background: { mode: 'in-process' },
      },
    });
  });

  it('returns the authenticated TestFlight delivery projection', async () => {
    const dashboard = {
      condition: 'healthy' as const,
      latestBuildVersion: '17',
      lastCheckedAt: '2026-09-05T04:00:00.000Z',
      activeFailureCode: null,
      history: [],
      release: { platform: 'ios' as const, buildVersion: '17', gates: [] },
    };
    const api = createLocalApiKernel(
      () => '2026-09-05T04:00:00.000Z',
      { testFlightDelivery: { dashboard: () => dashboard } },
    );
    expect(await api.dispatch({
      method: 'GET', path: '/v1/testflight/delivery', query: new URLSearchParams({ scopeKey: 'owner-a' }),
    })).toEqual({ status: 200, body: dashboard });
    expect(await api.dispatch({ method: 'GET', path: '/v1/testflight/delivery' }))
      .toMatchObject({ status: 400 });
  });

  it('lists world subscription proposals and requires a fresh explicit decision', async () => {
    let subscription: WorldSubscription = {
      id: 'feed-1', feedURL: 'https://example.com/feed', title: 'Example',
      status: 'paused', approval: 'pending', reason: '見つけた',
      discoveredAt: '2026-09-11T00:00:00.000Z', trialExpiresAt: '2026-09-18T00:00:00.000Z',
      fetchedItemCount: 0, updatedAt: '2026-09-11T00:00:00.000Z',
    };
    const api = createLocalApiKernel(
      () => '2026-09-11T01:00:00.000Z',
      {
        worldSubscriptions: {
          sources: () => [{
            id: 'hn:top', kind: 'hacker-news', title: 'Hacker News',
            url: 'https://news.ycombinator.com/', enabled: true, intervalMinutes: 360,
            nextRunAt: '2026-09-11T06:00:00.000Z', hasError: false,
            fetchedItemCount: 12, origin: 'built-in',
          }],
          subscriptions: () => [subscription],
          decideSubscription: (id, decision, expectedUpdatedAt, decidedAt) => {
            expect(id).toBe('feed-1');
            expect(decision).toBe('approve');
            expect(expectedUpdatedAt).toBe(subscription.updatedAt);
            subscription = {
              ...subscription, status: 'trial', approval: 'approved',
              updatedAt: decidedAt ?? subscription.updatedAt,
            };
            return subscription;
          },
        },
      },
    );

    expect(await api.dispatch({
      method: 'GET', path: '/v1/world/subscriptions',
      query: new URLSearchParams({ scopeKey: 'owner-a' }),
    })).toMatchObject({ status: 200, body: { subscriptions: [{ approval: 'pending' }] } });
    expect(await api.dispatch({
      method: 'GET', path: '/v1/world/sources',
      query: new URLSearchParams({ scopeKey: 'owner-a' }),
    })).toMatchObject({
      status: 200,
      body: { sources: [{ title: 'Hacker News', enabled: true, fetchedItemCount: 12 }] },
    });
    expect(await api.dispatch({
      method: 'POST', path: '/v1/world/subscriptions/feed-1/decision', body: {
        scopeKey: 'owner-a', decision: 'approve', expectedUpdatedAt: subscription.updatedAt,
      },
    })).toMatchObject({ status: 200, body: { status: 'trial', approval: 'approved' } });
    expect(await api.dispatch({
      method: 'POST', path: '/v1/world/subscriptions/feed-1/decision', body: {
        scopeKey: 'owner-a', decision: 'later', expectedUpdatedAt: subscription.updatedAt,
      },
    })).toMatchObject({ status: 400 });
  });

  it('captures one immutable state version for a chat turn', async () => {
    let tick = 0;
    const api = createLocalApiKernel(() => `2026-08-31T00:00:${String(tick++).padStart(2, '0')}.000Z`);
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
    expect(second).toMatchObject({ status: 200, body: { mode: 'local-stub', snapshotVersion: 3 } });
    expect(JSON.stringify(first.body)).not.toContain('脳科学');
    expect(JSON.stringify(second.body)).toContain('脳科学');
  });

  it('passes bounded history and the latest state prompt to the LLM', async () => {
    let tick = 0;
    const model = new RecordingChatModel();
    const api = createLocalApiKernel(
      () => `2026-08-31T00:00:${String(tick++).padStart(2, '0')}.000Z`,
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
    expect(promptOf(model.requests[1])).toContain('[Shannon shared state v2]');
  });

  it('recalls a related past turn before generating the current response', async () => {
    const model = new RecordingChatModel();
    const api = createLocalApiKernel(
      () => '2026-09-24T03:00:00.000Z',
      { chatModel: model },
    );
    await api.dispatch({ method: 'POST', path: '/v1/chat', body: {
      scopeKey: 'owner-a', message: '浜松で雨の日にうなぎ屋を探したね',
    } });

    await api.dispatch({ method: 'POST', path: '/v1/chat', body: {
      scopeKey: 'owner-a', message: '浜松の雨の日の続き、覚えてる？',
    } });

    expect(promptOf(model.requests[1])).toContain('[Current cognitive context — use before answering]');
    expect(promptOf(model.requests[1])).toContain('浜松で雨の日にうなぎ屋を探したね');
    expect(promptOf(model.requests[1])).toContain('cue: words');
  });

  it('captures explicit future intent and projects it into later turns', async () => {
    const model = new RecordingChatModel();
    const api = createLocalApiKernel(
      () => '2026-09-24T03:00:00.000Z',
      { chatModel: model },
    );
    await api.dispatch({ method: 'POST', path: '/v1/chat', body: {
      scopeKey: 'owner-a', message: '明日、旅行の写真を一緒に整理しよう',
    } });
    await api.waitForBackground('owner-a');
    const state = await api.dispatch({
      method: 'GET', path: '/v1/state', query: new URLSearchParams({ scopeKey: 'owner-a' }),
    });
    expect(state).toMatchObject({ status: 200, body: {
      prospectiveMemories: [{
        summary: '明日、旅行の写真を一緒に整理しよう', status: 'pending', dueHint: '明日',
      }],
    } });

    await api.dispatch({ method: 'POST', path: '/v1/chat', body: {
      scopeKey: 'owner-a', message: '次は何をしようか',
    } });
    expect(promptOf(model.requests[1])).toContain('未完了の約束・未来記憶');
    expect(promptOf(model.requests[1])).toContain('旅行の写真を一緒に整理');
  });

  it('suppresses a duplicate agent-work card for an explicit Voyager update request', async () => {
    const model = new RecordingChatModel();
    model.taskDecision = { disposition: 'propose', reason: '更新依頼を作業として誤認' };
    model.taskProposal = {
      title: 'Voyager タスクの詳細とプロジェクトを更新',
      goal: 'Voyager上のタスクを更新する',
      projectHint: 'shannon-ios',
    };
    const api = createLocalApiKernel(
      () => '2026-09-10T00:00:00.000Z',
      { chatModel: model },
    );

    const response = await api.dispatch({
      method: 'POST', path: '/v1/chat', body: {
        scopeKey: 'owner-a',
        message: 'Voyagerにある「シャノンとVoyagerの実機連携を確認する」の詳細を「Shannon Phase 2の実機確認に成功」に更新して、合うProjectを選びたい。',
      },
    });

    expect(response).toMatchObject({ status: 200, body: { reply: '返答1' } });
    expect((response.body as { uiBlocks?: unknown }).uiBlocks).toBeUndefined();
    expect(model.requests).toHaveLength(1);
  });

  it('keeps agent-work cards for ordinary Shannon implementation requests', async () => {
    const model = new RecordingChatModel();
    model.taskDecision = { disposition: 'propose', reason: 'Shannonの明示的な実装依頼' };
    model.taskProposal = {
      title: '入力欄を改善',
      goal: 'Shannonの入力欄を使いやすくする',
      projectHint: 'shannon-ios',
    };
    const api = createLocalApiKernel(
      () => '2026-09-10T00:00:00.000Z',
      { chatModel: model },
    );

    const response = await api.dispatch({
      method: 'POST', path: '/v1/chat', body: {
        scopeKey: 'owner-a', message: 'Shannonの入力欄を改善して',
      },
    });

    expect(response).toMatchObject({
      status: 200,
      body: { uiBlocks: [{ type: 'agent_task_proposal', title: '入力欄を改善' }] },
    });
  });

  it('returns generated artifacts and restores them with conversation history', async () => {
    const model = new RecordingChatModel();
    model.artifacts = [{
      name: 'plan.md', mimeType: 'text/markdown', content: '# Plan\n', summary: '実装計画',
    }];
    const api = createLocalApiKernel(
      () => '2026-09-08T00:00:00.000Z',
      { chatModel: model },
    );

    const response = await api.dispatch({
      method: 'POST', path: '/v1/chat', body: { scopeKey: 'owner-a', message: 'Markdownにして' },
    });
    const threadId = (response.body as { threadId: string }).threadId;
    const history = await api.dispatch({
      method: 'GET', path: '/v1/conversation',
      query: new URLSearchParams({ scopeKey: 'owner-a', threadId }),
    });

    expect(response).toMatchObject({ status: 200, body: { artifacts: model.artifacts } });
    expect(history).toMatchObject({
      status: 200,
      body: { messages: [
        { role: 'user' },
        { role: 'assistant', artifacts: model.artifacts },
      ] },
    });
  });

  it('passes text attachments as separate untrusted reference material without persisting their contents', async () => {
    const model = new RecordingChatModel();
    const api = createLocalApiKernel(
      () => '2026-09-07T03:00:00.000Z',
      { chatModel: model },
    );
    const response = await api.dispatch({
      method: 'POST', path: '/v1/chat', body: {
        scopeKey: 'owner-a',
        message: 'この資料を要約して。\n\n📎 notes.md',
        attachments: [{ name: 'notes.md', mimeType: 'text/markdown', text: '非公開の本文TOKEN-123' }],
      },
    });

    expect(response.status).toBe(200);
    expect(model.requests[0]?.attachments).toEqual([
      { name: 'notes.md', mimeType: 'text/markdown', text: '非公開の本文TOKEN-123' },
    ]);
    expect(model.requests[0]?.message).toContain('📎 notes.md');

    const history = await api.dispatch({
      method: 'GET', path: '/v1/conversation', query: new URLSearchParams({ scopeKey: 'owner-a' }),
    });
    expect(JSON.stringify(history.body)).toContain('📎 notes.md');
    expect(JSON.stringify(history.body)).not.toContain('TOKEN-123');
  });

  it('rejects binary-like, unsupported, or oversized chat attachments before calling the model', async () => {
    const model = new RecordingChatModel();
    const api = createLocalApiKernel(() => '2026-09-07T03:00:00.000Z', { chatModel: model });

    const invalid = await api.dispatch({
      method: 'POST', path: '/v1/chat', body: {
        scopeKey: 'owner-a', message: '見て',
        attachments: [{ name: 'payload.bin', mimeType: 'application/octet-stream', text: 'x\0y' }],
      },
    });
    const oversized = await api.dispatch({
      method: 'POST', path: '/v1/chat', body: {
        scopeKey: 'owner-a', message: '見て',
        attachments: [{ name: 'large.txt', mimeType: 'text/plain', text: 'x'.repeat(24_001) }],
      },
    });

    expect(invalid).toMatchObject({ status: 400, body: { error: 'BAD_REQUEST' } });
    expect(oversized).toMatchObject({ status: 400, body: { error: 'BAD_REQUEST' } });
    expect(model.requests).toEqual([]);
  });

  it('enables web search explicitly and persists a Markdown source section', async () => {
    const model = new RecordingChatModel();
    model.webSources = [{ title: 'OpenAI公式', url: 'https://openai.com/news/' }];
    const api = createLocalApiKernel(() => '2026-09-08T00:00:00.000Z', { chatModel: model });

    const response = await api.dispatch({
      method: 'POST', path: '/v1/chat', body: {
        scopeKey: 'owner-a', message: '最新情報を調べて', webSearch: true,
      },
    });

    expect(model.requests[0]?.useWebSearch).toBe(true);
    expect(response).toMatchObject({ status: 200, body: {
      reply: expect.stringContaining('### 参照した情報源\n- [OpenAI公式](https://openai.com/news/)'),
    } });
    const history = await api.dispatch({
      method: 'GET', path: '/v1/conversation', query: new URLSearchParams({ scopeKey: 'owner-a' }),
    });
    expect(JSON.stringify(history.body)).toContain('https://openai.com/news/');
  });

  it('rejects non-boolean web search flags before calling the model', async () => {
    const model = new RecordingChatModel();
    const api = createLocalApiKernel(() => '2026-09-08T00:00:00.000Z', { chatModel: model });

    const response = await api.dispatch({
      method: 'POST', path: '/v1/chat', body: {
        scopeKey: 'owner-a', message: '調べて', webSearch: 'yes',
      },
    });

    expect(response).toMatchObject({ status: 400, body: { error: 'BAD_REQUEST' } });
    expect(model.requests).toEqual([]);
  });

  it('renames a thread and exposes the saved title in the thread list', async () => {
    const api = createLocalApiKernel(() => '2026-09-04T00:00:00.000Z');
    const created = await api.dispatch({ method: 'POST', path: '/v1/threads', body: {
      scopeKey: 'owner-a', title: '仮のタイトル',
    } });
    const threadId = String((created.body as { threadId: string }).threadId);

    expect(await api.dispatch({ method: 'POST', path: '/v1/threads/title', body: {
      scopeKey: 'owner-a', threadId, title: '保存したタイトル',
    } })).toEqual({ status: 200, body: { renamed: true } });
    expect(await api.dispatch({ method: 'GET', path: '/v1/threads', query: new URLSearchParams({ scopeKey: 'owner-a' }) }))
      .toMatchObject({ status: 200, body: { threads: [expect.objectContaining({ threadId, title: '保存したタイトル' })] } });
    expect(await api.dispatch({ method: 'POST', path: '/v1/threads/title', body: {
      scopeKey: 'owner-a', threadId, title: '   ',
    } })).toMatchObject({ status: 400 });
  });

  it('adds only the relevant Aether projection without another model call', async () => {
    const model = new RecordingChatModel();
    const api = createLocalApiKernel(
      () => '2026-09-03T00:00:00.000Z',
      {
        chatModel: model,
        aetherContext: {
          promptFor(scopeKey, message) {
            expect(scopeKey).toBe('owner-a');
            expect(message).toBe('設計の続きを話したい');
            return '[Aetherから明示的に共有された文脈]\n- 設計メモ';
          },
        },
      },
    );
    await api.dispatch({ method: 'POST', path: '/v1/chat', body: { scopeKey: 'owner-a', message: '設計の続きを話したい' } });
    expect(model.requests).toHaveLength(1);
    expect(promptOf(model.requests[0])).toContain('設計メモ');
  });

  it('lets today\'s focus color the same chat prompt without treating it as a user fact', async () => {
    const model = new RecordingChatModel();
    const now = '2026-09-05T03:00:00.000Z';
    const api = createLocalApiKernel(() => now, {
      chatModel: model,
      dailyMind: {
        currentFocus: () => null,
        promptFor: (scopeKey, at) => {
          expect(scopeKey).toBe('owner-a');
          expect(at).toBe(now);
          return '[Today\'s Shannon focus]\n- topic: 記憶が育つ条件\n- This is not a fact about the user.';
        },
      },
    });

    await api.dispatch({ method: 'POST', path: '/v1/chat', body: { scopeKey: 'owner-a', message: 'おはよう' } });

    expect(model.requests).toHaveLength(1);
    expect(promptOf(model.requests[0])).toContain('topic: 記憶が育つ条件');
    expect(promptOf(model.requests[0])).toContain('not a fact about the user');
  });

  it('projects the authoritative agent task status across conversations', async () => {
    const model = new RecordingChatModel();
    const now = '2026-09-04T04:50:00.000Z';
    const api = createLocalApiKernel(() => now, { chatModel: model });
    const taskThread = await api.dispatch({ method: 'POST', path: '/v1/threads', body: {
      scopeKey: 'owner-a', title: '改修相談',
    } });
    const taskThreadId = String((taskThread.body as { threadId: string }).threadId);
    const questionThread = await api.dispatch({ method: 'POST', path: '/v1/threads', body: {
      scopeKey: 'owner-a', title: '別のトーク',
    } });
    const questionThreadId = String((questionThread.body as { threadId: string }).threadId);
    const created = await api.dispatch({ method: 'POST', path: '/v1/agent/tasks', body: {
      scopeKey: 'owner-a', idempotencyKey: 'task-status-test', conversationThreadID: taskThreadId,
      title: 'リンク表示を直す', goal: 'シャノン側のリンクをタップ可能にする', summary: '作業を始める',
    } });
    const taskId = String((created.body as { task: { id: string } }).task.id);
    await api.dispatch({ method: 'POST', path: '/v1/agent/host/heartbeat', body: {
      hostId: 'mac-1', displayName: 'Mac', capabilities: ['codex'],
    } });
    await api.dispatch({ method: 'POST', path: '/v1/agent/host/commands/claim', body: { hostId: 'mac-1' } });
    await api.dispatch({ method: 'POST', path: '/v1/agent/host/events', body: {
      hostId: 'mac-1', events: [{
        eventId: 'approval-status-test', taskId, type: 'approval_requested', title: '許可待ち',
        detail: '検証を続ける前に確認が必要です。', occurredAt: now,
        payload: { approval: {
          id: 'approval-1', externalRequestID: 'external-1', kind: 'command',
          title: 'iOS検証の実行', reason: 'SwiftPMの検証にsandbox-execが必要です。',
          resource: "scripts/verify.sh ios", requestedAt: now,
        } },
      }],
    } });

    await api.dispatch({ method: 'POST', path: '/v1/chat', body: {
      scopeKey: 'owner-a', threadId: questionThreadId, message: 'どうなった？まだ作業途中？',
    } });

    expect(model.requests).toHaveLength(1);
    expect(promptOf(model.requests[0])).toContain('[Codex作業の現在状態 — Azure DB上の事実・会話履歴より優先]');
    expect(promptOf(model.requests[0])).toContain('リンク表示を直す [waiting_approval] 状態名=許可待ち');
    expect(promptOf(model.requests[0])).toContain('SwiftPMの検証にsandbox-execが必要です。');
    expect(promptOf(model.requests[0])).toContain('scripts/verify.sh ios');
    expect(promptOf(model.requests[0])).toContain('別トークから尋ねられても');
    expect(promptOf(model.requests[0])).toContain('completedを作業中、cancelledを再開中、runningを未開始とは言わない');
  });

  it('routes tasks from older clients to the configured default Agent Host', async () => {
    const api = createLocalApiKernel(
      () => '2026-09-05T03:45:00.000Z',
      { defaultAgentHost: 'shannon-cloud' },
    );
    const created = await api.dispatch({ method: 'POST', path: '/v1/agent/tasks', body: {
      scopeKey: 'owner-a', idempotencyKey: 'cloud-default-test', conversationThreadID: 'thread-a',
      title: 'クラウド作業', goal: '旧版クライアントから依頼する', summary: 'クラウドへ送る',
    } });
    expect(created.status).toBe(201);

    const macClaim = await api.dispatch({ method: 'POST', path: '/v1/agent/host/commands/claim', body: {
      hostId: 'shannon-mac',
    } });
    expect(macClaim).toMatchObject({ status: 200, body: { command: null } });

    const cloudClaim = await api.dispatch({ method: 'POST', path: '/v1/agent/host/commands/claim', body: {
      hostId: 'shannon-cloud',
    } });
    expect(cloudClaim).toMatchObject({
      status: 200,
      body: { command: { payload: { hostHint: 'shannon-cloud' } } },
    });
  });

  it('exposes an allowlisted workspace snapshot without exposing host paths', async () => {
    const api = createLocalApiKernel(() => '2026-09-05T03:45:00.000Z');
    await api.dispatch({ method: 'POST', path: '/v1/agent/host/heartbeat', body: {
      hostId: 'shannon-mac', displayName: 'このMac', kind: 'local',
      capabilities: ['workspace-files', 'workspace-diff', 'workspace-git'],
      projects: ['shannon-ios'], models: [], workspaces: [{
        key: 'shannon-ios', isGitRepository: true, currentBranch: 'feature/workspace',
        files: ['apps/macos-app/ShannonDeskApp.swift', 'services/api/src/agentHost.ts'],
        changes: [{ path: 'services/api/src/agentHost.ts', status: 'M', additions: 4, deletions: 1 }],
      }],
    } });

    const response = await api.dispatch({
      method: 'GET', path: '/v1/agent/workspace',
      query: new URLSearchParams({ scopeKey: 'owner-a', project: 'shannon-ios' }),
    });

    expect(response).toMatchObject({ status: 200, body: {
      routing: { resolvedHostId: 'shannon-mac' },
      projects: [{
        key: 'shannon-ios', isGitRepository: true, currentBranch: 'feature/workspace',
        files: ['apps/macos-app/ShannonDeskApp.swift', 'services/api/src/agentHost.ts'],
        changes: [{ path: 'services/api/src/agentHost.ts', status: 'M', additions: 4, deletions: 1 }],
      }],
    } });
    expect(JSON.stringify(response.body)).not.toContain('/Users/');
  });

  it('queues an explicit Aether proposal without calling the chat model', async () => {
    const model = new RecordingChatModel();
    const created: unknown[] = [];
    const api = createLocalApiKernel(
      () => '2026-09-03T00:00:00.000Z',
      {
        chatModel: model,
        aetherProposals: {
          configured: true,
          create(scopeKey, input) {
            created.push({ scopeKey, input });
            return {
              id: 'proposal-1', operation: 'new-note', title: input.title ?? '提案', content: input.content,
              reason: input.reason ?? '会話から', createdAt: '2026-09-03T00:00:00.000Z',
            };
          },
        },
      },
    );
    const response = await api.dispatch({ method: 'POST', path: '/v1/aether/proposals', body: {
      scopeKey: 'owner-a', title: '設計案', content: 'Aetherへ残す内容', reason: 'Shannonの返答',
    } });
    expect(response).toMatchObject({ status: 201, body: { id: 'proposal-1', operation: 'new-note' } });
    expect(created).toEqual([{ scopeKey: 'owner-a', input: { title: '設計案', content: 'Aetherへ残す内容', reason: 'Shannonの返答' } }]);
    expect(model.requests).toEqual([]);
  });

  it('updates emotion and recalled memories only behind the response lane', async () => {
    let tick = 0;
    const api = createLocalApiKernel(() => `2026-08-31T00:00:${String(tick++).padStart(2, '0')}.000Z`);
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
    expect(second).toMatchObject({ body: { snapshotVersion: 2 } });
    await api.waitForBackground('owner-a');
    const state = await api.dispatch({
      method: 'GET', path: '/v1/state', query: new URLSearchParams({ scopeKey: 'owner-a' }),
    });
    expect(state).toMatchObject({
      status: 200,
      body: {
        // Two emotion deltas, recall, the interest, and two shared-time recalibrations.
        version: 6,
        temperament: { closeness: 0.17, curiosity: 0.53 },
        presence: { mood: { expression: expect.any(String) }, temperamentReasons: { closeness: 'この30日で1日話した' } },
        interests: ['創作'],
        activeMemories: [{ summary: expect.stringContaining('創作を進められて嬉しい') }],
      },
    });
  });

  it('builds a live voice session from current state and persists completed spoken turns', async () => {
    const api = createLocalApiKernel(() => '2026-09-06T05:30:00.000Z');
    const thread = await api.dispatch({ method: 'POST', path: '/v1/threads', body: {
      scopeKey: 'owner-a', title: '音声の相談',
    } });
    const threadId = String((thread.body as { threadId: string }).threadId);
    await api.dispatch({ method: 'POST', path: '/v1/chat', body: {
      scopeKey: 'owner-a', threadId, message: '音声で続きを話したい',
    } });
    await api.waitForBackground('owner-a');

    const session = api.realtimeVoiceSession('owner-a', threadId);
    expect(session.threadId).toBe(threadId);
    expect(session.instructions).toContain('[Shannon shared state v2]');
    expect(session.instructions).toContain('音声で続きを話したい');
    expect(session.instructions).toContain('[Live voice conversation]');
    expect(session.instructions).toContain('primarily speaks Japanese');
    expect(session.instructions).toContain('少しポンコツなメイドAI');
    expect(session.instructions).toContain('一人称は必ずカタカナの「ボク」');
    expect(session.instructions).toContain('「ライ氏」と呼び');
    expect(session.instructions).not.toContain('tsundere');

    const brightSession = api.realtimeVoiceSession('owner-a', threadId, { brightVoice: true });
    expect(brightSession.voice).toBe(session.voice);

    const committed = await api.dispatch({ method: 'POST', path: '/v1/voice/gemini/cascade/turns', body: {
      scopeKey: 'owner-a', threadId,
      userTranscript: '明日は散歩に行きたい',
      shannonTranscript: '朝の涼しい時間に行くの、よさそう。',
    } });
    expect(committed).toMatchObject({ status: 201, body: { threadId } });

    const history = await api.dispatch({
      method: 'GET', path: '/v1/conversation',
      query: new URLSearchParams({ scopeKey: 'owner-a', threadId }),
    });
    expect(history).toMatchObject({
      status: 200,
      body: { messages: [
        { role: 'user', content: '音声で続きを話したい' },
        { role: 'assistant' },
        { role: 'user', content: '明日は散歩に行きたい' },
        { role: 'assistant', content: '朝の涼しい時間に行くの、よさそう。' },
      ] },
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

  it('exposes and acknowledges proactive messages without involving the chat model', async () => {
    let acknowledged = false;
    const model = new RecordingChatModel();
    const api = createLocalApiKernel(
      () => '2026-09-03T03:00:00.000Z',
      {
        chatModel: model,
        initiativeInbox: {
          unreadMessages: scopeKey => acknowledged ? [] : [{
            id: 'initiative-1', threadId: 'thread-1', content: 'これが気になった。',
            expression: 'curious', sourceTitle: 'Hacker News', sourceURL: 'https://example.com',
            createdAt: '2026-09-03T02:00:00.000Z',
          }],
          markRead: (scopeKey, threadId) => {
            expect(scopeKey).toBe('owner-a');
            expect(threadId).toBe('thread-1');
            acknowledged = true;
            return 1;
          },
        },
      },
    );
    expect(await api.dispatch({
      method: 'GET', path: '/v1/initiatives', query: new URLSearchParams({ scopeKey: 'owner-a' }),
    })).toMatchObject({ status: 200, body: { unreadCount: 1 } });
    expect(await api.dispatch({
      method: 'POST', path: '/v1/initiatives/read', body: { scopeKey: 'owner-a', threadId: 'thread-1' },
    })).toEqual({ status: 200, body: { markedRead: 1 } });
    expect(model.requests).toEqual([]);
  });

  it('runs a fake agent task from an idempotent start through approval to completion', async () => {
    let tick = 0;
    const clock = () => `2026-09-04T00:00:${String(tick++).padStart(2, '0')}.000Z`;
    const api = createLocalApiKernel(clock);
    const input = {
      scopeKey: 'owner-a', idempotencyKey: 'device-start-1', conversationThreadID: 'thread-a',
      sourceMessageID: 'message-a', title: '接続障害を直す', goal: '履歴を残したまま直す', summary: '安全に調べて直す。',
    };
    const created = await api.dispatch({ method: 'POST', path: '/v1/agent/tasks', body: input });
    const duplicate = await api.dispatch({ method: 'POST', path: '/v1/agent/tasks', body: input });
    expect(created).toMatchObject({ status: 201, body: { created: true, task: { status: 'queued' } } });
    expect(duplicate).toMatchObject({ status: 200, body: { created: false } });
    const taskId = (created.body as { task: { id: string } }).task.id;

    const claimed = await api.dispatch({
      method: 'POST', path: '/v1/agent/host/commands/claim', body: { hostId: 'fake-mac' },
    });
    expect(claimed).toMatchObject({ status: 200, body: { command: { taskId, type: 'start' } } });
    await api.dispatch({ method: 'POST', path: '/v1/agent/host/events', body: {
      hostId: 'fake-mac', events: [{
        eventId: 'fake-started', taskId, type: 'started', title: '調査開始',
        detail: '関連箇所を確認中', occurredAt: clock(), payload: { currentAction: '接続処理を確認中' },
      }, {
        eventId: 'fake-approval', taskId, type: 'approval_requested', title: '判断待ち', occurredAt: clock(),
        payload: { approval: {
          externalRequestID: 'approval-1', kind: 'network', title: '接続試験', reason: '外部接続が必要',
        } },
      }],
    } });
    const waiting = await api.dispatch({
      method: 'GET', path: `/v1/agent/tasks/${taskId}`,
      query: new URLSearchParams({ scopeKey: 'owner-a' }),
    });
    expect(waiting).toMatchObject({ status: 200, body: { task: { status: 'waiting_approval' } } });

    const approval = {
      scopeKey: 'owner-a', idempotencyKey: 'approval-command-1', type: 'resolve_approval',
      payload: { decision: 'allow_once', externalRequestID: 'approval-1' },
    };
    expect(await api.dispatch({
      method: 'POST', path: `/v1/agent/tasks/${taskId}/commands`, body: approval,
    })).toMatchObject({ status: 202, body: { created: true, task: { status: 'starting' } } });
    expect(await api.dispatch({
      method: 'POST', path: `/v1/agent/tasks/${taskId}/commands`, body: approval,
    })).toMatchObject({ status: 200, body: { created: false } });

    await api.dispatch({ method: 'POST', path: '/v1/agent/host/events', body: {
      hostId: 'fake-mac', events: [{
        eventId: 'fake-complete', taskId, type: 'completed', title: '修正完了', detail: '接続を復旧した。',
        occurredAt: clock(), payload: {
          changes: [{ id: 'change-1', displayName: 'SessionStore.swift', summary: '復元順序を修正', additions: 4, deletions: 2 }],
          tests: [{ id: 'test-1', name: '接続回帰試験', status: 'passed', detail: '成功' }],
        },
      }],
    } });
    const completed = await api.dispatch({
      method: 'GET', path: `/v1/agent/tasks/${taskId}`,
      query: new URLSearchParams({ scopeKey: 'owner-a' }),
    });
    expect(completed).toMatchObject({
      status: 200,
      body: { task: { status: 'completed', changes: [{ displayName: 'SessionStore.swift' }], tests: [{ status: 'passed' }] } },
    });
    expect(await api.dispatch({
      method: 'POST', path: `/v1/agent/tasks/${taskId}/metadata`,
      body: { scopeKey: 'owner-a', isPinned: true, isArchived: true },
    })).toMatchObject({
      status: 200, body: { task: { isPinned: true, isArchived: true } },
    });
    const sequence = (completed.body as { task: { latestSequence: number } }).task.latestSequence;
    expect(await api.dispatch({
      method: 'GET', path: `/v1/agent/tasks/${taskId}`,
      query: new URLSearchParams({ scopeKey: 'owner-a', afterSequence: String(sequence) }),
    })).toEqual({ status: 304, body: null });
  });
});
