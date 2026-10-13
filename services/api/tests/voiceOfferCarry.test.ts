import { describe, expect, it, vi } from 'vitest';
import { carriedOffer, carriedRequest } from '../src/mind/selectors/voiceOfferCarry.js';
import { JevVoiceDecisionGateway, LocalVoiceDecisionGateway } from '../src/mind/selectors/voiceDecision.js';
import { VOICE_SKILLS } from '../src/contracts/voiceDecisionContract.js';

const turn = (transcript: string, offer: string, before = '有明海でエビは取れる？') => ({
  scopeKey: 'owner-a', transcript, participantMode: 'owner' as const, requestedLocation: false, hasFreshLocation: false,
  context: [{ role: 'user' as const, content: before }, { role: 'assistant' as const, content: offer }],
});

describe('a short yes to her own offer to look something up (owner decision 2026-10-13)', () => {
  it('carries the offer into the turn: the web when nothing else is named, the named capability otherwise', () => {
    expect(carriedOffer(turn('お願いします', 'ボクの中には確かな情報がありません。調べてみましょうか？'))?.skills).toEqual(['current_web']);
    expect(carriedOffer(turn('うん、お願い。', '博多の天気は晴れです。東京の天気も見ますか？'))?.skills).toEqual(['current_web']);
    expect(carriedOffer(turn('はい', '博多も同じ道具で確かめ直せますけど、見ますか？'))?.skills).toEqual(['current_web']);
    expect(carriedOffer(turn('ぜひ', 'Voyagerのタスクも確認しましょうか？'))?.skills).toEqual(['voyager_tasks']);
  });

  it('carries nothing for a no, a new question, or a yes to something that was not an offer to look', () => {
    expect(carriedOffer(turn('いや、いいよ', '調べてみましょうか？'))).toBeNull();
    expect(carriedOffer(turn('エビは何種類いるの？', '調べてみましょうか？'))).toBeNull();
    expect(carriedOffer(turn('うん', 'ムツゴロウが有名です。食べてみたいものはありますか？'))).toBeNull();
    // 「見ますか？」 about something that is not looked up (review 2026-10-13).
    expect(carriedOffer(turn('うん', '昨日撮った写真見ますか？'))).toBeNull();
    expect(carriedOffer({ ...turn('お願い', ''), context: [] })).toBeNull();
  });

  it('gives the research his request, her offer and his yes', () => {
    const carried = carriedOffer(turn('お願いします', '調べてみましょうか？'))!;
    expect(carriedRequest(carried, 'お願いします')).toBe('ライ氏「有明海でエビは取れる？」 → ボク「調べてみましょうか？」 → ライ氏「お願いします」');
  });

  it('selects the web for the local rules and over a Jev answer that left it out', async () => {
    const local = await new LocalVoiceDecisionGateway().decide(turn('お願いします', '調べてみましょうか？'));
    expect(local.selectedSkills).toContain('current_web');
    const answers = {
      ...Object.fromEntries(VOICE_SKILLS.map(skill => [`skill__${skill}`, { type: 'noul', noul: 0.05 }])),
      reply_required: { type: 'noul', noul: 0.9 }, solution_wanted: { type: 'noul', noul: 0.9 },
      conversation_class: { type: 'choice', choice: 'direct' }, affect: { type: 'choice', choice: 'neutral' },
      affect_intensity: { type: 'choice', choice: 'subtle' }, delivery: { type: 'choice', choice: 'conversational' },
      latency_class: { type: 'choice', choice: 'under_3s' },
    };
    const jev = await new JevVoiceDecisionGateway({ apiKey: 'test-only',
      fetcher: vi.fn(async () => new Response(JSON.stringify({ answers }))) as typeof fetch }).decide(turn('うん、お願い', '東京の天気も見ますか？'));
    expect(jev.source).toBe('jev');
    expect(jev.selectedSkills).toContain('current_web');
  });
});
