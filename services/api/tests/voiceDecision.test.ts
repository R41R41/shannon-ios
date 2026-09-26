import { describe, expect, it, vi } from 'vitest';
import {
  JevVoiceDecisionGateway,
  LocalVoiceDecisionGateway,
  VOICE_SKILLS,
} from '../src/voiceDecision.js';

function jevAnswers(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...Object.fromEntries(VOICE_SKILLS.map(skill => [`skill__${skill}`, { type: 'noul', noul: 0.1 }])),
    reply_required: { type: 'noul', noul: 0.9 },
    conversation_class: { type: 'choice', choice: 'direct', confidence: 0.9, probabilities: {} },
    affect: { type: 'choice', choice: 'bright', confidence: 0.8, probabilities: {} },
    delivery: { type: 'choice', choice: 'quick', confidence: 0.8, probabilities: {} },
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
        model: 'jev-1.13.0',
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

    const decision = await gateway.decide({
      transcript: 'ノートとタスクを確認して', participantMode: 'owner',
      requestedLocation: false, hasFreshLocation: false,
    });

    expect(decision.source).toBe('jev');
    expect(decision.selectedSkills).toEqual(['aether_notes', 'voyager_tasks']);
    expect(decision.affect).toBe('bright');
    expect(decision.delivery).toBe('quick');
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
      transcript: 'うん', participantMode: 'owner', requestedLocation: false, hasFreshLocation: false,
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
      transcript: '今日の天気を調べて', participantMode: 'owner', requestedLocation: false, hasFreshLocation: false,
    });
    expect(current.source).toBe('fallback');
    expect(current.selectedSkills).toContain('current_web');

    const guest = await new LocalVoiceDecisionGateway().decide({
      transcript: 'AetherのメモとVoyagerのタスクを見せて', participantMode: 'guest',
      requestedLocation: false, hasFreshLocation: false,
    });
    expect(guest.selectedSkills).not.toContain('aether_notes');
    expect(guest.selectedSkills).not.toContain('voyager_tasks');
  });
});
