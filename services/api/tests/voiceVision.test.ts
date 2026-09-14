import { describe, expect, it, vi } from 'vitest';
import {
  createConfiguredVoiceVisionGateway,
  OpenAIVoiceVisionGateway,
  VoiceVisionError,
} from '../src/voiceVision.js';

describe('Shannon voice camera snapshot gateway', () => {
  it('sends one bounded user-approved image to Responses without retaining it', async () => {
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe('https://api.openai.com/v1/responses');
      const headers = new Headers(init?.headers);
      expect(headers.get('authorization')).toBe('Bearer server-key-only');
      const body = JSON.parse(String(init?.body)) as Record<string, any>;
      expect(body).toMatchObject({
        model: 'gpt-5.6-luna',
        reasoning: { effort: 'none' },
        text: { verbosity: 'low' },
        store: false,
      });
      expect(body.instructions).toContain('Do not identify an unknown person');
      expect(body.input[0].content[1]).toMatchObject({
        type: 'input_image',
        detail: 'low',
      });
      expect(body.input[0].content[1].image_url).toMatch(/^data:image\/jpeg;base64,/);
      expect(body.prompt_cache_key).toMatch(/^shannon_[a-f0-9]{32}$/);
      expect(body.safety_identifier).toBe(body.prompt_cache_key);
      return new Response(JSON.stringify({ output_text: '青い案内板と歩道が見えます。' }));
    });
    const gateway = new OpenAIVoiceVisionGateway({
      apiKey: 'server-key-only',
      fetcher: fetcher as typeof fetch,
    });

    await expect(gateway.analyze({
      scopeKey: 'traveler',
      image: new Uint8Array([0xff, 0xd8, 0xff, ...new Array(125).fill(7)]),
      mimeType: 'image/jpeg',
      conversationContext: '旅行中の会話です。',
    })).resolves.toEqual({
      description: '青い案内板と歩道が見えます。',
      model: 'gpt-5.6-luna',
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('rejects an invalid image before calling the upstream service', async () => {
    const fetcher = vi.fn();
    const gateway = new OpenAIVoiceVisionGateway({
      apiKey: 'server-key-only',
      fetcher: fetcher as typeof fetch,
    });

    await expect(gateway.analyze({
      scopeKey: 'traveler',
      image: new Uint8Array(12),
      mimeType: 'image/png',
      conversationContext: '',
    })).rejects.toEqual(new VoiceVisionError('VOICE_VISION_INVALID_IMAGE'));
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('is disabled without a server API key and accepts an explicit model', () => {
    expect(createConfiguredVoiceVisionGateway({})).toBeNull();
    expect(createConfiguredVoiceVisionGateway({
      OPENAI_API_KEY: 'server-key-only',
      SHANNON_VISION_MODEL: 'gpt-5.6-luna',
    })).toBeInstanceOf(OpenAIVoiceVisionGateway);
  });
});
