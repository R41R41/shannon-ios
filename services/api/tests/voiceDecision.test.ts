import { describe, expect, it, vi } from 'vitest';
import { resolveShannonEmotionState } from '@shannon/cognition';
import {
  createConfiguredVoiceDecisionGateway,
  JevVoiceDecisionGateway,
  LocalVoiceDecisionGateway,
  OpenAIVoiceDecisionGateway,
  VOICE_SKILLS,
} from '../src/voiceDecision.js';
import { voicePlanResponse } from '../src/voiceEmotionPlan.js';

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
    waiting_scenario: { type: 'choice', choice: 'general' },
    waiting_variant: { type: 'choice', choice: 'steady' },
    waiting_affect: { type: 'choice', choice: 'bright' },
    waiting_intensity: { type: 'choice', choice: 'subtle' },
    waiting_delivery: { type: 'choice', choice: 'quick' },
    ...overrides,
  };
}

describe('Jev voice decision routing', () => {
  it('selects place discovery alongside current web for a combined voice request', async () => {
    const decision = await new LocalVoiceDecisionGateway().decide({
      scopeKey: 'owner-a', transcript: '近くのカフェを探して、今日の天気も教えて',
      participantMode: 'owner', requestedLocation: true, hasFreshLocation: true,
    });
    expect(decision.selectedSkills).toEqual(expect.arrayContaining(['current_web', 'place_discovery', 'device_context']));
    expect(decision.conversationClass).toBe('skill_complex');
  });

  it('selects a bounded waiting line and independent emotional delivery in the same Jev call', async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body));
      expect(request.questions.waiting_scenario.type).toBe('choice');
      expect(request.questions.waiting_affect.type).toBe('choice');
      return new Response(JSON.stringify({ answers: jevAnswers({
        skill__current_web: { type: 'noul', noul: 0.95 },
        conversation_class: { type: 'choice', choice: 'skill_simple' },
        latency_class: { type: 'choice', choice: 'under_10s' },
        affect: { type: 'choice', choice: 'focused' },
        delivery: { type: 'choice', choice: 'focused' },
        waiting_scenario: { type: 'choice', choice: 'weather' },
        waiting_variant: { type: 'choice', choice: 'warm' },
        waiting_affect: { type: 'choice', choice: 'caring' },
        waiting_intensity: { type: 'choice', choice: 'moderate' },
        waiting_delivery: { type: 'choice', choice: 'gentle' },
      }) }));
    });
    const decision = await new JevVoiceDecisionGateway({
      apiKey: 'test-only', fetcher: fetcher as typeof fetch,
    }).decide({
      scopeKey: 'owner-a', transcript: '今日の天気を教えて', participantMode: 'owner',
      requestedLocation: false, hasFreshLocation: false,
    });

    expect(decision.source).toBe('jev');
    expect(decision.affect).toBe('focused');
    expect(voicePlanResponse(decision)).toMatchObject({
      waitingPhrase: '空模様を確かめますね。',
      waitingPerformance: { affect: 'caring', intensity: 0.6, delivery: 'gentle' },
    });
  });

  it('does not expose an unselected private category or speak before a no-response turn', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ answers: jevAnswers({
      skill__aether_notes: { type: 'noul', noul: 0.99 },
      latency_class: { type: 'choice', choice: 'under_10s' },
      waiting_scenario: { type: 'choice', choice: 'aether' },
      waiting_variant: { type: 'choice', choice: 'lively' },
    }) })));
    const gateway = new JevVoiceDecisionGateway({ apiKey: 'test-only', fetcher: fetcher as typeof fetch });
    const guest = await gateway.decide({
      scopeKey: 'guest', transcript: '少し考えて', participantMode: 'guest',
      requestedLocation: false, hasFreshLocation: false,
    });
    expect(voicePlanResponse(guest).waitingPhrase).toBe('よし、さっと見てみますね。');

    const silent = { ...guest, shouldRespond: false };
    expect(voicePlanResponse(silent).waitingPhrase).toBeUndefined();
    expect(voicePlanResponse({ ...guest, latencyClass: 'under_3s' }).waitingPhrase).toBeUndefined();
  });

  it('keeps a valid Jev route when an older response omits the new waiting decisions', async () => {
    const answers = jevAnswers({
      skill__current_web: { type: 'noul', noul: 0.95 },
      latency_class: { type: 'choice', choice: 'under_10s' },
    });
    for (const key of [
      'waiting_scenario', 'waiting_variant', 'waiting_affect', 'waiting_intensity', 'waiting_delivery',
    ]) delete answers[key];
    const gateway = new JevVoiceDecisionGateway({
      apiKey: 'test-only',
      fetcher: vi.fn(async () => new Response(JSON.stringify({ answers }))) as typeof fetch,
    });
    const decision = await gateway.decide({
      scopeKey: 'owner-a', transcript: '今日の天気を教えて', participantMode: 'owner',
      requestedLocation: false, hasFreshLocation: false,
    });
    expect(decision.source).toBe('jev');
    expect(voicePlanResponse(decision).waitingPhrase).toBe('いまの天気を確認しますね。');
  });

  it('keeps a waiting acknowledgement gentle when grief overrides a playful Jev choice', async () => {
    const decision = await new LocalVoiceDecisionGateway().decide({
      scopeKey: 'owner-a', transcript: '原因を調べて', participantMode: 'owner',
      requestedLocation: false, hasFreshLocation: false,
    });
    const emotion = resolveShannonEmotionState({
      provisionalPrimary: 'playful', provisionalIntensity: 0.9,
      transcript: '家族が亡くなったことを話したい', now: '2026-09-30T00:00:00.000Z',
    });
    const plan = voicePlanResponse({ ...decision, latencyClass: 'under_10s',
      waitingDirection: {
        scenario: 'troubleshooting', variant: 'lively', affect: 'playful',
        intensity: 0.9, delivery: 'energetic',
      },
    }, emotion);
    expect(plan.waitingPhrase).toBe('うん、ちゃんと聞いています。');
    expect(plan.waitingPerformance).toEqual({ affect: 'caring', intensity: 0.5, delivery: 'gentle' });
  });

  it('does not delay an emergency answer with an acknowledgement', async () => {
    const decision = await new LocalVoiceDecisionGateway().decide({
      scopeKey: 'owner-a', transcript: '原因を調べて', participantMode: 'owner',
      requestedLocation: false, hasFreshLocation: false,
    });
    const emotion = resolveShannonEmotionState({
      provisionalPrimary: 'playful', provisionalIntensity: 0.9,
      transcript: '今すぐ助けて、息ができない', now: '2026-09-30T00:00:00.000Z',
    });
    const plan = voicePlanResponse({ ...decision, latencyClass: 'under_10s' }, emotion);
    expect(plan.waitingPhrase).toBeUndefined();
    expect(plan.waitingPerformance).toBeUndefined();
  });
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
