import { afterEach, describe, expect, it } from 'vitest';
import { createLocalApiKernel } from '../src/infra/http/apiKernel.js';
import { configuredAutonomy } from '../src/mind/inhibition/autonomyBudget.js';
import { ShannonAutonomyService } from '../src/mind/action/ownTime/autonomyService.js';
import { SQLiteAutonomyStore } from '../src/mind/action/ownTime/store/autonomyStore.js';
import type { ShannonChatModel, ShannonChatModelRequest, ShannonChatModelResult, ShannonTaskProposal, ShannonVoiceModelRequest } from '../src/infra/models/chatModel.js';
import { LocalVoiceDecisionGateway } from '../src/mind/selectors/voiceDecision.js';
import type { VoiceDecisionInput } from '../src/contracts/voiceDecisionContract.js';
import { FakeAether } from './fakeAetherServer.js';

/**
 * Production, 2026-10-06 (turn b3dad24c…): the owner asked in a Talk for 「シャノンのやりたいことリスト」. Her
 * `aetherFolder.create` wrote it, and the same structured reply also carried a `taskProposal` to write the same note
 * with Codex; the app showed it as a proposal and a Codex task was started from it. A turn whose own tool wrote what was
 * asked proposes no agent task; a code request still does.
 */
const scope = 'owner';
const at = '2026-10-06T02:29:44.000Z';
const servers: FakeAether[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => server.stop())); });

const LIST_PROPOSAL: ShannonTaskProposal = {
  title: 'シャノンのやりたいことリストを作成',
  goal: 'Aetherのシャノン用フォルダに、シャノン自身の目標をまとめたノート「シャノンのやりたいことリスト」を新規作成する。',
};
const CODE_PROPOSAL: ShannonTaskProposal = {
  title: '設定画面のボタンを直す', goal: 'シャノンのiOSアプリの設定画面で保存ボタンが押せない不具合を直す。', projectHint: 'shannon-ios', hostHint: 'shannon-mac',
};

/** A model that calls the tool its script names (as the provider would, before its final answer) and then proposes a task. */
class ScriptedModel implements ShannonChatModel {
  readonly mode = 'openai' as const;
  readonly model = 'test-model';
  readonly results: Array<{ tool: string; ok: boolean }> = [];
  constructor(private readonly script: (message: string) => { call?: [string, Record<string, unknown>]; proposal: ShannonTaskProposal }) {}
  async generate(request: ShannonChatModelRequest) { return this.answer(request); }
  async generateVoice(request: ShannonVoiceModelRequest) { return this.answer(request); }
  private async answer(request: ShannonChatModelRequest | ShannonVoiceModelRequest): Promise<ShannonChatModelResult> {
    const { call, proposal } = this.script(request.message);
    if (call) {
      expect(request.tools?.definitions.some(tool => tool.name.replace('.', '_') === call[0]), call[0]).toBe(true);
      const result = JSON.parse(await request.tools!.call(call[0], JSON.stringify(call[1]))) as { ok: boolean };
      this.results.push({ tool: call[0], ok: result.ok });
    }
    return { mode: this.mode, model: this.model, reply: 'はい、ライ氏。', taskDecision: { disposition: 'propose', reason: 'test' }, taskProposal: proposal };
  }
}

async function harness(script: ConstructorParameters<typeof ScriptedModel>[0]) {
  const fake = new FakeAether();
  servers.push(fake);
  const now = () => at;
  const autonomy = new ShannonAutonomyService({ store: new SQLiteAutonomyStore(':memory:'), config: configuredAutonomy({}), now, aether: { access: await fake.access(), proposals: null } });
  const model = new ScriptedModel(script);
  // Words heard clearly: a spoken turn may write (`transcriptTrust`).
  const local = new LocalVoiceDecisionGateway();
  const voiceDecision = { mode: local.mode, model: local.model, async decide(input: VoiceDecisionInput) { return { ...await local.decide(input), transcriptReliabilityProbability: 0.98 }; } };
  const api = createLocalApiKernel(now, { chatModel: model, autonomy, voiceDecision });
  const proposalsOf = (body: unknown) => ((body as { uiBlocks?: Array<{ type: string; title?: string }> }).uiBlocks ?? []).filter(block => block.type === 'agent_task_proposal');
  const chat = async (message: string) => {
    const response = await api.dispatch({ method: 'POST', path: '/v1/chat', body: { scopeKey: scope, threadId: 'talk', message } });
    expect(response.status).toBe(200);
    return proposalsOf(response.body);
  };
  const say = async (transcript: string) => {
    const response = await api.dispatch({ method: 'POST', path: '/v1/voice/gemini/cascade/delegations', body: { scopeKey: scope, threadId: 'talk', transcript,
      deviceContext: { timeZoneIdentifier: 'Asia/Tokyo', requestedLocation: false, location: null,
        userUtterance: { id: `u-${transcript.length}`, text: transcript, source: 'speech', rawText: transcript } } } });
    expect(response.status).toBe(200);
    return proposalsOf(response.body);
  };
  return { fake, model, chat, say };
}

const WRITE_LIST = ['aetherFolder_create', { title: 'シャノンのやりたいことリスト', body: '- 物語を書く\n- 描写を研究する' }] as [string, Record<string, unknown>];

describe('an agent task after her own tool wrote what was asked', () => {
  it('proposes none in a text turn whose aetherFolder.create worked, and the note is in her folder', async () => {
    const h = await harness(() => ({ call: WRITE_LIST, proposal: LIST_PROPOSAL }));
    expect(await h.chat('シャノンのやりたいことリストを書いて')).toEqual([]);
    expect(h.model.results).toEqual([{ tool: 'aetherFolder_create', ok: true }]);
    expect(h.fake.inFolder().map(document => document.title)).toContain('シャノンのやりたいことリスト');
  });

  it('proposes none in a spoken turn whose aetherFolder.create worked', async () => {
    const h = await harness(() => ({ call: WRITE_LIST, proposal: LIST_PROPOSAL }));
    expect(await h.say('シャノンのフォルダにやりたいことリストのメモを書いて')).toEqual([]);
    expect(h.model.results).toEqual([{ tool: 'aetherFolder_create', ok: true }]);
  });

  it('still proposes a genuine code request, also after a turn that only read her folder', async () => {
    const h = await harness(message => ({ ...(message.includes('一覧') ? { call: ['aetherFolder_list', {}] as [string, Record<string, unknown>] } : {}), proposal: CODE_PROPOSAL }));
    expect(await h.chat('設定画面の保存ボタンが押せないから直して')).toMatchObject([{ title: CODE_PROPOSAL.title }]);
    expect(await h.chat('フォルダの一覧を見て、それから設定画面の保存ボタンを直して')).toMatchObject([{ title: CODE_PROPOSAL.title }]);
    expect(h.model.results).toEqual([{ tool: 'aetherFolder_list', ok: true }]);
  });

  it('keeps the proposal when her write did not work', async () => {
    // An empty title and body are refused by the input check, so nothing was written.
    const h = await harness(() => ({ call: ['aetherFolder_create', { title: '', body: '' }], proposal: LIST_PROPOSAL }));
    expect(await h.chat('シャノンのやりたいことリストを書いて')).toMatchObject([{ title: LIST_PROPOSAL.title }]);
    expect(h.model.results).toEqual([{ tool: 'aetherFolder_create', ok: false }]);
  });
});
