import { describe, expect, it, vi } from 'vitest';
import { OpenAIResponsesChatModel, createConfiguredChatModel } from '../src/chatModel.js';

describe('OpenAI Responses chat adapter', () => {
  it('uses the local stub when the API key is absent', () => {
    expect(createConfiguredChatModel({}).mode).toBe('local-stub');
  });

  it('sends a stateless private response request and reads output_text', async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body).toMatchObject({
        model: 'gpt-5.6-luna',
        instructions: 'system state',
        store: false,
        reasoning: { effort: 'none' },
      });
      expect(body.input).toEqual([
        { role: 'user', content: '前の話' },
        { role: 'assistant', content: '覚えてる' },
        { role: 'user', content: '続き' },
      ]);
      expect(String(body.safety_identifier)).not.toContain('owner-private');
      return new Response(JSON.stringify({ output_text: 'もちろん。続きを聞かせて。' }), { status: 200 });
    });
    const model = new OpenAIResponsesChatModel({ apiKey: 'test-only', fetcher: fetcher as typeof fetch });
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
    });
    expect(fetcher).toHaveBeenCalledOnce();
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
