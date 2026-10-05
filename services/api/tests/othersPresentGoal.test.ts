import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createLocalApiKernel } from '../src/apiKernel.js';
import { BackgroundUpdateCoordinator } from '../src/backgroundUpdates.js';
import type { ShannonChatModel, ShannonChatModelRequest, ShannonVoiceModelRequest } from '../src/chatModel.js';
import { InMemoryCognitiveIntentStore } from '../src/cognitiveIntent.js';
import { SQLiteShannonStore } from '../src/sqliteStore.js';

const at = '2026-10-06T03:00:00.000Z';
const delegations = '/v1/voice/gemini/cascade/delegations';
const GOAL = 'シャノンを一貫した人格として感じられるように改善したい。';
const MARKED_FRAME = '【機微:未分類・ライ氏だけが知っている】[Current intention frame';
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gu;
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

class RecordingModel implements ShannonChatModel {
  readonly mode = 'openai' as const;
  readonly model = 'test-model';
  readonly all: Array<ShannonChatModelRequest | ShannonVoiceModelRequest> = [];
  get last() { return this.all.at(-1)!; }
  async generate(request: ShannonChatModelRequest) {
    this.all.push(request);
    return { mode: this.mode, model: this.model, reply: '了解です。' };
  }
  async generateVoice(request: ShannonVoiceModelRequest) {
    this.all.push(request);
    return { mode: this.mode, model: this.model, reply: 'はい。' };
  }
}

/** The owner states a goal alone, then each path is asked the same follow-up. */
async function ownerStatedGoal() {
  const directory = mkdtempSync(join(tmpdir(), 'shannon-goal-'));
  directories.push(directory);
  const store = new SQLiteShannonStore({ path: join(directory, 'shannon.sqlite'), now: () => at });
  const model = new RecordingModel();
  const cognitiveIntents = new InMemoryCognitiveIntentStore();
  const api = createLocalApiKernel(() => at, {
    chatModel: model, stateStore: store, conversationStore: store, knowledgeStore: store, cognitiveIntents,
    background: new BackgroundUpdateCoordinator(store, store),
  });
  const chat = async (message: string, extra: Record<string, unknown> = {}) => {
    const response = await api.dispatch({ method: 'POST', path: '/v1/chat', body: { scopeKey: 'owner', threadId: 'thread', message, ...extra } });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    await api.waitForBackground('owner');
    return model.last.systemPrompt;
  };
  const voice = async (transcript: string, companionPresent: boolean) => {
    const response = await api.dispatch({ method: 'POST', path: delegations, body: {
      scopeKey: 'owner', threadId: 'thread', transcript,
      deviceContext: { timeZoneIdentifier: 'Asia/Tokyo', requestedLocation: false, location: null, companionPresent,
        userUtterance: { id: `o-${model.all.length}`, text: transcript, source: 'speech', rawText: transcript } },
    } });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    await api.waitForBackground('owner');
    return model.last.systemPrompt;
  };
  const guest = async (transcript: string) => {
    const response = await api.dispatch({ method: 'POST', path: delegations, body: {
      scopeKey: 'owner', threadId: 'thread', transcript, participantMode: 'guest',
      deviceContext: { timeZoneIdentifier: 'Asia/Tokyo', requestedLocation: false, location: null,
        userUtterance: { id: `g-${model.all.length}`, text: transcript, source: 'speech', rawText: transcript,
          callContext: { callId: 'call-goal-0001', turns: [], introductionStart: true } } },
    } });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return model.last.systemPrompt;
  };
  await chat(GOAL);
  const [intent] = cognitiveIntents.list('owner', 'active');
  expect(intent?.desiredOutcome).toBeTruthy();
  return { store, chat, voice, guest, goal: intent!.desiredOutcome };
}

const fingerprint = (prompt: string) => createHash('sha256').update(prompt.replace(UUID, 'ID')).digest('hex').slice(0, 16);

/** Every line that carries the intention frame begins with the marker; no line splits them. */
function expectMarkedFrame(prompt: string) {
  const lines = prompt.split('\n').filter(line => line.includes('[Current intention frame'));
  expect(lines).toHaveLength(1);
  expect(lines[0]!.startsWith(MARKED_FRAME)).toBe(true);
}

describe('the owner\'s current goal with other people present', () => {
  it('/v1/chat audience others: no current_goal, the frame marked on its own line', async () => {
    const { store, chat, goal } = await ownerStatedGoal();
    const alone = await chat('人格の改善はどう進める？');
    expect(alone).toContain(`current_goal=${goal}`);
    expect(alone).toContain('\n\n[Current intention frame');
    expect(alone).not.toContain('【機微:');
    expect(fingerprint(alone)).toBe('f985777ad5061000');

    const others = await chat('人格の改善はどう進める？', { audience: 'others' });
    expect(others).not.toContain('current_goal=');
    expectMarkedFrame(others);
    store.close();
  });

  it('owner voice with a companion present: no current_goal, the frame marked on its own line', async () => {
    const { store, voice, goal } = await ownerStatedGoal();
    const alone = await voice('前に話した人格の改善のこと覚えてる？', false);
    expect(alone).toContain(`current_goal=${goal}`);
    expect(alone).not.toContain('【機微:');
    expect(fingerprint(alone)).toBe('9abf82a6f2f2e74f');

    const companion = await voice('前に話した人格の改善のこと覚えてる？', true);
    expect(companion).toContain('[Current cognitive context');
    expect(companion).not.toContain('current_goal=');
    expectMarkedFrame(companion);
    store.close();
  });

  it('voice 友人も一緒 on a current client: no current_goal, the frame marked on its own line', async () => {
    const { store, guest } = await ownerStatedGoal();
    const prompt = await guest('前に話した人格の改善のこと覚えてる？');
    expect(prompt).toContain('[Current cognitive context');
    expect(prompt).not.toContain('current_goal=');
    expectMarkedFrame(prompt);
    store.close();
  });
});
