import { createHash } from 'node:crypto';

export const GEMINI_TTS_MODELS = Object.freeze([
  'gemini-3.8-flash-tts',
  'gemini-3.8-flash-lite-tts',
]);

export const DEFAULT_VOICES = Object.freeze(['Zephyr', 'Leda', 'Aoede', 'Achernar']);

export const LAB_SCRIPTS = Object.freeze({
  identity: 'こんにちは、シャノンです。今日も一緒に、ゆっくり考えていこうね。',
  pronunciation: 'AetherとVoyager、それからSyzygyの進み具合を確認したよ。APIとSwiftUIの接続も大丈夫。',
  emotion: 'えへへ、うれしい。<short pause> でも、無理しすぎないでね。',
  long: 'おかえりなさい。今日はどんな一日だった？ うまく言葉にできなくても大丈夫。少しずつ、一緒に整理していこう。',
});

export const STYLE_PRESETS = Object.freeze({
  plain: '',
  warm: 'warm, friendly, reassuring, and natural',
  bright: 'lightly bright, affectionate, and charming without sounding childish',
  calm: 'calm, gentle, intimate, and unhurried',
});

export const DESIGN_PRESETS = Object.freeze({
  'shannon-bright': 'A young adult Japanese woman with a clear, lightly bright voice, gentle warmth, delicate expressive detail, and an affectionate conversational presence. Charming and lively without sounding childish or exaggerated.',
  'shannon-warm': 'A young adult Japanese woman with a soft, warm, close conversational voice, natural breath and cadence, and a reassuring companion-like presence. Friendly and emotionally expressive without becoming theatrical.',
  'shannon-calm': 'A young adult Japanese woman with a calm, clear, slightly airy voice, composed pacing, and quiet emotional intelligence. Gentle and intimate while remaining articulate and grounded.',
});

export function buildTTSRequest({ model, voice, text, style = '' }) {
  assertModel(model);
  const normalizedVoice = requiredText(voice, 'voice', 200);
  const normalizedText = requiredText(text, 'text', 20_000);
  const normalizedStyle = optionalText(style, 'style', 500);
  return {
    model,
    input: [{
      type: 'user_input',
      content: [{
        type: 'text',
        text: normalizedText,
        annotations: [{ type: 'speech_metadata', style: normalizedStyle }],
      }],
    }],
    response_format: { type: 'audio', mime_type: 'audio/wav', sample_rate: 24_000 },
    generation_config: { speech_config: [{ voice: normalizedVoice }] },
  };
}

export function buildVoiceDesignRequest({ model, name, prompt, language = 'ja-JP', gender = 'female' }) {
  assertModel(model);
  return {
    store: true,
    voice: {
      model,
      type: 'prompted',
      display_name: requiredText(name, 'name', 100),
      gender: requiredChoice(gender, 'gender', ['female', 'male', 'neutral']),
      language_code: requiredText(language, 'language', 35),
      prompted: { input: requiredText(prompt, 'prompt', 1_000) },
    },
  };
}

export function audioBlockFromResponse(value) {
  const root = isRecord(value?.interaction) ? value.interaction : value;
  const block = root?.output_audio;
  if (!isRecord(block) || typeof block.data !== 'string' || !block.data) {
    throw new Error('Gemini response did not contain output_audio.data');
  }
  const audio = Buffer.from(block.data, 'base64');
  if (!audio.length) throw new Error('Gemini returned an empty audio payload');
  return { audio, mimeType: typeof block.mime_type === 'string' ? block.mime_type : 'audio/wav' };
}

export function voiceSampleFromResponse(value) {
  const block = value?.sample_audio;
  if (!isRecord(block) || typeof block.data !== 'string' || !block.data) {
    throw new Error('Gemini response did not contain sample_audio.data');
  }
  const audio = Buffer.from(block.data, 'base64');
  if (!audio.length) throw new Error('Gemini returned an empty voice preview');
  return { audio, mimeType: typeof block.mime_type === 'string' ? block.mime_type : 'audio/wav' };
}

export function wavMetadata(audio) {
  if (audio.length < 44 || audio.toString('ascii', 0, 4) !== 'RIFF' || audio.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Audio payload is not a RIFF/WAVE file');
  }
  let offset = 12;
  let format;
  let dataBytes;
  while (offset + 8 <= audio.length) {
    const id = audio.toString('ascii', offset, offset + 4);
    const size = audio.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (body + size > audio.length) throw new Error(`Invalid WAV ${id} chunk length`);
    if (id === 'fmt ' && size >= 16) {
      format = {
        encoding: audio.readUInt16LE(body),
        channels: audio.readUInt16LE(body + 2),
        sampleRate: audio.readUInt32LE(body + 4),
        byteRate: audio.readUInt32LE(body + 8),
        bitsPerSample: audio.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      dataBytes = size;
    }
    offset = body + size + (size % 2);
  }
  if (!format || dataBytes === undefined || format.byteRate <= 0) {
    throw new Error('WAV file is missing usable format or data metadata');
  }
  return {
    ...format,
    dataBytes,
    durationMilliseconds: Math.round((dataBytes / format.byteRate) * 1_000),
  };
}

export function pcm16MonoWav(pcm, sampleRate = 24_000) {
  if (!Buffer.isBuffer(pcm)) throw new Error('PCM input must be a Buffer');
  if (!Number.isInteger(sampleRate) || sampleRate < 8_000 || sampleRate > 192_000) {
    throw new Error('sampleRate must be an integer between 8000 and 192000');
  }
  const header = Buffer.alloc(44);
  const byteRate = sampleRate * 2;
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export function percentile(values, fraction) {
  if (!Array.isArray(values) || !values.length) return null;
  if (!Number.isFinite(fraction) || fraction < 0 || fraction > 1) throw new Error('percentile fraction must be between 0 and 1');
  const sorted = values.map(Number).filter(Number.isFinite).sort((left, right) => left - right);
  if (!sorted.length) return null;
  return sorted[Math.ceil(fraction * sorted.length) - 1] ?? sorted[0];
}

export async function* serverSentEvents(stream) {
  const decoder = new TextDecoder();
  let pending = '';
  for await (const bytes of stream) {
    pending += decoder.decode(bytes, { stream: true }).replace(/\r\n/gu, '\n');
    let boundary;
    while ((boundary = pending.indexOf('\n\n')) >= 0) {
      const block = pending.slice(0, boundary);
      pending = pending.slice(boundary + 2);
      const data = block.split('\n')
        .filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).trimStart())
        .join('\n');
      if (!data || data === '[DONE]') continue;
      try {
        yield JSON.parse(data);
      } catch {
        throw new Error('Gemini returned malformed streaming event data');
      }
    }
  }
  pending += decoder.decode();
  if (pending.trim() && !pending.includes('[DONE]')) throw new Error('Gemini stream ended with an incomplete event');
}

export function parseList(value, fallback = []) {
  if (value === undefined) return [...fallback];
  return String(value).split(',').map(item => item.trim()).filter(Boolean);
}

export function safeFileSegment(value) {
  const safe = String(value).trim().toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 80);
  return safe || 'sample';
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function resolveScript(name, customText) {
  if (customText !== undefined) return requiredText(customText, 'text', 20_000);
  const script = LAB_SCRIPTS[name ?? 'identity'];
  if (!script) throw new Error(`Unknown script preset: ${name}`);
  return script;
}

export function resolveStyle(name, customStyle) {
  if (customStyle !== undefined) return optionalText(customStyle, 'style', 500);
  const style = STYLE_PRESETS[name ?? 'plain'];
  if (style === undefined) throw new Error(`Unknown style preset: ${name}`);
  return style;
}

function assertModel(model) {
  if (!GEMINI_TTS_MODELS.includes(model)) throw new Error(`Unsupported Gemini TTS model: ${model}`);
}

function requiredText(value, name, maximumLength) {
  const normalized = String(value ?? '').trim();
  if (!normalized || normalized.length > maximumLength) throw new Error(`${name} must be 1-${maximumLength} characters`);
  return normalized;
}

function optionalText(value, name, maximumLength) {
  const normalized = String(value ?? '').trim();
  if (normalized.length > maximumLength) throw new Error(`${name} must be at most ${maximumLength} characters`);
  return normalized;
}

function requiredChoice(value, name, choices) {
  if (!choices.includes(value)) throw new Error(`${name} must be one of: ${choices.join(', ')}`);
  return value;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
