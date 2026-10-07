import { describe, expect, it } from 'vitest';
import { createLocalApiKernel } from '../src/wiring/apiKernelWiring.js';
import type { ShannonChatModel, ShannonChatModelRequest, ShannonVoiceModelRequest } from '../src/infra/models/chatModel.js';
import { asksAboutNotes, asksAboutTasks, asksOnlyProductRole, voyagerTaskQuery } from '../src/mind/action/respond/conversationCapabilities.js';
import { LocalVoiceDecisionGateway, type VoiceSkill } from '../src/mind/selectors/voiceDecision.js';
import { asksInternalSuiteStatus } from '../src/mind/selectors/voiceDecisionValues.js';
import { promptOf } from './modelPrompt.js';

interface Probe { prompt: string; useWebSearch: boolean; notes: number; taskQueries: string[]; status: number }

async function probe(channel: 'text' | 'voice', utterance: string): Promise<Probe> {
  const result: Probe = { prompt: '', useWebSearch: false, notes: 0, taskQueries: [], status: 0 };
  const record = async (request: ShannonChatModelRequest | ShannonVoiceModelRequest) => {
    result.prompt = promptOf(request);
    result.useWebSearch = request.useWebSearch === true;
    return { mode: 'local-stub' as const, model: 'synthetic', reply: '合成の返答です。' };
  };
  const model: ShannonChatModel = { mode: 'local-stub', model: 'synthetic', generate: record, generateVoice: record };
  const api = createLocalApiKernel(() => '2026-10-01T03:00:00.000Z', {
    chatModel: model,
    aetherContext: { promptFor: () => { result.notes += 1; return ''; } },
    voyagerCatalog: {
      searchTasks: async query => { result.taskQueries.push(query); return []; },
      listProjects: async () => [],
    },
  });
  const response = channel === 'text'
    ? await api.dispatch({ method: 'POST', path: '/v1/chat', body: { scopeKey: 'suite-owner', message: utterance } })
    : await api.dispatch({ method: 'POST', path: '/v1/voice/gemini/cascade/delegations', body: {
      scopeKey: 'suite-owner', threadId: 'synthetic', transcript: utterance, participantMode: 'owner',
    } });
  result.status = response.status;
  return result;
}

async function selected(transcript: string): Promise<readonly VoiceSkill[]> {
  const decision = await new LocalVoiceDecisionGateway().decide({
    scopeKey: 'suite-owner', transcript, participantMode: 'owner', requestedLocation: false, hasFreshLocation: false,
  });
  return decision.selectedSkills;
}

const defined = (prompt: string) => /Aether[^\n]{0,160}(?:執筆|ノート)/u.test(prompt)
  && /Voyager[^\n]{0,160}(?:タスク管理|タスク状態)/u.test(prompt);

// The seven probes of docs/testing/conversation-regression-audit.md, kept deterministic.
const auditCases: Array<{ id: string; utterance: string; notes: boolean; tasks: boolean }> = [
  { id: 'latin-both', utterance: 'AetherとVoyagerの使い分けを教えて', notes: false, tasks: false },
  { id: 'kana-both', utterance: 'エーテルとボイジャーの使い分けを教えて', notes: false, tasks: false },
  { id: 'kana-aether', utterance: 'エーテルに書いた設計を見たい', notes: true, tasks: false },
  { id: 'kana-voyager', utterance: 'ボイジャーに登録した予定を見たい', notes: false, tasks: true },
  { id: 'kana-with-note', utterance: 'エーテルのノートを確認して', notes: true, tasks: false },
  { id: 'kana-with-task', utterance: 'ボイジャーのタスクを確認して', notes: false, tasks: true },
  { id: 'kana-latest', utterance: 'エーテルとボイジャーの最新の開発状況を確認したい', notes: true, tasks: true },
];

describe('suite identity and Japanese aliases', () => {
  for (const channel of ['text', 'voice'] as const) {
    it.each(auditCases)(`${channel}: $id defines the products and runs the required reads`, async item => {
      const result = await probe(channel, item.utterance);
      expect(result.status).toBe(200);
      expect(defined(result.prompt)).toBe(true);
      if (item.notes) expect(result.notes).toBeGreaterThan(0);
      if (item.tasks) expect(result.taskQueries.length).toBeGreaterThan(0);
      // A role question is answered from the identity block; it must not search private tasks.
      if (item.id.endsWith('-both')) expect(result.taskQueries).toEqual([]);
    });
  }

  it('selects the internal skills for Japanese names and keeps web search out of an internal status question', async () => {
    expect(await selected('エーテルに書いた設計を見たい')).toEqual(['aether_notes']);
    expect(await selected('ボイジャーに登録した予定を見たい')).toEqual(['voyager_tasks']);
    expect(await selected('エーテルとボイジャーの最新の開発状況を確認したい')).toEqual(['aether_notes', 'voyager_tasks']);
    expect(await selected('AetherとVoyagerの最新の進捗は？')).toEqual(['aether_notes', 'voyager_tasks']);
    const status = await probe('voice', 'エーテルとボイジャーの最新の開発状況を確認したい');
    expect(status.useWebSearch).toBe(false);
  });

  it('still searches the web when it is genuinely asked for', async () => {
    expect(await selected('最新のニュースを教えて')).toContain('current_web');
    expect(await selected('最新のiPhoneの価格は？')).toContain('current_web');
    expect(await selected('エーテルという化合物の最新ニュースを調べて')).toContain('current_web');
    expect(await selected('ボイジャー探査機の最新情報をネットで検索して')).toContain('current_web');
    expect(asksInternalSuiteStatus('エーテルの最新の状況は？')).toBe(true);
    expect(asksInternalSuiteStatus('最新の状況は？')).toBe(false);
    expect(asksInternalSuiteStatus('ボイジャーの最新ニュースを調べて')).toBe(false);
  });

  it('never gives a guest the private suite readers', async () => {
    const decision = await new LocalVoiceDecisionGateway().decide({
      scopeKey: 'suite-owner', transcript: 'ボイジャーのタスクとエーテルのノートを見せて',
      participantMode: 'guest', requestedLocation: false, hasFreshLocation: false,
    });
    expect(decision.selectedSkills).toEqual([]);
  });

  it('uses one alias contract for the notes and tasks gates', () => {
    expect(asksAboutNotes('エーテルに書いた設計')).toBe(true);
    expect(asksAboutNotes('aetherの件')).toBe(true);
    expect(asksAboutNotes('今日の晩ごはん')).toBe(false);
    expect(asksAboutTasks('ボイジャーに登録した予定')).toBe(true);
    expect(asksAboutTasks('ヴォイジャーの件')).toBe(true);
    expect(asksAboutTasks('やることある？')).toBe(true);
    expect(asksAboutTasks('今日の晩ごはん')).toBe(false);
    expect(asksOnlyProductRole('エーテルとボイジャーの使い分けを教えて')).toBe(true);
    expect(asksOnlyProductRole('ボイジャーって何？')).toBe(true);
    expect(asksOnlyProductRole('ボイジャーのタスクの違いを見せて')).toBe(false);
    expect(asksOnlyProductRole('ボイジャーに登録した予定を見たい')).toBe(false);
  });
});

describe('Voyager search phrase', () => {
  it('keeps the thing being looked for and drops the request wording', () => {
    expect(voyagerTaskQuery('Voyagerにある「写真整理」を見せて')).toEqual({ query: '写真整理', generic: false });
    expect(voyagerTaskQuery('写真整理のタスクどうなってる？')).toEqual({ query: '写真整理', generic: false });
    expect(voyagerTaskQuery('ボイジャーで確定申告のタスクを検索して')).toEqual({ query: '確定申告', generic: false });
    expect(voyagerTaskQuery('VoyagerのMVP仕様のタスクを教えて')).toEqual({ query: 'MVP 仕様', generic: false });
    expect(voyagerTaskQuery('エーテルとボイジャーの最新の開発状況を確認したい')).toEqual({ query: '開発状況', generic: false });
  });

  it('falls back to the generic word instead of sending the whole utterance', () => {
    expect(voyagerTaskQuery('やることある？')).toEqual({ query: 'やること', generic: true });
    expect(voyagerTaskQuery('Voyagerの今日の予定教えて')).toEqual({ query: '予定', generic: true });
    expect(voyagerTaskQuery('ボイジャーに登録した予定を見たい')).toEqual({ query: '予定', generic: true });
    expect(voyagerTaskQuery('ボイジャーのタスクを確認して')).toEqual({ query: 'タスク', generic: true });
  });

  it('tells the model that an empty generic search is not an empty task list', async () => {
    const generic = await probe('text', 'やることある？');
    expect(generic.taskQueries).toEqual(['やること']);
    expect(generic.prompt).toContain('Keyword searched: "やること"');
    expect(generic.prompt).toContain('Do not say there are no tasks');
    const specific = await probe('text', '写真整理のタスクどうなってる？');
    expect(specific.taskQueries).toEqual(['写真整理']);
    expect(specific.prompt).toContain('Nothing matched this keyword');
  });
});
