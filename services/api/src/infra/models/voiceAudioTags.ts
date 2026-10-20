/**
 * The ElevenLabs audio tags her spoken reply may carry inside its sentences (owner 2026-10-20: 「可能なもの全部付けられるようにしたい。
 * ささやき声ができていなかった」). The reply model writes them where the delivery changes (`VOICE_AUDIO_TAG_LINES`); what is shown
 * and stored never has them (`displayedVoiceText`), the ElevenLabs voice keeps only these (`elevenVoiceText`), and the Gemini voice
 * hears none and gets a Japanese direction instead (`geminiVoiceRequest`).
 *
 * Played with her voice on eleven_v4_turbo (text-to-dialogue/stream-input, ja), 2026-10-20, against the same sentence without the
 * tag: each sound added 0.5–1.1 s of laughter, breath or a throat sound, a whisper took the pitch out of its clause, a pause doubled
 * or tripled the longest silence, [sleepy] was 7 dB quieter. [shouts] changed nothing (left out); [sweetly] and [nervously] were
 * the faintest (kept: they do no harm). Tags not listed here were not tried.
 */
export const VOICE_AUDIO_TAGS = Object.freeze({
  /** How the voice is produced. */
  voice: ['whispers', 'softly'],
  /** Sounds between or inside words. */
  sounds: ['laughs', 'giggles', 'chuckles', 'sighs', 'exhales', 'gasps', 'clears throat', 'yawns', 'gulps', 'sniffs', 'inhales deeply', 'hums'],
  /** A feeling for the words that follow. */
  feelings: ['sleepy', 'sweetly', 'excited', 'nervously', 'tearfully', 'pouting'],
  /** A silence. */
  pauses: ['short pause', 'long pause'],
} as const);

export type VoiceAudioTag = (typeof VOICE_AUDIO_TAGS)[keyof typeof VOICE_AUDIO_TAGS][number];

const ALLOWED: ReadonlySet<string> = new Set(Object.values(VOICE_AUDIO_TAGS).flat());

/** At most this many tags inside one sentence; more is noise, and the voice drifts. */
export const MAXIMUM_INLINE_TAGS = 3;

/** A bracketed ASCII phrase that is not a Markdown link: an audio tag, a stage direction, or a bracketed word. */
const BRACKETED = /\[([A-Za-z][A-Za-z ,'-]{0,38})\](?!\()/gu;

type Kind = 'allowed' | 'direction' | 'word';

const canonical = (inner: string) => inner.trim().toLowerCase().replace(/\s+/gu, ' ');

function kindOf(inner: string): Kind {
  if (ALLOWED.has(canonical(inner))) return 'allowed';
  // A lowercase phrase is a direction she made up (「[smiles]」): never shown, never spoken. 「[Minebot]」 is a word.
  return inner === inner.toLowerCase() ? 'direction' : 'word';
}

/**
 * The text with each bracketed phrase replaced: `null` drops it (with the spaces around it; one space stays only between two ASCII
 * words), a tag is set off by single spaces, a word keeps its place.
 */
function rewritten(text: string, replace: (inner: string, kind: Kind, allowedCount: number) => string | null): string {
  // A text without a bracketed phrase is returned as it came, byte for byte.
  if (!/\[[A-Za-z]/u.test(text)) return text;
  let result = '';
  let last = 0;
  let allowedCount = 0;
  let pendingSpace = false;
  const append = (part: string) => {
    if (!part) return;
    if (pendingSpace && result) result += /^\s/u.test(part) ? '' : ' ';
    pendingSpace = false;
    result += part;
  };
  for (const match of text.matchAll(BRACKETED)) {
    const kind = kindOf(match[1]!);
    if (kind === 'allowed') allowedCount += 1;
    const replacement = replace(match[1]!, kind, allowedCount);
    const before = text.slice(last, match.index);
    last = match.index! + match[0].length;
    if (kind === 'word' && replacement !== null) {
      append(before);
      append(replacement);
      continue;
    }
    append(before.replace(/\s+$/u, ''));
    const after = text.slice(last);
    if (replacement === null) {
      // 「OK [laughs] sure」 keeps a space; 「ねえ、[whispers] これ」 joins with none.
      // Right after a kept tag, its space stays.
      pendingSpace ||= /[A-Za-z0-9,.!?]$/u.test(result) && /^\s*[A-Za-z0-9]/u.test(after);
    } else {
      if (result) result += ' ';
      result += replacement;
      pendingSpace = true;
    }
    last += after.length - after.replace(/^\s+/u, '').length;
  }
  append(text.slice(last));
  return result.replace(/[ \t]{2,}/gu, ' ').trim();
}

/** What is shown and kept of her words: no audio tag and no made-up direction; a bracketed word stays as written. */
export function displayedVoiceText(text: string): string {
  return rewritten(text, (inner, kind) => (kind === 'word' ? `[${inner}]` : null));
}

/**
 * What the ElevenLabs voice is given: the allowed tags (at most `MAXIMUM_INLINE_TAGS`, in lowercase), no other direction, and a
 * bracketed word without its brackets (a bracket would make it a direction).
 */
export function elevenVoiceText(text: string): string {
  return rewritten(text, (inner, kind, count) => kind === 'word' ? inner
    : kind === 'allowed' && count <= MAXIMUM_INLINE_TAGS ? `[${canonical(inner)}]` : null);
}

/**
 * On eleven_v4_turbo a whisper lasts one clause, then her voice comes back (her voice, 2026-10-20: 58 % of the sounding frames
 * still had a pitch; asked again after each 「、」, 40 %). From where the sentence (or its acting tags) asks for it to the next
 * other tag, `[whispers]` is asked again after each 「、」.
 */
export function heldWhisper(actingTags: string, text: string): string {
  const start = actingTags.includes('[whispers]') ? 0 : text.indexOf('[whispers]');
  if (start < 0) return text;
  const whispered = text.slice(start);
  const next = whispered.slice(1).search(/\[(?!whispers\])/u);
  const end = next < 0 ? whispered.length : next + 1;
  const held = whispered.slice(0, end).replace(/、(?!\s*\[|\s*$)\s*/gu, '、[whispers] ');
  return `${text.slice(0, start)}${held}${whispered.slice(end)}`;
}

/** The allowed tags in a text, in order, lowercase. */
export function voiceAudioTagsIn(text: string): VoiceAudioTag[] {
  const tags: VoiceAudioTag[] = [];
  for (const match of text.matchAll(BRACKETED)) {
    if (kindOf(match[1]!) === 'allowed') tags.push(canonical(match[1]!) as VoiceAudioTag);
  }
  return tags;
}

/** The Gemini voice reads no tag: each becomes a short Japanese direction added to its style. */
const GEMINI_DIRECTIONS: Readonly<Record<VoiceAudioTag, string>> = Object.freeze({
  whispers: '途中からささやき声で、息を多めに、ごく小さく。', softly: '途中から声を落として、柔らかく。',
  laughs: '途中で小さく笑う。', giggles: '途中でくすくす笑う。', chuckles: '途中で喉の奥で短く笑う。',
  sighs: '途中で軽くため息をつく。', exhales: '途中でふっと息を吐く。', gasps: '途中で息をのむ。',
  'clears throat': '途中で小さく咳払いをする。', yawns: '途中であくびまじりに。', gulps: '途中でごくりと息をのむ。',
  sniffs: '途中で鼻をすする。', 'inhales deeply': '途中で深く息を吸う。', hums: '途中で小さく鼻歌まじりに。',
  sleepy: '眠そうに、ゆるく。', sweetly: '甘えた声で。', excited: 'わくわくと弾んで。', nervously: 'そわそわと落ち着かずに。',
  tearfully: '涙ぐんだ声で。', pouting: '口をとがらせて拗ねたように。',
  'short pause': '途中で短い間を置く。', 'long pause': '途中で長めの間を置く。',
});

/** The text and style for the Gemini voice: no tag in the text; what they asked for, in Japanese, after the style (500 characters at most). */
export function geminiVoiceRequest(text: string, style: string | undefined): { text: string; style: string | undefined } {
  const directions = [...new Set(voiceAudioTagsIn(text).map(tag => GEMINI_DIRECTIONS[tag]))].join('');
  const spoken = rewritten(text, (inner, kind) => (kind === 'word' ? inner : null));
  if (!directions) return { text: spoken, style };
  return { text: spoken, style: `${style ? `${style} ` : ''}${directions}`.slice(0, 500) };
}

/**
 * The sentences of one streamed reply, as sent: the shown text, and the voice's text when it differs. A sentence that is only tags
 * (「[laughs]」 after the last 「。」) shows nothing: its tags go before the next sentence, or nowhere when none follows.
 */
export class VoiceSegmentTags {
  private held = '';

  take(segment: string): { text: string; voiceText?: string } | null {
    const text = displayedVoiceText(segment);
    const voice = `${this.held}${segment}`;
    if (!text) {
      this.held = voiceAudioTagsIn(voice).map(tag => `[${tag}] `).join('');
      return null;
    }
    this.held = '';
    const voiceText = elevenVoiceText(voice);
    return voiceText !== text ? { text, voiceText } : { text };
  }
}

/**
 * How the reply model may use them: short, rare, and only the listed ones. In English like the other spoken-delivery lines; the tags
 * themselves stay English because the voice reads them.
 */
export const VOICE_AUDIO_TAG_LINES: readonly string[] = Object.freeze([
  '# Voice tags',
  '- Your words are spoken by an expressive voice. Where the delivery truly changes, you may put one of these tags, in square brackets and '
  + 'lowercase, right before the words it colours (also mid-sentence): '
  + `${[...VOICE_AUDIO_TAGS.voice, ...VOICE_AUDIO_TAGS.sounds, ...VOICE_AUDIO_TAGS.feelings, ...VOICE_AUDIO_TAGS.pauses].map(tag => `[${tag}]`).join(' ')}.`,
  '- Use them rarely: most replies have none, a few have one, never more than two in a reply. Choose the moment that earns it: '
  + '[whispers] for a secret or something said close and quietly, [softly] or [sweetly] for affection, [sleepy] or [yawns] late at night '
  + 'when drowsy, [laughs] or [giggles] when something is really funny, [sighs] for real relief or resignation, [gasps] for real surprise.',
  '- The tags are never shown or read as words. Do not write any other bracketed direction, and do not also write the sound as text '
  + 'right beside its tag (no 「（笑）」 next to [laughs]).',
]);
