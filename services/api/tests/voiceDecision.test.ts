import { describe, expect, it, vi } from 'vitest';
import {
  createConfiguredVoiceDecisionGateway,
  JevVoiceDecisionGateway,
  LocalVoiceDecisionGateway,
  OpenAIVoiceDecisionGateway,
  VOICE_SKILLS,
} from '../src/voiceDecision.js';

function jevAnswers(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...Object.fromEntries(VOICE_SKILLS.map(skill => [`skill__${skill}`, { type: 'noul', noul: 0.1 }])),
    reply_required: { type: 'noul', noul: 0.9 },
    solution_wanted: { type: 'noul', noul: 0.7 },
    conversation_class: { type: 'choice', choice: 'direct', confidence: 0.9, probabilities: {} },
    affect: { type: 'choice', choice: 'bright', confidence: 0.8, probabilities: {} },
    affect_intensity: { type: 'choice', choice: 'moderate', confidence: 0.8, probabilities: {} },
    delivery: { type: 'choice', choice: 'quick', confidence: 0.8, probabilities: {} },
    latency_class: { type: 'choice', choice: 'under_3s', confidence: 0.8, probabilities: {} },
    ...overrides,
  };
}

describe('Jev voice decision routing', () => {
  it('scores every skill independently and selects every score at or above the threshold', async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body));
      expect(Object.keys(request.questions).filter(key => key.startsWith('skill__')).sort())
        .toEqual(VOICE_SKILLS.map(skill => `skill__${skill}`).sort());
      expect(VOICE_SKILLS.every(skill => request.questions[`skill__${skill}`].type === 'noul')).toBe(true);
      return new Response(JSON.stringify({
        model: 'jev-latest',
        answers: jevAnswers({
          skill__aether_notes: { type: 'noul', noul: 0.72 },
          skill__voyager_tasks: { type: 'noul', noul: 0.61 },
          skill__daily_mind: { type: 'noul', noul: 0.54 },
          conversation_class: { type: 'choice', choice: 'skill_simple' },
        }),
        usage: { input_tokens: 10, output_tokens: 5 },
      }));
    });
    const gateway = new JevVoiceDecisionGateway({
      apiKey: 'test-only', fetcher: fetcher as typeof fetch, skillThreshold: 0.6,
    });
    expect(gateway.model).toBe('jev-latest');

    const decision = await gateway.decide({
      scopeKey: 'owner-a', transcript: 'ノートとタスクを確認して', participantMode: 'owner',
      requestedLocation: false, hasFreshLocation: false,
    });

    expect(decision.source).toBe('jev');
    expect(decision.selectedSkills).toEqual(['aether_notes', 'voyager_tasks']);
    expect(decision.affect).toBe('bright');
    expect(decision.affectIntensity).toBe(0.6);
    expect(decision.delivery).toBe('quick');
    expect(decision.latencyClass).toBe('under_3s');
    expect(decision.solutionWantedProbability).toBe(0.7);
  });

  it('suppresses speech only when both the class and reply probability agree', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      answers: jevAnswers({
        reply_required: { type: 'noul', noul: 0.2 },
        conversation_class: { type: 'choice', choice: 'no_response' },
      }),
    })));
    const gateway = new JevVoiceDecisionGateway({ apiKey: 'test-only', fetcher: fetcher as typeof fetch });
    const decision = await gateway.decide({
      scopeKey: 'owner-a', transcript: 'うん', participantMode: 'owner', requestedLocation: false, hasFreshLocation: false,
    });
    expect(decision.shouldRespond).toBe(false);
    expect(decision.conversationClass).toBe('no_response');
  });

  it('normalizes inconsistent Jev class answers without silencing meaningful turns', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      answers: jevAnswers({
        reply_required: { type: 'noul', noul: 0.9 },
        conversation_class: { type: 'choice', choice: 'no_response' },
        skill__daily_mind: { type: 'noul', noul: 0.9 },
      }),
    })));
    const gateway = new JevVoiceDecisionGateway({ apiKey: 'test-only', fetcher: fetcher as typeof fetch });
    const decision = await gateway.decide({
      scopeKey: 'owner-a', transcript: '今日は何を考えてたの？', participantMode: 'owner',
      requestedLocation: false, hasFreshLocation: false,
    });
    expect(decision.shouldRespond).toBe(true);
    expect(decision.conversationClass).toBe('skill_simple');
    expect(decision.selectedSkills).toContain('daily_mind');
  });

  it('treats a bounded standalone acknowledgement as no-response even when Jev overcalls it', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      answers: jevAnswers({
        reply_required: { type: 'noul', noul: 0.9 },
        conversation_class: { type: 'choice', choice: 'direct' },
      }),
    })));
    const gateway = new JevVoiceDecisionGateway({ apiKey: 'test-only', fetcher: fetcher as typeof fetch });
    const decision = await gateway.decide({
      scopeKey: 'owner-a', transcript: 'うん', participantMode: 'owner',
      requestedLocation: false, hasFreshLocation: false,
    });
    expect(decision.shouldRespond).toBe(false);
    expect(decision.conversationClass).toBe('no_response');
  });

  it('falls back without losing mandatory current-information routing or exposing owner skills to guests', async () => {
    const gateway = new JevVoiceDecisionGateway({
      apiKey: 'test-only',
      fetcher: vi.fn(async () => { throw new Error('offline'); }) as typeof fetch,
    });
    const current = await gateway.decide({
      scopeKey: 'owner-a', transcript: '今日の天気を調べて', participantMode: 'owner', requestedLocation: false, hasFreshLocation: false,
    });
    expect(current.source).toBe('fallback');
    expect(current.selectedSkills).toContain('current_web');

    const guest = await new LocalVoiceDecisionGateway().decide({
      scopeKey: 'guest-session', transcript: 'AetherのメモとVoyagerのタスクを見せて', participantMode: 'guest',
      requestedLocation: false, hasFreshLocation: false,
    });
    expect(guest.selectedSkills).not.toContain('aether_notes');
    expect(guest.selectedSkills).not.toContain('voyager_tasks');
  });
});

describe('OpenAI voice decision compatibility routing', () => {
  it('uses a lightweight structured-output model while Jev is unavailable', async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as Record<string, any>;
      expect(request.model).toBe('gpt-5.6-luna');
      expect(request.reasoning).toEqual({ effort: 'none' });
      expect(request.store).toBe(false);
      expect(request.text.format.schema.properties.skillScores.required).toEqual(VOICE_SKILLS);
      return new Response(JSON.stringify({
        output_text: JSON.stringify({
          replyRequiredProbability: 0.94,
          solutionWantedProbability: 0.82,
          conversationClass: 'skill_simple',
          latencyClass: 'under_10s',
          affect: 'caring',
          affectIntensity: 0.68,
          delivery: 'gentle',
          skillScores: Object.fromEntries(VOICE_SKILLS.map(skill => [
            skill, skill === 'conversation_memory' || skill === 'daily_mind' ? 0.9 : 0.1,
          ])),
        }),
      }));
    });
    const gateway = new OpenAIVoiceDecisionGateway({ apiKey: 'test-only', fetcher: fetcher as typeof fetch });

    const decision = await gateway.decide({
      scopeKey: 'owner-a', transcript: '前の話も踏まえて考えて', participantMode: 'owner',
      requestedLocation: false, hasFreshLocation: false,
    });

    expect(decision.source).toBe('openai');
    expect(decision.selectedSkills).toEqual(['conversation_memory', 'daily_mind']);
    expect(decision.affect).toBe('caring');
    expect(decision.affectIntensity).toBe(0.68);
    expect(decision.delivery).toBe('gentle');
    expect(decision.latencyClass).toBe('under_10s');
    expect(decision.solutionWantedProbability).toBe(0.82);
  });

  it('falls through Jev to the lightweight structured router before local rules', async () => {
    const openAIFetcher = vi.fn(async () => new Response(JSON.stringify({
      output_text: JSON.stringify({
        replyRequiredProbability: 0.9,
        solutionWantedProbability: 0.2,
        conversationClass: 'direct',
        latencyClass: 'under_3s',
        affect: 'playful',
        affectIntensity: 0.4,
        delivery: 'conversational',
        skillScores: Object.fromEntries(VOICE_SKILLS.map(skill => [skill, 0.1])),
      }),
    })));
    const fallback = new OpenAIVoiceDecisionGateway({
      apiKey: 'openai-test', fetcher: openAIFetcher as typeof fetch,
    });
    const gateway = new JevVoiceDecisionGateway({
      apiKey: 'jev-test',
      fetcher: vi.fn(async () => { throw new Error('jev unavailable'); }) as typeof fetch,
      fallbackGateway: fallback,
    });

    const decision = await gateway.decide({
      scopeKey: 'owner-a', transcript: 'なんとなく話したい', participantMode: 'owner',
      requestedLocation: false, hasFreshLocation: false,
    });

    expect(decision.source).toBe('openai');
    expect(decision.solutionWantedProbability).toBe(0.2);
    expect(openAIFetcher).toHaveBeenCalledOnce();
  });

  it('prefers Jev when configured, otherwise OpenAI, then deterministic rules', () => {
    expect(createConfiguredVoiceDecisionGateway({
      TYPESAFE_API_KEY: 'jev-key', OPENAI_API_KEY: 'openai-key',
    }).mode).toBe('jev');
    expect(createConfiguredVoiceDecisionGateway({ OPENAI_API_KEY: 'openai-key' }).mode).toBe('openai');
    expect(createConfiguredVoiceDecisionGateway({}).mode).toBe('fallback');
  });
});
