export const CASCADE_EMOTIONS = Object.freeze({
  neutral: Object.freeze({ label: '自然体', style: '自然な会話の調子で、前後の文となめらかにつなげる。' }),
  bright: Object.freeze({ label: '明るく弾む', style: '声に笑顔を含め、明るく弾むテンポと軽やかな音程変化で話す。' }),
  proud: Object.freeze({ label: '得意げ', style: '自信たっぷりに歯切れよく、少し生意気で楽しげな得意顔が伝わるように話す。' }),
  flustered: Object.freeze({ label: '慌て・照れ', style: '一瞬テンポを乱し、強がりの奥から照れと慌てが漏れるように話す。' }),
  annoyed: Object.freeze({ label: '不満', style: '叫ばず、短く鋭い語尾と小気味よいテンポで不満を表す。' }),
  tender: Object.freeze({ label: '近く優しく', style: '声量を少し落とし、近く温かい声で素直な好意が伝わるように話す。' }),
  concerned: Object.freeze({ label: '心配', style: 'テンポを落とし、相手を気遣う真剣さと優しさを込めて話す。' }),
  sad: Object.freeze({ label: '繊細な悲しみ', style: '息をわずかに含め、崩れすぎない繊細な悲しみとして話す。' }),
});

export const CASCADE_EMOTION_IDS = Object.freeze(Object.keys(CASCADE_EMOTIONS));

const TAG_PATTERN = new RegExp(`^\\[\\[(${CASCADE_EMOTION_IDS.join('|')})\\]\\]`, 'u');
const ANY_TAG_PATTERN = /\[\[[a-z_-]+\]\]/giu;
const SENTENCE_END_PATTERN = /[。！？!?](?:[」』）】”"])?/u;

export function cascadeEmotionStyle(profileStyle, emotion) {
  const base = String(profileStyle ?? '').trim();
  const selected = CASCADE_EMOTIONS[emotion] ?? CASCADE_EMOTIONS.neutral;
  return `${base}${base ? ' ' : ''}${selected.style}`.slice(0, 500);
}

export function cascadeEmotionLabel(emotion) {
  return (CASCADE_EMOTIONS[emotion] ?? CASCADE_EMOTIONS.neutral).label;
}

export function takeCascadeSpeechSegments(value, { flush = false } = {}) {
  let pending = String(value ?? '').replace(/\r\n?/gu, '\n');
  const segments = [];

  while (pending.length > 0) {
    const leading = pending.match(/^\s+/u)?.[0] ?? '';
    pending = pending.slice(leading.length);
    if (!pending) break;

    if (!flush && /^\[\[[a-z_-]*$/iu.test(pending)) break;
    const tag = pending.match(TAG_PATTERN);
    const emotion = tag?.[1] ?? 'neutral';
    if (tag) pending = pending.slice(tag[0].length);

    const punctuation = pending.match(SENTENCE_END_PATTERN);
    const newline = pending.indexOf('\n');
    const punctuationEnd = punctuation?.index === undefined ? -1 : punctuation.index + punctuation[0].length;
    const boundary = newline >= 0 && (punctuationEnd < 0 || newline + 1 < punctuationEnd)
      ? newline + 1
      : punctuationEnd;

    if (boundary < 0) {
      if (!flush) {
        pending = `${tag?.[0] ?? ''}${pending}`;
        break;
      }
      const text = cleanCascadeSpeechText(pending);
      if (text) segments.push(Object.freeze({ emotion, text }));
      pending = '';
      break;
    }

    const text = cleanCascadeSpeechText(pending.slice(0, boundary));
    pending = pending.slice(boundary);
    if (text) segments.push(Object.freeze({ emotion, text }));
  }

  return Object.freeze({ segments: Object.freeze(segments), remainder: pending });
}

export function visibleCascadeResponseText(value) {
  return cleanCascadeSpeechText(String(value ?? '').replace(ANY_TAG_PATTERN, ' '));
}

export function streamedTextFromGeminiEvent(value) {
  const parts = value?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return '';
  return parts.map(part => typeof part?.text === 'string' ? part.text : '').join('');
}

function cleanCascadeSpeechText(value) {
  return String(value ?? '')
    .replace(ANY_TAG_PATTERN, ' ')
    .replace(/\s*\n\s*/gu, ' ')
    .replace(/[ \t]{2,}/gu, ' ')
    .trim();
}
