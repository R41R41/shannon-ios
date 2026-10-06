import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OpenAIVoicePreviewGateway, SQLiteVoiceIdentityStore } from '../src/surfaces/voice/voiceIdentity.js';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('SQLite voice identity store', () => {
  it('persists one scope choice without leaking it to another scope', () => {
    const directory = mkdtempSync(join(tmpdir(), 'shannon-voice-identity-'));
    directories.push(directory);
    const path = join(directory, 'shannon.sqlite');
    const first = new SQLiteVoiceIdentityStore(path, 'marin');
    expect(first.read('owner-a')).toEqual({
      mode: 'automatic', selectedVoice: null, effectiveVoice: 'marin', updatedAt: null,
    });
    first.save('owner-a', 'manual', 'coral', '2026-09-11T01:10:00.000Z');
    const previewAt = new Date('2026-09-11T01:10:00.000Z');
    expect(first.consumePreviewAllowance('owner-a', previewAt, 2)).toBe(true);
    expect(first.consumePreviewAllowance('owner-a', previewAt, 2)).toBe(true);
    expect(first.consumePreviewAllowance('owner-a', previewAt, 2)).toBe(false);
    expect(first.consumePreviewAllowance('owner-b', previewAt, 2)).toBe(true);
    const beforeJapanMidnight = new Date('2026-09-10T14:59:59.000Z');
    const afterJapanMidnight = new Date('2026-09-10T15:00:00.000Z');
    expect(first.consumePreviewAllowance('owner-c', beforeJapanMidnight, 1)).toBe(true);
    expect(first.consumePreviewAllowance('owner-c', beforeJapanMidnight, 1)).toBe(false);
    expect(first.consumePreviewAllowance('owner-c', afterJapanMidnight, 1)).toBe(true);
    first.close();

    const reopened = new SQLiteVoiceIdentityStore(path, 'marin');
    expect(reopened.read('owner-a')).toEqual({
      mode: 'manual', selectedVoice: 'coral', effectiveVoice: 'coral', updatedAt: '2026-09-11T01:10:00.000Z',
    });
    expect(reopened.read('owner-b')).toMatchObject({
      mode: 'automatic', selectedVoice: null, effectiveVoice: 'marin', updatedAt: null,
    });
    reopened.close();
  });
});

describe('OpenAI voice preview gateway', () => {
  it('keeps the key server-side and requests a bounded Japanese MP3 preview', async () => {
    const gateway = new OpenAIVoicePreviewGateway({
      apiKey: 'server-key-only',
      fetcher: async (input, init) => {
        expect(String(input)).toBe('https://api.openai.com/v1/audio/speech');
        expect(new Headers(init?.headers).get('authorization')).toBe('Bearer server-key-only');
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        expect(body).toMatchObject({
          model: 'gpt-4o-mini-tts', voice: 'cedar', response_format: 'mp3',
        });
        expect(String(body.input)).toContain('シャノン');
        return new Response(new Uint8Array([0x49, 0x44, 0x33, 0x04]), {
          status: 200,
          headers: { 'content-type': 'audio/mpeg' },
        });
      },
    });
    await expect(gateway.preview('cedar')).resolves.toEqual({
      audio: new Uint8Array([0x49, 0x44, 0x33, 0x04]),
      contentType: 'audio/mpeg',
    });
  });

  it('rejects a successful upstream response that is not MP3 audio', async () => {
    const gateway = new OpenAIVoicePreviewGateway({
      apiKey: 'server-key-only',
      fetcher: async () => new Response('{"error":"unexpected"}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    });
    await expect(gateway.preview('marin')).rejects.toMatchObject({ code: 'VOICE_PREVIEW_FAILED' });
  });
});
