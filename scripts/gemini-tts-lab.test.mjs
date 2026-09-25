import assert from 'node:assert/strict';
import test from 'node:test';
import {
  audioBlockFromResponse,
  buildTTSRequest,
  buildVoiceDesignRequest,
  parseList,
  pcm16MonoWav,
  percentile,
  safeFileSegment,
  serverSentEvents,
  wavMetadata,
} from './gemini-tts-lab-core.mjs';

test('buildTTSRequest keeps transcript and style in separate fields', () => {
  const request = buildTTSRequest({
    model: 'gemini-3.8-flash-lite-tts',
    voice: 'Leda',
    text: 'こんにちは。',
    style: 'warm and friendly',
  });
  const content = request.input[0].content[0];
  assert.equal(content.text, 'こんにちは。');
  assert.equal(content.annotations[0].style, 'warm and friendly');
  assert.deepEqual(request.generation_config.speech_config, [{ voice: 'Leda' }]);
  assert.equal(request.response_format.mime_type, 'audio/wav');
});

test('buildTTSRequest rejects aliases before they reach the wire format', () => {
  assert.throws(
    () => buildTTSRequest({ model: 'lite', voice: 'Leda', text: 'こんにちは。' }),
    /Unsupported Gemini TTS model/u,
  );
});

test('buildVoiceDesignRequest uses the default creation model for persistent prompted voice design', () => {
  const request = buildVoiceDesignRequest({
    name: 'Shannon bright',
    prompt: 'A clear and warm Japanese voice.',
  });
  assert.equal(request.store, true);
  assert.equal(request.voice.type, 'prompted');
  assert.equal('model' in request.voice, false);
  assert.equal(request.voice.language_code, 'ja-JP');
  assert.equal(request.voice.gender, 'female');
});

test('audioBlockFromResponse supports direct and wrapped interaction responses', () => {
  const data = Buffer.from('RIFF').toString('base64');
  assert.deepEqual(audioBlockFromResponse({ output_audio: { data } }).audio, Buffer.from('RIFF'));
  assert.deepEqual(audioBlockFromResponse({ interaction: { output_audio: { data } } }).audio, Buffer.from('RIFF'));
  const steps = { interaction: { steps: [{ content: [{ type: 'audio', mime_type: 'audio/wav', data }] }] } };
  assert.deepEqual(audioBlockFromResponse(steps).audio, Buffer.from('RIFF'));
});

test('wavMetadata reads PCM duration and tolerates odd-sized chunks', () => {
  const audio = pcmWav({ sampleRate: 24_000, channels: 1, bitsPerSample: 16, dataBytes: 48_000 });
  const metadata = wavMetadata(audio);
  assert.equal(metadata.encoding, 1);
  assert.equal(metadata.sampleRate, 24_000);
  assert.equal(metadata.channels, 1);
  assert.equal(metadata.bitsPerSample, 16);
  assert.equal(metadata.durationMilliseconds, 1_000);
});

test('pcm16MonoWav wraps one second of 24 kHz PCM for playback', () => {
  const wav = pcm16MonoWav(Buffer.alloc(48_000));
  const metadata = wavMetadata(wav);
  assert.equal(metadata.durationMilliseconds, 1_000);
  assert.equal(metadata.dataBytes, 48_000);
});

test('percentile reports observed chunk boundaries without interpolation', () => {
  assert.equal(percentile([40, 10, 30, 20], 0.5), 20);
  assert.equal(percentile([40, 10, 30, 20], 0.95), 40);
  assert.equal(percentile([], 0.5), null);
});

test('serverSentEvents reassembles split SSE audio events', async () => {
  const event = { event_type: 'step.delta', delta: { type: 'audio', data: 'AAE=' } };
  const encoded = `event: step.delta\r\ndata: ${JSON.stringify(event)}\r\n\r\ndata: [DONE]\r\n\r\n`;
  const split = [Buffer.from(encoded.slice(0, 17)), Buffer.from(encoded.slice(17, 41)), Buffer.from(encoded.slice(41))];
  const values = [];
  for await (const value of serverSentEvents(split)) values.push(value);
  assert.deepEqual(values, [event]);
});

test('list and file helpers are deterministic', () => {
  assert.deepEqual(parseList(' Leda, Aoede ,, '), ['Leda', 'Aoede']);
  assert.equal(safeFileSegment('Gemini 3.8 / Leda'), 'gemini-3.8-leda');
});

function pcmWav({ sampleRate, channels, bitsPerSample, dataBytes }) {
  const formatSize = 16;
  const byteRate = sampleRate * channels * bitsPerSample / 8;
  const blockAlign = channels * bitsPerSample / 8;
  const totalSize = 12 + 8 + formatSize + 8 + dataBytes;
  const buffer = Buffer.alloc(totalSize);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(totalSize - 8, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(formatSize, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataBytes, 40);
  return buffer;
}
