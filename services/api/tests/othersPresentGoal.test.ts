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
import { promptOf } from './modelPrompt.js';

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
    return promptOf(model.last);
  };
  const voice = async (transcript: string, companionPresent: boolean) => {
    const response = await api.dispatch({ method: 'POST', path: delegations, body: {
      scopeKey: 'owner', threadId: 'thread', transcript,
      deviceContext: { timeZoneIdentifier: 'Asia/Tokyo', requestedLocation: false, location: null, companionPresent,
        userUtterance: { id: `o-${model.all.length}`, text: transcript, source: 'speech', rawText: transcript } },
    } });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    await api.waitForBackground('owner');
    return promptOf(model.last);
  };
  const guest = async (transcript: string) => {
    const response = await api.dispatch({ method: 'POST', path: delegations, body: {
      scopeKey: 'owner', threadId: 'thread', transcript, participantMode: 'guest',
      deviceContext: { timeZoneIdentifier: 'Asia/Tokyo', requestedLocation: false, location: null,
        userUtterance: { id: `g-${model.all.length}`, text: transcript, source: 'speech', rawText: transcript,
          callContext: { callId: 'call-goal-0001', turns: [], introductionStart: true } } },
    } });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return promptOf(model.last);
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
    // Re-recorded on the body-1b branch (2026-10-06): her capability line about her body gained 「体は自分のもの。触れられ方は
    // 自分で受け取る。」 (Syzygy ADR-0005, owner answer 7), 22 characters of her identity (43c88ae5f79056f1 alone); and on the Mac
    // folder branch (2026-10-06, A18, owner approval) the `own_folder` line names the PC or the Mac, 33 more (6644836be1aa54fd
    // alone). Nothing else changed: with both lines as before, the fingerprint is f985777ad5061000 again. On the S3 branch
    // (A18 S3, owner approval) the `own_folder` line drops its note that the Mac's folder is only read: 81990bce01279119 with
    // the note. Recomputed after merging main 97b52985: unchanged. On the stage-2 branch (2026-10-06, owner decision "a") her
    // body line gained her temperament (9c61cf2910b8466e); with scope (a) it moved to her persona: 5776c6948507cd9c without it.
    expect(fingerprint(alone)).toBe('89239154af689e83');

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
    // Re-recorded on the prompt-cache branch (2026-10-06): the shared state now opens the turn's context, after the fixed
    // voice instructions (Syzygy ADR-0003 principle 4). Put back between her identity and those instructions, the same
    // text gives the fingerprint recorded before (9abf82a6f2f2e74f); nothing was added or left out.
    // Re-recorded on the body-1b branch (2026-10-06) for the same 22 characters of her capability line (911bc31030d3e769 alone),
    // and on the Mac folder branch for the 33 of the `own_folder` line (bb34c77bdba7c1ca alone); 1732f2014cc3eeb7 before both.
    // On the S3 branch (A18 S3) that line drops its note that the Mac's folder is only read: eabeaf61971fc368 with the note.
    // On the stage-2 branch (owner decision "a") the body line gained her temperament (74a4ca961d8d1a66); with scope (a) it
    // moved to her persona: 891f915e25710768 without it.
    expect(fingerprint(alone)).toBe('a3209b96faf9eff5');

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
