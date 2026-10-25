import { describe, expect, it } from 'vitest';
import {
  displayedVoiceText, elevenVoiceText, geminiVoiceRequest, heldWhisper, VOICE_AUDIO_TAG_LINES, VOICE_AUDIO_TAGS, voiceAudioTagsIn, VoiceSegmentTags,
} from '../src/infra/models/voiceAudioTags.js';
import { voiceAudioTagsEnabled, voiceConversationInstructions } from '../src/surfaces/voice/voiceConversationInstructions.js';

// Owner 2026-10-20: 「可能なもの全部付けられるようにしたい。ささやき声ができていなかった」.
describe('her voice audio tags', () => {
  it('shows and stores none of them, and keeps a bracketed word and a link as written', () => {
    expect(displayedVoiceText('ねえ、[whispers] これは内緒だよ。')).toBe('ねえ、これは内緒だよ。');
    expect(displayedVoiceText('[Laughs] そんなこと言うなんて、[smiles] ずるいよ。')).toBe('そんなこと言うなんて、ずるいよ。');
    expect(displayedVoiceText('OK [laughs] sure.')).toBe('OK sure.');
    expect(displayedVoiceText('Minebot の [Minebot] を見て。')).toBe('Minebot の [Minebot] を見て。');
    expect(displayedVoiceText('詳しくは[ここ](https://example.com)を見て。')).toBe('詳しくは[ここ](https://example.com)を見て。');
    // Without a bracketed phrase the text comes back byte for byte.
    expect(displayedVoiceText(' うん。\n ')).toBe(' うん。\n ');
  });

  it('gives the ElevenLabs voice only the listed tags, three at most, and a bracketed word without its brackets', () => {
    expect(elevenVoiceText('ねえ、[Whispers] これは内緒だよ。')).toBe('ねえ、 [whispers] これは内緒だよ。');
    expect(elevenVoiceText('[smiles] [sighs] 疲れた。')).toBe('[sighs] 疲れた。');
    expect(elevenVoiceText('[sighs][sighs][sighs][sighs] 疲れた。')).toBe('[sighs] [sighs] [sighs] 疲れた。');
    expect(elevenVoiceText('[Minebot] を見て。')).toBe('Minebot を見て。');
    expect(voiceAudioTagsIn('[long  pause] えっと [giggles]')).toEqual(['long pause', 'giggles']);
  });

  it('asks a whisper again after each 「、」 until another tag, as her voice needs on v4 Turbo', () => {
    expect(heldWhisper('[anime character] [whispers] ', 'これは内緒なんだけど、ボク、技を覚えたんだよ。'))
      .toBe('これは内緒なんだけど、[whispers] ボク、[whispers] 技を覚えたんだよ。');
    expect(heldWhisper('[anime character] ', 'ねえ、 [whispers] 内緒だけど、教えるね。[laughs] うそ、だよ。'))
      .toBe('ねえ、 [whispers] 内緒だけど、[whispers] 教えるね。[laughs] うそ、だよ。');
    expect(heldWhisper('[anime character] ', 'うん、いいよ。')).toBe('うん、いいよ。');
  });

  it('gives the Gemini voice no tag, and a Japanese direction for each after its style', () => {
    expect(geminiVoiceRequest('ねえ、[whispers] 内緒だよ。[laughs]', '明るく。')).toEqual({
      text: 'ねえ、内緒だよ。', style: '明るく。 途中からささやき声で、息を多めに、ごく小さく。途中で小さく笑う。',
    });
    expect(geminiVoiceRequest('うん。', '明るく。')).toEqual({ text: 'うん。', style: '明るく。' });
    expect(geminiVoiceRequest('[sighs] うん。', 'x'.repeat(499)).style).toHaveLength(500);
  });

  // 2026-10-26: the feelings that changed her voice when played (voiceAudioTags.ts); [shouts] still did not and stays out.
  it('keeps the feelings measured on her voice, for the voice only', () => {
    expect(elevenVoiceText('[crying] ごめんね。')).toBe('[crying] ごめんね。');
    expect(elevenVoiceText('ねえ、[mischievously] 内緒にしてあげる。')).toBe('ねえ、 [mischievously] 内緒にしてあげる。');
    expect(displayedVoiceText('[angry] だめ。')).toBe('だめ。');
    expect(geminiVoiceRequest('[worried] 大丈夫？', '明るく。')).toEqual({ text: '大丈夫？', style: '明るく。 途中から心配そうに。' });
    expect(elevenVoiceText('[shouts] だめ！')).toBe('だめ！');
  });

  it('carries a sentence that is only tags to the next sentence', () => {
    const tags = new VoiceSegmentTags();
    expect(tags.take('うん、いいよ。')).toEqual({ text: 'うん、いいよ。' });
    expect(tags.take('[laughs]')).toBeNull();
    expect(tags.take('[smiles]')).toBeNull();
    expect(tags.take('ほんとに？')).toEqual({ text: 'ほんとに？', voiceText: '[laughs] ほんとに？' });
    expect(tags.take('[Minebot] だよ。')).toEqual({ text: '[Minebot] だよ。', voiceText: 'Minebot だよ。' });
  });

  it('is in the voice prompt only with its switch on, naming every tag, and never the owner', () => {
    expect(voiceAudioTagsEnabled({})).toBe(false);
    expect(voiceAudioTagsEnabled({ SHANNON_VOICE_AUDIO_TAGS: 'on' })).toBe(true);
    expect(voiceConversationInstructions(true, false, true, true, false)).not.toContain('# Voice tags');
    const on = voiceConversationInstructions(true, false, true, true, true);
    expect(on).toContain(VOICE_AUDIO_TAG_LINES.join('\n'));
    for (const tag of Object.values(VOICE_AUDIO_TAGS).flat()) expect(on).toContain(`[${tag}]`);
    expect(on).not.toContain('ライ');
  });
});
