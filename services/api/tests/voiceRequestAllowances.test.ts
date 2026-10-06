import { describe, expect, it } from 'vitest';
import { VoiceRequestAllowances } from '../src/infra/http/serverHttp.js';

describe('voice request allowances', () => {
  it('lets a multi-sentence reply finish after several turns without exhausting the control budget', () => {
    const allowances = new VoiceRequestAllowances();
    for (let turn = 0; turn < 4; turn += 1) {
      expect(allowances.consumeControl('owner-a')).toBe(true);
      expect(allowances.consumeControl('owner-a')).toBe(true);
      expect(allowances.consumeControl('owner-a')).toBe(true);
      for (let sentence = 0; sentence < 6; sentence += 1) {
        expect(allowances.consumeSpeech('owner-a')).toBe(true);
      }
    }
    expect(allowances.consumeSpeech('owner-a')).toBe(true);
    expect(allowances.consumeControl('owner-a')).toBe(true);
  });

  it('retains independent bounded limits for speech, control, and devices', () => {
    const allowances = new VoiceRequestAllowances();
    for (let count = 0; count < 60; count += 1) {
      expect(allowances.consumeSpeech('owner-a')).toBe(true);
    }
    expect(allowances.consumeSpeech('owner-a')).toBe(false);
    for (let count = 0; count < 30; count += 1) {
      expect(allowances.consumeControl('owner-a')).toBe(true);
    }
    expect(allowances.consumeControl('owner-a')).toBe(false);
    expect(allowances.consumeSpeech('owner-b')).toBe(true);
    expect(allowances.consumeControl('owner-b')).toBe(true);
  });
});
