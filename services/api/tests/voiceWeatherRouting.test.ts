import { describe, expect, it, vi } from 'vitest';
import { JevVoiceDecisionGateway, LocalVoiceDecisionGateway } from '../src/mind/selectors/voiceDecision.js';
import { CURRENT_WEB_BESIDE_WEATHER, ROUTER_SKILLS, skillInstructions, VOICE_SKILLS, type VoiceDecisionInput } from '../src/contracts/voiceDecisionContract.js';
import { fallbackWaitingDirection } from '../src/surfaces/voice/voiceWaitingCue.js';
import { voiceTurnGrounding } from '../src/surfaces/voice/voiceGrounding.js';

/**
 * 2026-10-13 daily evals E2/E3: 「明日の福岡と東京の天気は？」 and 「明日、傘いる？」 went to research (`current_web`) by Jev and the
 * local rules, and she said 「調べてみますね」 instead of reading her weather tool. A forecast question is the weather capability.
 */
const input = (transcript: string, othersPresent = false): VoiceDecisionInput => ({
  scopeKey: 'owner', transcript, participantMode: 'owner', requestedLocation: false, hasFreshLocation: false,
  turn: { sheAsked: false, followsShannon: false, othersPresent, source: 'speech' },
});

const routerAnswers = (asked: Record<string, unknown>) => Object.fromEntries(Object.keys(asked).map(key => [key, key.startsWith('skill__')
  ? { type: 'noul', noul: key === 'skill__current_web' ? 0.95 : 0.05 }
  : { reply_required: { type: 'noul', noul: 0.9 }, solution_wanted: { type: 'noul', noul: 0.9 }, transcript_reliable: { type: 'noul', noul: 0.95 },
    conversation_class: { type: 'choice', choice: 'skill_simple' }, affect: { type: 'choice', choice: 'neutral' },
    affect_intensity: { type: 'choice', choice: 'subtle' }, delivery: { type: 'choice', choice: 'focused' },
    latency_class: { type: 'choice', choice: 'under_3s' } }[key] ?? { type: 'noul', noul: 0.1 }]).filter(([, value]) => value));

function jev(weatherSkill?: boolean) {
  const bodies: Array<{ questions: Record<string, { instructions: string }> }> = [];
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { questions: Record<string, { instructions: string }> };
    bodies.push(body);
    return new Response(JSON.stringify({ answers: routerAnswers(body.questions) }));
  }) as unknown as typeof fetch;
  return { gateway: new JevVoiceDecisionGateway({ apiKey: 'test-only', fetcher, ...(weatherSkill ? { weatherSkill } : {}) }), bodies };
}

describe('a forecast question is her weather tool\'s, not research', () => {
  it('the local rules choose the weather and not the web for the owner alone', async () => {
    const local = new LocalVoiceDecisionGateway();
    for (const words of ['明日、傘いる？', '明日傘いる', '明日の福岡と東京の天気は？', '東京都 博多の天気', '今日の浜松の天気を調べて']) {
      const decision = await local.decide(input(words));
      expect(decision.selectedSkills, words).toContain('weather');
      expect(decision.selectedSkills, words).not.toContain('current_web');
    }
    // With anyone else there her weather tool is not offered: the web stays. A question beyond a forecast keeps the web too.
    expect((await local.decide(input('明日の天気は？', true))).selectedSkills).toEqual(expect.arrayContaining(['weather', 'current_web']));
    expect((await local.decide(input('台風の警報、明日の天気はどう？'))).selectedSkills).toEqual(expect.arrayContaining(['weather', 'current_web']));
    expect((await local.decide({ ...input('明日の天気は？'), participantMode: 'guest' })).selectedSkills).toContain('current_web');
    expect((await local.decide(input('元気？'))).selectedSkills).not.toContain('weather');
  });

  it('over a Jev answer that chose the web, and without changing the historical router question set', async () => {
    const plain = jev();
    const decision = await plain.gateway.decide(input('明日、傘いる？'));
    expect(decision.selectedSkills).toContain('weather');
    expect(decision.selectedSkills).not.toContain('current_web');
    expect(Object.keys(plain.bodies[0]!.questions).filter(key => key.startsWith('skill__'))).toEqual(ROUTER_SKILLS.map(skill => `skill__${skill}`));
    expect(plain.bodies[0]!.questions.skill__current_web!.instructions).toBe(skillInstructions.current_web);
    // A non-weather turn reads the web as before.
    expect((await plain.gateway.decide(input('今日のニュースは？'))).selectedSkills).toContain('current_web');
  });

  it('asks Jev about the weather where her weather tool exists', async () => {
    const asked = jev(true);
    await asked.gateway.decide(input('明日、傘いる？'));
    expect(Object.keys(asked.bodies[0]!.questions).filter(key => key.startsWith('skill__'))).toEqual(VOICE_SKILLS.map(skill => `skill__${skill}`));
    expect(asked.bodies[0]!.questions.skill__current_web!.instructions).toBe(CURRENT_WEB_BESIDE_WEATHER);
    expect(asked.bodies[0]!.questions.skill__weather!.instructions).toContain('umbrella');
  });

  it('gives the turn the weather cue and the instruction to read the forecast now', () => {
    expect(fallbackWaitingDirection({ transcript: '明日、傘いる？' }, ['weather'], 'neutral', 0.2, 'focused').scenario).toBe('weather');
    const grounding = voiceTurnGrounding({ temporaryGuest: false, alone: true, legacyGuest: false, selectedSkills: new Set(['weather']),
      at: '2026-11-20T12:10:00.000Z', deviceContext: null });
    expect(grounding).toContain('weather_forecast');
    expect(grounding).toContain('do not hand it to research');
    // Without her weather tool the turn is a web turn (`apiLiveVoice.ts` adds `current_web`): no weather line then.
    expect(voiceTurnGrounding({ temporaryGuest: false, alone: true, legacyGuest: false, selectedSkills: new Set(['weather', 'current_web']),
      at: '2026-11-20T12:10:00.000Z', deviceContext: null })).not.toContain('do not hand it to research');
  });
});
