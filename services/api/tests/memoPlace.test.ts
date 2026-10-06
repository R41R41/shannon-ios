import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { InMemoryCompanionStateStore, SHANNON_MEMO_PLACE_RULE, shannonCapabilityPrompt } from '@shannon/cognition';
import type { AetherProposalInput, AetherProposalStore } from '../src/integrations/aether/aetherProposal.js';
import { FileAetherContextReader } from '../src/integrations/aether/aetherContext.js';
import { createLocalApiKernel } from '../src/infra/http/apiKernel.js';
import { createInMemoryAutonomyService } from '../src/mind/action/ownTime/autonomyService.js';
import { SQLiteAutonomyStore } from '../src/mind/action/ownTime/store/autonomyStore.js';
import type { ShannonChatModel, ShannonChatModelRequest, ShannonVoiceModelRequest } from '../src/infra/models/chatModel.js';
import { TOOLS_READ_ONLY_INSTRUCTIONS, TOOL_INSTRUCTIONS, VOICE_TOOL_INSTRUCTIONS, toolInstructions } from '../src/infra/models/chatModelTools.js';
import { asksAboutNotes } from '../src/mind/action/respond/conversationCapabilities.js';
import { executeConversationCommand } from '../src/mind/action/respond/conversationCommands.js';
import { InMemoryConversationStore } from '../src/mind/memory/store/conversationStore.js';
import type { HostFolderOperations, HostOperationRequest, HostRunOutcome } from '../src/mind/action/ownTime/hostFolderOperations.js';
import { aetherNoteRequest, answersWithPlace, asksForMemo, asksWhichPlace, memoNotForAether, memoRequestContent } from '../src/mind/action/respond/memoPlace.js';
import { ShannonToolRunner } from '../src/mind/tools/shannonToolRunner.js';
import { LocalVoiceDecisionGateway } from '../src/mind/selectors/voiceDecision.js';
import type { VoiceDecisionInput } from '../src/contracts/voiceDecisionContract.js';
import { promptOf } from './modelPrompt.js';

/**
 * Owner report (2026-10-05): 「メモを作って」 in a voice conversation went to Aether first. A memo has three places (her
 * study, her folder on his PC, Aether); unless his words or the talk just before make the place clear, she asks
 * 「書斎・PCのフォルダ・Aetherのどこに作りますか？」 and acts on the answer.
 */
const QUESTION = '書斎・PCのフォルダ・Aetherのどこに作りますか？';
const TRACE = '[さっきボクが道具でしたこと・見たこと]';
const start = Date.parse('2026-10-05T07:00:00.000Z');
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function proposals() {
  const sent: AetherProposalInput[] = [];
  const store: AetherProposalStore = { configured: true, create: (_scope, input) => {
    sent.push(input); return { id: `note-${sent.length}`, operation: 'new-note', title: '保存案', content: input.content, reason: input.reason ?? '', createdAt: new Date(start).toISOString() };
  } };
  return { sent, store };
}

describe('the place of a memo, by his words', () => {
  it('sends to Aether only what names Aether', () => {
    for (const words of ['メモを作って', '明日10時に歯医者ってメモして', 'これをノートにして', 'さっきの話をメモに残して', 'ノートに残して', '書斎にメモして', 'フォルダにメモ作って']) {
      expect(aetherNoteRequest(words), words).toBeNull();
    }
    expect(aetherNoteRequest('さっきの話をAetherに残して')).toEqual({ content: 'さっきの話' });
    expect(aetherNoteRequest('「旅行の計画」をAetherのノートに保存して')).toEqual({ content: '旅行の計画' });
    expect(aetherNoteRequest('旅行の写真をノートアプリに入れて')).toEqual({ content: '旅行の写真' });
    expect(aetherNoteRequest('エーテルに牛乳を買うってメモして')).toEqual({ content: '牛乳を買う' });
    expect(aetherNoteRequest('Aetherにメモして')).toEqual({ bare: 'request' });
    // Alone, only as the answer to her question where (conversationCommands.ts).
    expect(aetherNoteRequest('Aetherでお願いします')).toEqual({ bare: 'answer' });
    expect(memoRequestContent('明日10時に歯医者ってメモして')).toBe('明日10時に歯医者');
    expect(memoRequestContent('メモを作って')).toBe('');
    expect(asksWhichPlace(`いいですよ。${QUESTION}`)).toBe(true);
    expect(asksWhichPlace('書斎のメモ、どこまで読みました？')).toBe(false);
  });

  it('takes as an answer only a place name with に／で／お願い／します, never a no or a question (review 2)', () => {
    for (const words of ['書斎に', 'フォルダで', 'PCのフォルダにお願いします', 'Aetherに', 'エーテルでお願い', '書斎にします。']) expect(answersWithPlace(words), words).toBe(true);
    for (const words of ['書斎はやめて', 'Aetherに入れないで', 'PCのフォルダって何？', '書斎じゃなくて', '書斎でいい', 'Aetherに？', 'うーん、やっぱりいいや']) {
      expect(answersWithPlace(words), words).toBe(false);
      expect(aetherNoteRequest(words), words).toBeNull();
    }
  });

  it('knows colloquial requests, and a question or a word about an existing note is not a plain memo request (review 3)', () => {
    for (const words of ['メモっといて', 'メモお願い', '牛乳のことメモよろしく', 'メモ作ってくれる？', 'ノートに残して']) expect(asksForMemo(words), words).toBe(true);
    expect(memoRequestContent('牛乳を買うってメモっといて')).toBe('牛乳を買う');
    expect(asksForMemo('ノートに書いて？')).toBe(false);
    for (const words of ['前のノートに書いてあったことをメモして', 'この前のメモをまとめてノートに残して', 'ノートの内容をメモして', 'ノートに書いて？']) {
      expect(memoNotForAether(words), words).toBe(false);
      expect(asksAboutNotes(words), words).toBe(true);
    }
    expect(memoNotForAether('名前のメモを作って')).toBe(true);
  });

  it('runs no Aether command for an unqualified memo, keeps the explicit ones, and acts on 「Aetherに」 as the answer', () => {
    const conversationStore = new InMemoryConversationStore();
    const stateStore = new InMemoryCompanionStateStore(() => new Date(start).toISOString());
    const { sent, store } = proposals();
    const run = (text: string, at = start + 60_000) => executeConversationCommand('owner', 't', { id: `u-${text}`, text }, new Date(at).toISOString(),
      { stateStore, conversationStore, aetherProposals: store });
    expect(run('メモを作って')).toBeNull();
    expect(run('明日10時に歯医者ってメモして')).toBeNull();
    expect(run('Aetherに')).toBeNull();
    conversationStore.appendTurn('owner', 't', '明日10時に歯医者ってメモして', `わかりました。${QUESTION}`, new Date(start).toISOString());
    expect(run('書斎に')).toBeNull();
    expect(run('Aetherに', start + 11 * 60_000)).toBeNull();
    expect(run('Aetherにお願いします')?.receipt).toMatchObject({ capability: 'aether.propose', status: 'proposed' });
    expect(sent.at(-1)?.content).toBe('明日10時に歯医者');
    expect(run('「牛乳を買う」をAetherのノートに保存して')?.receipt?.capability).toBe('aether.propose');
    expect(sent.at(-1)?.content).toBe('牛乳を買う');
    // The question answered with nothing to keep: she asks for the words and sends nothing.
    conversationStore.appendTurn('owner', 't', 'メモを作って', QUESTION, new Date(start + 2 * 60_000).toISOString());
    expect(run('Aetherに', start + 3 * 60_000)?.receipt).toBeUndefined();
    expect(sent).toHaveLength(2);
    // What to keep was his turn before the request: one more turn of his, as bound as the request itself.
    conversationStore.appendTurn('owner', 't', '金曜は燃えないゴミの日', 'そうなんですね。', new Date(start + 4 * 60_000).toISOString());
    conversationStore.appendTurn('owner', 't', 'それメモして', QUESTION, new Date(start + 5 * 60_000).toISOString());
    expect(run('Aetherに', start + 6 * 60_000)?.receipt?.capability).toBe('aether.propose');
    expect(sent.at(-1)?.content).toBe('金曜は燃えないゴミの日');
    // A question or a request is not something to keep.
    conversationStore.appendTurn('owner', 't', '明日の天気はどう？ってメモして', QUESTION, new Date(start + 7 * 60_000).toISOString());
    expect(run('Aetherに', start + 8 * 60_000)?.receipt).toBeUndefined();
    expect(sent).toHaveLength(3);
  });

  it('pushes nothing of Aether at a memo request that does not name it', () => {
    const directory = mkdtempSync(join(tmpdir(), 'shannon-memo-place-'));
    directories.push(directory);
    const file = join(directory, 'context.json');
    writeFileSync(file, JSON.stringify({ version: 1, source: 'aether-ios', sharedAt: '2026-10-01T00:00:00.000Z', notes: [
      { id: 'design', title: 'Shannonの設計', excerpt: '感情と記憶', updatedAt: '2026-10-01T00:00:00.000Z', tags: [], type: 'design', status: 'growing' }] }), { mode: 0o600 });
    const reader = new FileAetherContextReader(file);
    expect(reader.promptFor('owner', 'メモを作って')).toBe('');
    expect(reader.promptFor('owner', 'Aetherのメモを見せて')).toContain('Shannonの設計');
    expect(reader.promptFor('owner', 'ノートに書いてあったこと覚えてる？')).toContain('Shannonの設計');
    // A memo that also asks about a note he wrote keeps the notes in front of her (review 3).
    expect(reader.promptFor('owner', '前のノートに書いてあったことをメモして')).toContain('Shannonの設計');
    expect(reader.promptFor('owner', 'ノートに書いて？')).toContain('Shannonの設計');
    expect(asksAboutNotes('メモを作って')).toBe(false);
    expect(asksAboutNotes('Aetherにメモして')).toBe(true);
  });

  it('carries the one rule in the instructions of her tools, text and voice, and in her capability text for the owner', () => {
    expect(SHANNON_MEMO_PLACE_RULE).toContain(`「${QUESTION}」`);
    expect(TOOL_INSTRUCTIONS).toContain(SHANNON_MEMO_PLACE_RULE);
    expect(VOICE_TOOL_INSTRUCTIONS).toContain(SHANNON_MEMO_PLACE_RULE);
    expect(shannonCapabilityPrompt('owner')).toContain(SHANNON_MEMO_PLACE_RULE);
    expect(shannonCapabilityPrompt('guest')).not.toContain(SHANNON_MEMO_PLACE_RULE);
    expect(shannonCapabilityPrompt('owner')).not.toContain('「〜をノートに残して」');
  });
});

/** Her body on the owner's PC: answers every folder operation at once. */
function fakeDevice() {
  const operations: HostOperationRequest[] = [];
  const device = { boundHosts: () => ['desk'], async run(_scopeKey: string, request: HostOperationRequest): Promise<HostRunOutcome> {
    operations.push(request);
    return { kind: 'done', result: request.operation === 'list' ? { truncated: false, entries: [{ path: 'notes', type: 'folder', modifiedAt: '2026-10-04T10:00:00.000Z' }] } : {} };
  } };
  return { device: device as unknown as HostFolderOperations, operations };
}

/** A model that calls what the words name, asks where when they name nothing, and records what it was given. */
class PlacingModel implements ShannonChatModel {
  readonly mode = 'openai' as const;
  readonly model = 'test-model';
  readonly requests: Array<ShannonChatModelRequest | ShannonVoiceModelRequest> = [];
  readonly calls: string[] = [];
  async generate(request: ShannonChatModelRequest) { return this.answer(request); }
  async generateVoice(request: ShannonVoiceModelRequest) { return this.answer(request); }
  private async answer(request: ShannonChatModelRequest | ShannonVoiceModelRequest) {
    this.requests.push(request);
    const call: [string, Record<string, unknown>] | null = !request.tools ? null
      : request.message.includes('何がある') ? ['folder_list', {}]
        : request.message.includes('書斎') ? ['study_create', { kind: 'note', title: '買い物', body: '牛乳を買う' }]
          : request.message.includes('フォルダ') ? ['folder_create', { path: 'memo.md', content: '牛乳を買う' }] : null;
    if (call && request.tools!.definitions.some(tool => tool.name.replace('.', '_') === call[0])) {
      this.calls.push(call[0]);
      expect(JSON.parse(await request.tools!.call(call[0], JSON.stringify(call[1]))).ok).toBe(true);
    }
    return { mode: this.mode, model: this.model, reply: asksForMemo(request.message) && !/書斎|フォルダ/u.test(request.message) ? QUESTION : 'はい。' };
  }
}

function harness(score?: number | ((transcript: string) => number)) {
  const clock = { at: start };
  const now = () => new Date(clock.at).toISOString();
  const store = new SQLiteAutonomyStore(':memory:');
  const autonomy = createInMemoryAutonomyService(now, { store });
  const { device, operations } = fakeDevice();
  (autonomy as { tools: ShannonToolRunner }).tools = new ShannonToolRunner(store, device, autonomy, now);
  const model = new PlacingModel();
  const aether = proposals();
  const local = new LocalVoiceDecisionGateway();
  const voiceDecision = score === undefined ? undefined
    : { mode: local.mode, model: local.model, async decide(input: VoiceDecisionInput) { return { ...await local.decide(input), transcriptReliabilityProbability: typeof score === 'number' ? score : score(input.transcript) }; } };
  const api = createLocalApiKernel(now, { chatModel: model, autonomy, aetherProposals: aether.store, ...(voiceDecision ? { voiceDecision } : {}) });
  const say = async (transcript: string) => {
    clock.at += 30_000;
    const delegated = await api.dispatch({ method: 'POST', path: '/v1/voice/gemini/cascade/delegations', body: { scopeKey: 'owner', threadId: 'talk', transcript,
      deviceContext: { timeZoneIdentifier: 'Asia/Tokyo', requestedLocation: false, location: null,
        userUtterance: { id: `u-${clock.at}`, text: transcript, source: 'speech', rawText: transcript } } } });
    expect(delegated.status).toBe(200);
    const body = delegated.body as { reply?: string; receipt?: { capability?: string } };
    const stored = await api.dispatch({ method: 'POST', path: '/v1/voice/gemini/cascade/turns', body: {
      scopeKey: 'owner', threadId: 'talk', userTranscript: transcript, shannonTranscript: String(body.reply) } });
    expect(stored.status).toBe(201);
    return { request: model.requests.at(-1)!, body, requests: model.requests.length };
  };
  const chat = async (message: string) => {
    clock.at += 30_000;
    const response = await api.dispatch({ method: 'POST', path: '/v1/chat', body: { scopeKey: 'owner', threadId: 'talk', message } });
    expect(response.status).toBe(200);
    return { request: model.requests.at(-1)!, body: response.body as { receipt?: { capability?: string } } };
  };
  /** A spoken turn stored as the body stores it, here with someone else present. */
  const heard = async (userTranscript: string, shannonTranscript: string) => {
    clock.at += 30_000;
    expect((await api.dispatch({ method: 'POST', path: '/v1/voice/gemini/cascade/turns', body: {
      scopeKey: 'owner', threadId: 'talk', userTranscript, shannonTranscript, companionPresent: true } })).status).toBe(201);
  };
  return { say, chat, heard, model, operations, sent: aether.sent };
}

describe('the place of a memo, in a conversation', () => {
  it('asks where for an unqualified 「メモを作って」 in voice: her tools and the rule are in front of her, Aether is not', async () => {
    const { say, sent } = harness(0.95);
    const asked = await say('メモを作って');
    expect(asked.body.receipt).toBeUndefined();
    expect(asked.body.reply).toBe(QUESTION);
    expect(asked.request.tools?.definitions.map(tool => tool.name)).toEqual(expect.arrayContaining(['study.create', 'folder.create']));
    expect(toolInstructions(asked.request.tools!, true)).toContain(SHANNON_MEMO_PLACE_RULE);
    expect(promptOf(asked.request)).toContain(SHANNON_MEMO_PLACE_RULE);
    expect(promptOf(asked.request)).toContain('Selected capabilities: none.');
    expect(sent).toHaveLength(0);
  });

  it('goes straight to the place he names: 書斎 and フォルダ to her tools, Aether to its inbox', async () => {
    const { say, model, operations, sent } = harness(0.95);
    expect((await say('書斎にメモして、牛乳を買う')).body.receipt).toBeUndefined();
    expect((await say('フォルダにメモ作って、牛乳を買う')).body.receipt).toBeUndefined();
    expect(model.calls).toEqual(['study_create', 'folder_create']);
    expect(operations.map(operation => operation.operation)).toEqual(['create']);
    await say('明日10時に歯医者');
    const before = model.requests.length;
    const aether = await say('Aetherにメモして');
    expect(aether.body.receipt?.capability).toBe('aether.propose');
    expect(model.requests).toHaveLength(before);
    expect(sent.map(item => item.content)).toEqual(['明日10時に歯医者']);
  });

  it('takes his answer to her question as the yes of a spoken write without a reliability score: 書斎 to her tools, Aether to its inbox (review 4)', async () => {
    const { say, model, sent } = harness();
    const asked = await say('メモを作って');
    expect(asked.request.tools?.writesWithheld).toBe(true);
    const answer = await say('書斎に');
    expect(answer.request.tools?.writesWithheld).toBeUndefined();
    expect(model.calls).toEqual(['study_create']);
    expect((await say('明日10時に歯医者ってメモして')).body.reply).toBe(QUESTION);
    const before = model.requests.length;
    const aether = await say('Aetherに');
    expect(aether.body.receipt?.capability).toBe('aether.propose');
    expect(model.requests).toHaveLength(before);
    expect(sent.map(item => item.content)).toEqual(['明日10時に歯医者']);
  });

  it('unlocks nothing for a no or a question, and with words that cannot be trusted sends nothing and says so (reviews 2 and 4)', async () => {
    const { say, sent } = harness(transcript => (transcript.startsWith('Aether') ? 0.4 : 0.95));
    expect((await say('明日10時に歯医者ってメモして')).body.reply).toBe(QUESTION);
    const uncertain = await say('Aetherに');
    expect(uncertain.body.receipt).toBeUndefined();
    expect(uncertain.request.tools?.writesWithheld).toBe(true);
    expect(toolInstructions(uncertain.request.tools!, true)).toContain('Aetherへの保存案もこの返事では送っていないので、送ったと言わない');
    expect(TOOLS_READ_ONLY_INSTRUCTIONS).toContain('送ったと言わない');
    expect(sent).toHaveLength(0);
    const unscored = harness();
    for (const words of ['書斎はやめて', 'Aetherに入れないで', 'PCのフォルダって何？']) {
      expect((await unscored.say('牛乳を買うってメモして')).body.reply).toBe(QUESTION);
      const no = await unscored.say(words);
      expect(no.body.receipt, words).toBeUndefined();
      expect(no.request.tools?.writesWithheld, words).toBe(true);
    }
    expect(unscored.model.calls).toEqual([]);
    expect(unscored.sent).toHaveLength(0);
  });

  it('sends nothing when the words before her question were a guest\'s, though the owner answers 「Aetherに」 (review 1)', async () => {
    const { say, heard, sent } = harness(0.95);
    await heard('明日10時に歯医者ってメモして', QUESTION);
    const answer = await say('Aetherに');
    expect(answer.body.receipt).toBeUndefined();
    expect(answer.body.reply).toContain('まだ何も送っていません');
    expect(sent).toHaveLength(0);
  });

  it('after a talk about her folder, gives her that talk and her tools for the next 「メモを作って」, and no Aether', async () => {
    const { say, chat, sent } = harness(0.95);
    await say('自分のフォルダに何があるか見て');
    const next = await say('メモを作って');
    expect(promptOf(next.request)).toContain(TRACE);
    expect(promptOf(next.request)).toContain('folder.list → できた');
    expect(next.request.tools?.definitions.some(tool => tool.name === 'folder.create')).toBe(true);
    expect(promptOf(next.request)).not.toContain('[Notes]');
    // Typed, the same: no command, the rule and the trace in front of her.
    const typed = await chat('メモを作って');
    expect(typed.body.receipt).toBeUndefined();
    expect(promptOf(typed.request)).toContain('folder.list → できた');
    expect(toolInstructions(typed.request.tools!, false)).toContain(SHANNON_MEMO_PLACE_RULE);
    expect(sent).toHaveLength(0);
  });
});
