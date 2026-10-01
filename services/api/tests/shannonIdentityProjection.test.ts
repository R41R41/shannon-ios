import { describe, expect, it } from 'vitest';
import { shannonCapabilityPrompt, shannonIdentityPrompt, shannonPersonaPrompt, shannonSuitePrompt } from '@shannon/cognition';
import { createLocalApiKernel } from '../src/apiKernel.js';
import type { ShannonChatModel, ShannonChatModelRequest, ShannonVoiceModelRequest } from '../src/chatModel.js';
import { temporaryGuestVoiceInstructions, voiceConversationInstructions } from '../src/voiceConversationInstructions.js';

class PromptRecorder implements ShannonChatModel {
  readonly mode = 'openai' as const;
  readonly model = 'test-model';
  readonly prompts: string[] = [];

  async generate(request: ShannonChatModelRequest) {
    this.prompts.push(request.systemPrompt);
    return { mode: this.mode, model: this.model, reply: '返答です。' };
  }

  async generateVoice(request: ShannonVoiceModelRequest) {
    this.prompts.push(request.systemPrompt);
    return { mode: this.mode, model: this.model, reply: '音声の返答です。' };
  }
}

async function promptFor(path: string, body: Record<string, unknown>): Promise<string> {
  const model = new PromptRecorder();
  const api = createLocalApiKernel(() => '2026-10-01T03:00:00.000Z', { chatModel: model });
  const result = await api.dispatch({ method: 'POST', path, body });
  expect(result.status).toBe(200);
  expect(model.prompts).toHaveLength(1);
  return model.prompts[0]!;
}

const voicePath = '/v1/voice/gemini/cascade/delegations';

describe('one Shannon across text and voice', () => {
  it('gives text chat the canonical persona, suite roles and capabilities', async () => {
    const prompt = await promptFor('/v1/chat', { scopeKey: 'owner-text', message: 'おはよう' });
    expect(prompt.startsWith(shannonIdentityPrompt('owner'))).toBe(true);
    expect(prompt).toContain('「ライ氏」と呼び');
    expect(prompt).toContain('ふざけずに真面目に向き合う');
  });

  it('keeps the identity on the slim owner voice path that drops owner state', async () => {
    const prompt = await promptFor(voicePath, { scopeKey: 'owner-slim', transcript: '聞こえる？' });
    expect(prompt.startsWith(shannonIdentityPrompt('owner'))).toBe(true);
    expect(prompt).not.toContain('[Shannon shared state v');
    expect(prompt).toContain('[Live voice conversation]');
  });

  it('uses the same identity when the voice turn loads memory', async () => {
    const prompt = await promptFor(voicePath, { scopeKey: 'owner-memory', transcript: '前に話した好みを覚えてる？' });
    expect(prompt.startsWith(shannonIdentityPrompt('owner'))).toBe(true);
    expect(prompt).toContain('[Shannon shared state v');
  });

  it('feeds text and voice the identical persona, suite and capability text', async () => {
    const text = await promptFor('/v1/chat', { scopeKey: 'owner-same-a', message: '何ができるの？' });
    const voice = await promptFor(voicePath, { scopeKey: 'owner-same-b', transcript: '何ができるの？' });
    for (const block of [shannonPersonaPrompt('owner'), shannonSuitePrompt(), shannonCapabilityPrompt('owner')]) {
      expect(text).toContain(block);
      expect(voice).toContain(block);
    }
  });

  it('keeps the character for a guest without ever telling her the speaker is the owner', async () => {
    const prompt = await promptFor(voicePath, {
      scopeKey: 'owner-guest', transcript: 'こんにちは、はじめまして', participantMode: 'guest',
    });
    expect(prompt.startsWith(shannonIdentityPrompt('guest'))).toBe(true);
    expect(prompt).toContain(temporaryGuestVoiceInstructions);
    expect(prompt).toContain('少しポンコツなメイドAI');
    expect(prompt).toContain('相手を「ライ氏」と呼ばない');
    // PP-07: no block may instruct her to address the current speaker as the owner.
    expect(prompt).not.toContain('「ライ氏」と呼び、');
    expect(prompt).not.toContain('address the owner as ライ氏');
    expect(prompt).toContain('do not address them as ライ氏');
    for (const privateBlock of ['Aether:', 'Voyager:', '開発作業', '記憶と約束', 'Codex implementation task']) {
      expect(prompt).not.toContain(privateBlock);
    }
  });
});

describe('voice delivery notes', () => {
  it('shape speech without redefining the character', () => {
    const owner = voiceConversationInstructions(true);
    expect(owner).toContain('# Spoken delivery');
    expect(owner).not.toMatch(/tsundere|tease|maid AI who|playfully challenging/iu);
    expect(owner).not.toContain('ライ');
    // The answering model is the backend: it must not promise a lookup it cannot make.
    expect(owner).toContain('You are the answering model for this turn');
    expect(owner).not.toMatch(/consult the backend|Always delegate|Use the client\/backend/u);
  });

  it('leaves the guest-specific rule unchanged', () => {
    expect(voiceConversationInstructions(true, false, false)).toContain(
      '- Keep the same lively maid personality, but do not assume any guest participant is ライ or identify speakers from their voices.',
    );
    expect(temporaryGuestVoiceInstructions).toContain('Do not identify, name, or distinguish speakers from their voices.');
  });
});
