import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { InMemoryCompanionStateStore, SHANNON_MEMO_PLACE_RULE, shannonCapabilityPrompt } from '@shannon/cognition';
import type { AetherProposalInput, AetherProposalStore } from '../src/aetherProposal.js';
import { FileAetherContextReader } from '../src/aetherContext.js';
import { createLocalApiKernel } from '../src/apiKernel.js';
import { createInMemoryAutonomyService } from '../src/autonomyService.js';
import { SQLiteAutonomyStore } from '../src/autonomyStore.js';
import type { ShannonChatModel, ShannonChatModelRequest, ShannonVoiceModelRequest } from '../src/chatModel.js';
import { TOOL_INSTRUCTIONS, VOICE_TOOL_INSTRUCTIONS, toolInstructions } from '../src/chatModelTools.js';
import { asksAboutNotes } from '../src/conversationCapabilities.js';
import { executeConversationCommand } from '../src/conversationCommands.js';
import { InMemoryConversationStore } from '../src/conversationStore.js';
import type { HostFolderOperations, HostOperationRequest, HostRunOutcome } from '../src/hostFolderOperations.js';
import { aetherNoteRequest, asksWhichPlace, memoRequestContent, namesMemoPlace } from '../src/memoPlace.js';
import { ShannonToolRunner } from '../src/shannonToolRunner.js';
import { LocalVoiceDecisionGateway } from '../src/voiceDecision.js';
import type { VoiceDecisionInput } from '../src/voiceDecisionContract.js';

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
    expect(['書斎に', 'フォルダで', 'PCのフォルダにお願い', 'Aetherに'].every(namesMemoPlace)).toBe(true);
    expect(namesMemoPlace('うーん、やっぱりいいや')).toBe(false);
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
    return { mode: this.mode, model: this.model, reply: request.message.includes('メモを作って') ? QUESTION : 'はい。' };
  }
}

function harness(score?: number) {
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
    : { mode: local.mode, model: local.model, async decide(input: VoiceDecisionInput) { return { ...await local.decide(input), transcriptReliabilityProbability: score }; } };
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
  return { say, chat, model, operations, sent: aether.sent };
}

describe('the place of a memo, in a conversation', () => {
  it('asks where for an unqualified 「メモを作って」 in voice: her tools and the rule are in front of her, Aether is not', async () => {
    const { say, sent } = harness(0.95);
    const asked = await say('メモを作って');
    expect(asked.body.receipt).toBeUndefined();
    expect(asked.body.reply).toBe(QUESTION);
    expect(asked.request.tools?.definitions.map(tool => tool.name)).toEqual(expect.arrayContaining(['study.create', 'folder.create']));
    expect(toolInstructions(asked.request.tools!, true)).toContain(SHANNON_MEMO_PLACE_RULE);
    expect(asked.request.systemPrompt).toContain(SHANNON_MEMO_PLACE_RULE);
    expect(asked.request.systemPrompt).toContain('Selected capabilities: none.');
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

  it('takes his answer to her question as the yes of a spoken write, even without a reliability score', async () => {
    const { say, model } = harness();
    const asked = await say('メモを作って');
    expect(asked.request.tools?.writesWithheld).toBe(true);
    const answer = await say('書斎に');
    expect(answer.request.tools?.writesWithheld).toBeUndefined();
    expect(model.calls).toEqual(['study_create']);
  });

  it('after a talk about her folder, gives her that talk and her tools for the next 「メモを作って」, and no Aether', async () => {
    const { say, chat, sent } = harness(0.95);
    await say('自分のフォルダに何があるか見て');
    const next = await say('メモを作って');
    expect(next.request.systemPrompt).toContain(TRACE);
    expect(next.request.systemPrompt).toContain('folder.list → できた');
    expect(next.request.tools?.definitions.some(tool => tool.name === 'folder.create')).toBe(true);
    expect(next.request.systemPrompt).not.toContain('[Notes]');
    // Typed, the same: no command, the rule and the trace in front of her.
    const typed = await chat('メモを作って');
    expect(typed.body.receipt).toBeUndefined();
    expect(typed.request.systemPrompt).toContain('folder.list → できた');
    expect(toolInstructions(typed.request.tools!, false)).toContain(SHANNON_MEMO_PLACE_RULE);
    expect(sent).toHaveLength(0);
  });
});
