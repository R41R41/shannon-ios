import { describe, expect, it, vi } from 'vitest';
import { OpenAIResponsesChatModel, createConfiguredChatModel } from '../src/chatModel.js';
import type { LlmUsageEvent, LlmUsageStore } from '../src/llmUsage.js';

describe('OpenAI Responses chat adapter', () => {
  it('uses the local stub when the API key is absent', () => {
    expect(createConfiguredChatModel({}).mode).toBe('local-stub');
  });

  it('sends a stateless private response request and reads output_text', async () => {
    const recorded: LlmUsageEvent[] = [];
    const usageStore: LlmUsageStore = {
      recordLlmUsage: event => recorded.push(event),
      backgroundLlmCostUsd: () => 0,
    };
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body).toMatchObject({
        model: 'gpt-5.6-luna',
        instructions: expect.stringContaining('system state'),
        store: false,
        reasoning: { effort: 'none' },
        text: { format: { type: 'json_schema', name: 'shannon_chat_turn', strict: true } },
      });
      expect(String(body.instructions)).toContain('Shannon自身のアプリをユーザーの指示に基づいて改修');
      expect(String(body.instructions)).toContain('直前の会話から対象を特定');
      expect(String(body.instructions)).toContain('hostHintを「shannon-mac」');
      expect(body.input).toEqual([
        { role: 'user', content: '前の話' },
        { role: 'assistant', content: '覚えてる' },
        { role: 'user', content: '続き' },
      ]);
      expect(String(body.safety_identifier)).not.toContain('owner-private');
      return new Response(JSON.stringify({
        output_text: JSON.stringify({
          reply: 'もちろん。続きを聞かせて。',
          taskDecision: { disposition: 'none', reason: '会話の継続でありMac作業ではない' },
          taskProposal: null,
        }),
        usage: {
          input_tokens: 120,
          input_tokens_details: { cached_tokens: 40 },
          output_tokens: 30,
          total_tokens: 150,
        },
      }), { status: 200 });
    });
    const model = new OpenAIResponsesChatModel({
      apiKey: 'test-only', fetcher: fetcher as typeof fetch, usageStore,
      now: () => '2026-09-02T00:00:00.000Z',
    });
    const result = await model.generate({
      scopeKey: 'owner-private',
      systemPrompt: 'system state',
      history: [
        { role: 'user', content: '前の話' },
        { role: 'assistant', content: '覚えてる' },
      ],
      message: '続き',
    });
    expect(result).toEqual({
      mode: 'openai', model: 'gpt-5.6-luna', reply: 'もちろん。続きを聞かせて。',
      taskDecision: { disposition: 'none', reason: '会話の継続でありMac作業ではない' },
    });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(recorded).toEqual([
      expect.objectContaining({
        scopeKey: 'owner-private', lane: 'chat', model: 'gpt-5.6-luna',
        inputTokens: 120, cachedInputTokens: 40, outputTokens: 30, totalTokens: 150,
        estimatedCostUsd: 0.00006,
      }),
    ]);
  });

  it('targets the configured cloud host in task instructions', async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(String(body.instructions)).toContain('hostHintを「shannon-cloud」');
      expect(String(body.instructions)).toContain('内部TestFlight配信');
      return new Response(JSON.stringify({
        output_text: JSON.stringify({
          reply: 'クラウド作業として提案したよ。',
          taskDecision: { disposition: 'propose', reason: '実装依頼' },
          taskProposal: { title: 'UI修正', goal: '修正してTestFlightへ配る', hostHint: 'shannon-cloud', projectHint: 'shannon-ios', risk: null },
        }),
      }), { status: 200 });
    });
    const model = new OpenAIResponsesChatModel({
      apiKey: 'test-only', fetcher: fetcher as typeof fetch, agentHostHint: 'shannon-cloud',
    });

    await model.generate({ scopeKey: 'owner', systemPrompt: 'system', history: [], message: '修正して配って' });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('returns a task proposal in the same model response without another call', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      output_text: JSON.stringify({
        reply: '調べて直す作業として進められるよ。',
        taskDecision: { disposition: 'propose', reason: '接続修正を明示的に依頼している' },
        taskProposal: {
          title: '接続障害を直す', goal: '履歴を残したまま接続を復旧する',
          hostHint: 'Mac', projectHint: 'shannon-ios', risk: '外部接続前に確認が必要',
        },
      }),
      usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
    }), { status: 200 }));
    const model = new OpenAIResponsesChatModel({ apiKey: 'test-only', fetcher: fetcher as typeof fetch });

    const result = await model.generate({ scopeKey: 'owner', systemPrompt: 'system', history: [], message: '接続を直して' });

    expect(result).toMatchObject({
      reply: '調べて直す作業として進められるよ。',
      taskDecision: { disposition: 'propose', reason: '接続修正を明示的に依頼している' },
      taskProposal: { title: '接続障害を直す', projectHint: 'shannon-ios' },
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('rejects contradictory proposal decisions', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      output_text: JSON.stringify({
        reply: '作業を提案したよ。',
        taskDecision: { disposition: 'clarify', reason: '確認が必要' },
        taskProposal: {
          title: '自己改修', goal: 'リンク表示を修正する',
          hostHint: 'shannon-mac', projectHint: 'shannon-ios', risk: null,
        },
      }),
    }), { status: 200 }));
    const model = new OpenAIResponsesChatModel({ apiKey: 'test-only', fetcher: fetcher as typeof fetch });

    await expect(model.generate({
      scopeKey: 'owner', systemPrompt: 'system', history: [], message: '直して',
    })).rejects.toThrow('OPENAI_RESPONSE_SCHEMA_INVALID');
  });

  it('does not silently fall back when a configured provider fails', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      error: { message: 'invalid key' },
    }), { status: 401 }));
    const model = new OpenAIResponsesChatModel({ apiKey: 'test-only', fetcher: fetcher as typeof fetch });
    await expect(model.generate({
      scopeKey: 'owner', systemPrompt: 'system', history: [], message: 'hello',
    })).rejects.toThrow('OPENAI_RESPONSE_401');
  });
});
