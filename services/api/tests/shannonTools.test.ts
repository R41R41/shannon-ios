import { describe, expect, it } from 'vitest';
import { createInitialCompanionState } from '@shannon/cognition';
import { conversationSecrets, type SecretCheck } from '../src/conversationSecrets.js';
import { configuredAutonomy } from '../src/autonomyBudget.js';
import { ShannonAutonomyService } from '../src/autonomyService.js';
import { SQLiteAutonomyStore } from '../src/autonomyStore.js';
import { authorizeToolCall, toolRefusal } from '../src/shannonToolGate.js';
import { validToolInput } from '../src/shannonToolInput.js';
import { similarBodies } from '../src/shannonStudyTools.js';
import { toolSessionMemory } from '../src/shannonToolTypes.js';
import {
  CONVERSATION_WRITE_CHARACTERS, SHANNON_TOOLS, TOOL_FAILURE_KINDS, offeredTools, providerToolName, shannonTool, toolFromProviderName, toolResultForModel,
  type ToolResult, type ToolSurface,
} from '../src/shannonTools.js';

const scope = 'owner';
const STORY = `雨の日の図書館で、だれも借りない本が一冊だけ光っていた。${'ページをめくる音が、静かな部屋に少しずつ広がっていく。'.repeat(4)}`;

function harness(environment: Record<string, string> = {}) {
  const clock = { at: '2026-10-05T01:00:00.000Z' };
  const store = new SQLiteAutonomyStore(':memory:');
  const service = new ShannonAutonomyService({ store, config: configuredAutonomy(environment), now: () => clock.at });
  const memory = toolSessionMemory();
  const call = (name: string, input: unknown, surface: ToolSurface = 'text') =>
    service.tools.call(name, typeof input === 'string' ? input : JSON.stringify(input), { scopeKey: scope, surface, audience: 'owner_alone', memory });
  const entries = () => service.activityDays(scope, 30).flatMap(day => day.entries);
  return { clock, store, service, call, entries };
}

function idIn(result: ToolResult): string {
  const match = /id: ([0-9a-f-]{36})/u.exec(result.text);
  if (!match) throw new Error(`no id in ${result.text}`);
  return match[1]!;
}

describe('the tool registry (ADR-0003 stage 1)', () => {
  it('lists every tool once with a Japanese description, an object schema, a gate domain, no cost of its own, and the owner alone as audience', () => {
    expect(new Set(SHANNON_TOOLS.map(tool => tool.name)).size).toBe(SHANNON_TOOLS.length);
    expect(SHANNON_TOOLS.map(tool => tool.name).sort()).toEqual([
      'folder.create', 'folder.delete', 'folder.list', 'folder.move', 'folder.read', 'folder.rename', 'folder.search', 'folder.update',
      'minecraft.cancel', 'minecraft.request', 'minecraft.status',
      'study.create', 'study.delete', 'study.list', 'study.move', 'study.read', 'study.rename', 'study.restore', 'study.search', 'study.update',
    ]);
    for (const tool of SHANNON_TOOLS) {
      expect(tool.description, tool.name).toMatch(/[ぁ-んァ-ヶ一-龠]/u);
      expect(tool.input).toMatchObject({ type: 'object', additionalProperties: false });
      for (const required of tool.input.required) expect(Object.keys(tool.input.properties), tool.name).toContain(required);
      expect(tool.domain).toBe(tool.name.startsWith('study.') ? 'aether_study' : tool.name.startsWith('minecraft.') ? 'minecraft_body' : 'host_folder');
      expect(tool.cost).toBe('none');
      expect(tool.audiences).toEqual(['owner_alone']);
      // Her Minecraft body is asked from a conversation only, never from her own time (phase 4).
      expect(tool.surfaces).toEqual(tool.domain === 'minecraft_body' ? ['text', 'voice'] : ['text', 'voice', 'autonomy']);
      expect(toolFromProviderName(providerToolName(tool.name))).toBe(tool);
      expect(providerToolName(tool.name)).toMatch(/^[a-z_]+$/u);
    }
    // Text, voice and her own time are given the same tools (a conversation's writes shorter); with anyone else present there are none.
    expect(offeredTools('autonomy', 'owner_alone')).toEqual(SHANNON_TOOLS.filter(tool => tool.domain !== 'minecraft_body'));
    for (const surface of ['text', 'voice', 'autonomy'] as const) {
      expect(offeredTools(surface, 'owner_alone').map(tool => tool.name)).toEqual(SHANNON_TOOLS.filter(tool => surface !== 'autonomy' || tool.domain !== 'minecraft_body').map(tool => tool.name));
      expect(offeredTools(surface, 'others')).toEqual([]);
    }
    // No tool shows a story to the owner, marks it 「見せてもいい」, or reaches anyone else.
    expect(SHANNON_TOOLS.some(tool => /show|ready|publish|send|share/u.test(tool.name))).toBe(false);
  });

  it('decides at one gate entry: an unknown tool, a surface it does not list, or anyone else present is refused with why and what would work', () => {
    const study = shannonTool('study.read')!;
    expect(authorizeToolCall(study, { scopeKey: scope, surface: 'text', audience: 'owner_alone' })).toBeNull();
    const others = authorizeToolCall(study, { scopeKey: scope, surface: 'voice', audience: 'others' })!;
    expect(others).toMatchObject({ ok: false, failure: 'not_offered', retryable: false });
    expect(others.refusal?.why).toContain('ライ氏以外の人');
    expect(others.refusal?.wouldWork).toContain('二人だけ');
    expect(authorizeToolCall(null, { scopeKey: scope, surface: 'text', audience: 'owner_alone' })).toMatchObject({ failure: 'not_offered' });
    // The autonomy gate's refusals come back in the same shape.
    expect(toolRefusal({ reason: 'paused', explanation: '所有者が一時停止しているため、実行しません。' })).toMatchObject({ ok: false, failure: 'refused', refusal: { why: expect.stringContaining('一時停止') } });
    expect(toolRefusal({ reason: 'unknown_host', explanation: 'x' })).toMatchObject({ failure: 'unavailable' });
    expect(toolRefusal({ reason: 'budget_exhausted', explanation: 'x' })).toMatchObject({ failure: 'limit' });
  });

  it('checks the input against the schema: only listed fields, of their type, inside their bounds, required ones present', () => {
    const schema = shannonTool('study.read')!.input;
    expect(validToolInput('{"id":"12345678-aaaa"}', schema)).toEqual({ input: { id: '12345678-aaaa' } });
    expect(validToolInput({ id: '12345678', extra: 1 }, schema)).toMatchObject({ problem: expect.stringContaining('extra') });
    expect(validToolInput({}, schema)).toMatchObject({ problem: expect.stringContaining('id') });
    expect(validToolInput({ id: '12345678', version: 0 }, schema)).toMatchObject({ problem: expect.stringContaining('version') });
    expect(validToolInput({ id: '12345678', version: 1.5 }, schema)).toMatchObject({ problem: expect.stringContaining('整数') });
    expect(validToolInput('not json', schema)).toMatchObject({ problem: expect.stringContaining('JSON') });
    expect(validToolInput({ kind: 'poem', title: 't', body: 'b' }, shannonTool('study.create')!.input)).toMatchObject({ problem: expect.stringContaining('kind') });
  });

  it('returns one result shape to every model, with a failure kind from a closed set', () => {
    const json = JSON.parse(toolResultForModel({ ok: false, text: 'x', failure: 'refused', retryable: false, refusal: { why: 'a', wouldWork: 'b' } }));
    expect(json).toEqual({ ok: false, text: 'x', failure: 'refused', retryable: false, why: 'a', wouldWork: 'b' });
    expect(TOOL_FAILURE_KINDS).toContain(json.failure);
  });
});

describe('the study tools', () => {
  it('let her write, list, read, search, revise, rename, file, put away, take back, delete and restore her own pieces', async () => {
    const { call, store } = harness();
    const note = await call('study.create', { kind: 'note', title: '雨の図書館', body: '雨の日の図書館は、音が少しやわらかい。' });
    expect(note).toMatchObject({ ok: true });
    const noteId = idIn(note);
    const created = await call('study.create', { kind: 'story', title: '光る本', body: STORY, changeNote: '最初の稿。' });
    const storyId = idIn(created);
    expect(created.text).toContain('ライ氏にはまだ見えない');
    expect(store.study.get(scope, storyId)).toMatchObject({ status: 'draft', readableVersion: null, version: 1 });

    // Her own unshown draft: title and text are hers to read.
    const listed = await call('study.list', {});
    expect(listed.text).toContain(`id: ${storyId}｜物語「光る本」｜下書き`);
    expect(listed.text).toContain('メモ「雨の図書館」');
    const read = await call('study.read', { id: storyId });
    expect(read.text).toContain('題名: 光る本');
    expect(read.text).toContain(STORY);
    expect(read.text).toContain('ライ氏にはまだ見せていない');
    expect((await call('study.search', { query: 'だれも借りない' })).text).toContain('光る本');

    const updated = await call('study.update', { id: storyId, body: `${STORY}本はもう光らなかった。`, changeNote: '終わりを足した。' });
    expect(updated).toMatchObject({ ok: true });
    expect(store.study.versions(scope, storyId)).toHaveLength(2);
    expect((await call('study.read', { id: storyId, version: 1 })).text).not.toContain('本はもう光らなかった');
    expect(await call('study.rename', { id: storyId, title: '光らない本' })).toMatchObject({ ok: true });
    expect(store.study.get(scope, storyId)).toMatchObject({ title: '光らない本', version: 3, status: 'draft' });

    expect(await call('study.move', { id: noteId, to: 'put_away' })).toMatchObject({ ok: true });
    expect(store.study.get(scope, noteId)).toMatchObject({ status: 'put_away', putAwayBy: 'shannon' });
    expect((await call('study.list', { status: 'put_away' })).text).toContain('雨の図書館');
    expect(await call('study.move', { id: noteId, to: 'take_back' })).toMatchObject({ ok: true });
    expect(store.study.get(scope, noteId)).toMatchObject({ status: 'ready' });
    expect(await call('study.update', { id: noteId, body: 'x', changeNote: 'y', extra: true })).toMatchObject({ ok: false, failure: 'invalid_input' });

    expect(await call('study.delete', { id: storyId })).toMatchObject({ ok: true });
    // In the trash every other path reads it as gone; its versions stay.
    expect(store.study.get(scope, storyId)).toBeNull();
    expect(store.study.versions(scope, storyId)).toHaveLength(3);
    expect((await call('study.list', {})).text).not.toContain('光らない本');
    expect((await call('study.list', { status: 'deleted' })).text).toContain('光らない本');
    expect(await call('study.read', { id: storyId })).toMatchObject({ ok: true });
    expect(await call('study.update', { id: storyId, body: 'x', changeNote: 'y' })).toMatchObject({ ok: false, failure: 'not_found' });
    expect(await call('study.restore', { id: storyId })).toMatchObject({ ok: true });
    expect(store.study.get(scope, storyId)).toMatchObject({ title: '光らない本', status: 'draft' });
  });

  it('keep what the owner asked to be put away out of her own time, and keep the open-story limit', async () => {
    const { call, store, clock } = harness();
    const id = idIn(await call('study.create', { kind: 'story', title: '光る本', body: STORY }));
    store.study.putAway(scope, id, 'owner', clock.at);
    const refused = await call('study.move', { id, to: 'take_back' }, 'autonomy');
    expect(refused).toMatchObject({ ok: false, failure: 'refused', refusal: { wouldWork: expect.stringContaining('会話') } });
    expect(await call('study.move', { id, to: 'take_back' }, 'text')).toMatchObject({ ok: true });
    for (let index = 1; index < 12; index += 1) await call('study.create', { kind: 'story', title: `話${index}`, body: STORY });
    expect(await call('study.create', { kind: 'story', title: 'もう一つ', body: STORY })).toMatchObject({ ok: false, failure: 'limit' });
  });

  it('writes one record entry per call from a conversation, with no text of hers and no title of a story the owner cannot read', async () => {
    const { call, entries } = harness();
    const id = idIn(await call('study.create', { kind: 'story', title: 'ひみつの題名', body: STORY }));
    await call('study.read', { id });
    await call('study.update', { id, body: `${STORY}おしまい。`, changeNote: '直した。' });
    await call('study.read', { id: 'nope-nope-nope' });
    await call('study.list', { bogus: 1 });
    const recorded = entries();
    expect(recorded).toHaveLength(5);
    for (const entry of recorded) {
      expect(entry).toMatchObject({ kind: 'action', actor: 'shannon', domain: 'conversation' });
      expect(entry.summary).not.toContain('ひみつの題名');
      expect(entry.summary).not.toContain('図書館');
    }
    expect(recorded.map(entry => entry.tool)).toEqual(expect.arrayContaining(['study.create', 'study.read', 'study.update', 'study.list']));
    expect(recorded.filter(entry => entry.outcome === 'failed')).toHaveLength(2);
    expect(recorded.map(entry => entry.summary)).toContain('書斎のまだ見せていない物語を読みました。');
  });
});

describe('what her writes from a conversation must not repeat', () => {
  it('refuses a write that repeats what the owner asked to keep secret or to forget, and every write while the list cannot be read', async () => {
    const { service, store } = harness();
    const call = (name: string, input: unknown, secrets: SecretCheck | null) =>
      service.tools.call(name, JSON.stringify(input), { scopeKey: scope, surface: 'text', audience: 'owner_alone', memory: toolSessionMemory(), secrets });
    const at = '2026-10-05T00:00:00.000Z';
    const state = { ...createInitialCompanionState('owner', at), userFacts: [
      { id: 'secret', statement: 'ユーザーはウォンバット会の集まりに毎月出ている', confidence: 0.9, observedAt: at, disclosure: { category: 'secret' as const } },
    ] };
    const secrets = conversationSecrets(state, { experienceCandidates: () => [] }, scope);
    const refused = await call('study.create', { kind: 'note', title: '会のこと', body: 'ライ氏は、ウォンバット会の集まりに毎月出ているらしい。' }, secrets);
    expect(refused).toMatchObject({ ok: false, failure: 'refused', retryable: false, refusal: { why: expect.stringContaining('内緒'), wouldWork: expect.stringContaining('除いて') } });
    expect(refused.text).toContain('同じ言い回し');
    // A word or two in common is not the secret: runs of ten characters, with the subject and punctuation left out.
    expect(await call('study.create', { kind: 'note', title: 'ウォンバット', body: '動物園でウォンバットを見た。毎月出かけたい。' }, secrets)).toMatchObject({ ok: true });
    expect(store.study.list(scope)).toHaveLength(1);
    expect(await call('study.create', { kind: 'note', title: '散歩', body: '公園を歩いた。' }, null)).toMatchObject({ ok: false, failure: 'unavailable', retryable: true, text: expect.stringContaining('読めなかった') });
    expect(await call('study.create', { kind: 'note', title: '散歩', body: '公園を歩いた。' }, secrets)).toMatchObject({ ok: true });
    // Reading is not writing: it is never refused for this.
    expect(await call('study.list', { query: 'ウォンバット' }, secrets)).toMatchObject({ ok: true });
  });

  it('checks secret, hand-marked, forgotten and rejected items and turns in full, and nothing else of his', () => {
    const at = '2026-10-05T00:00:00.000Z';
    const base = createInitialCompanionState('owner', at);
    const state = {
      ...base,
      userFacts: [
        { id: 'secret', statement: 'ユーザーはウォンバット会に入っている', confidence: 0.9, observedAt: at, disclosure: { category: 'secret' as const } },
        { id: 'marked', statement: 'ユーザーはアルマジロを集めている', confidence: 0.9, observedAt: at, disclosure: { decidedBy: 'owner' as const, sensitivity: 'sensitive' as const } },
        { id: 'forgotten', statement: 'ユーザーはカピバラ基金に寄付した', confidence: 0.9, observedAt: at },
        { id: 'open', statement: 'ユーザーは紅茶が好きで毎朝ダージリンを飲む', confidence: 0.9, observedAt: at },
        { id: 'corrected', statement: 'ユーザーはコーヒーが嫌いでまったく飲まない', confidence: 0.9, observedAt: at },
      ],
      memoryControls: [
        { memoryId: 'forgotten', kind: 'user-fact' as const, status: 'forgotten' as const, pinned: false, updatedAt: at, changeReason: 'forget' },
        { memoryId: 'corrected', kind: 'user-fact' as const, status: 'active' as const, pinned: false, updatedAt: at, changeReason: 'correct', overrideText: 'ユーザーはコーヒーも飲む' },
      ],
    };
    const long = `${'あいうえおかきくけこ'.repeat(60)}ナマケモノ投資の話をした`;
    const turns = [{ id: 'turn-secret', userMessage: long, shannonReply: '', summary: 's', observedAt: at, disclosure: { category: 'secret' as const } }];
    const check = conversationSecrets(state as typeof base, { experienceCandidates: () => turns as never }, scope);
    expect(check.carries('ライ氏、ウォンバット会に入っているの？')).toBe(true);
    expect(check.carries('アルマジロを集めている人の話')).toBe(true);
    expect(check.carries('カピバラ基金に寄付した、と書く')).toBe(true);
    // Past the first 400 characters of a long turn: checked too.
    expect(check.carries('ナマケモノ投資の話をした')).toBe(true);
    // Not secret, not forgotten: his tea, and the original wording of a corrected item.
    expect(check.carries('紅茶が好きで毎朝ダージリンを飲む')).toBe(false);
    expect(check.carries('コーヒーが嫌いでまったく飲まない')).toBe(false);
    // A run of hiragana alone is filler.
    expect(check.carries('あいうえおかきくけこ')).toBe(false);
    // What went with a forgotten turn: a fact derived from it, and a fact quoting what a forgotten item quoted.
    const derived = { ...base,
      userFacts: [
        { id: 'from-turn', statement: 'ユーザーはオカピ牧場で働いている', confidence: 0.9, observedAt: at, sourceExperienceId: 'turn-gone' },
        { id: 'gone', statement: 'ユーザーはイルカ教室に通う', confidence: 0.9, observedAt: at, evidence: 'イルカ教室に毎週通ってる' },
        { id: 'quoting', statement: 'ユーザーは水泳が得意で大会にも出た', confidence: 0.9, observedAt: at, evidence: 'イルカ教室に毎週通ってる' },
      ],
      memoryControls: [
        { memoryId: 'turn-gone', kind: 'experience' as const, status: 'forgotten' as const, pinned: false, updatedAt: at, changeReason: 'forget' },
        { memoryId: 'gone', kind: 'user-fact' as const, status: 'forgotten' as const, pinned: false, updatedAt: at, changeReason: 'forget' },
      ] };
    const goneTurn = [{ id: 'turn-gone', userMessage: 'じつはスナネコ同好会の会長をやっている', shannonReply: '', summary: 's', observedAt: at }];
    const withDerived = conversationSecrets(derived as typeof base, { experienceCandidates: () => goneTurn as never }, scope);
    expect(withDerived.carries('オカピ牧場で働いている人')).toBe(true);
    expect(withDerived.carries('水泳が得意で大会にも出たらしい')).toBe(true);
    expect(withDerived.carries('スナネコ同好会の会長をやっている')).toBe(true);
  });
});

describe('long writing and repeated writes', () => {
  it('keeps one conversation write short, builds a long story with append, and lets her own time write it whole', async () => {
    const { call, store } = harness();
    const part = '静かな駅の話。'.repeat(450);
    expect(part.length).toBeGreaterThan(CONVERSATION_WRITE_CHARACTERS);
    expect(await call('study.create', { kind: 'story', title: '長い話', body: part })).toMatchObject({ ok: false, failure: 'invalid_input' });
    const first = part.slice(0, 1_400);
    const id = idIn(await call('study.create', { kind: 'story', title: '長い話', body: first }));
    expect(await call('study.update', { id, mode: 'append', body: part.slice(1_400, 2_800), changeNote: '続きを足した。' })).toMatchObject({ ok: true, text: expect.stringContaining('続きを足した') });
    expect(await call('study.update', { id, mode: 'append', body: '\n終わり。', changeNote: '結び。' })).toMatchObject({ ok: true });
    expect(store.study.get(scope, id)).toMatchObject({ version: 3, body: `${first}\n\n${part.slice(1_400, 2_800)}\n終わり。` });
    // Past the story's own limit, append is refused like any write.
    expect(await call('study.update', { id, mode: 'append', body: 'あ'.repeat(1_300), changeNote: 'x' })).toMatchObject({ ok: false, failure: 'invalid_input' });
    // Her own time: no client is waiting, so the larger limit holds.
    expect(await call('study.create', { kind: 'story', title: '長い話・自分の時間', body: part }, 'autonomy')).toMatchObject({ ok: true });
  });

  it('does not write the same piece twice: the same title and body, or the same title for a retry of the same owner message', async () => {
    const { service, store, clock } = harness();
    const turn = (key: string) => (name: string, input: unknown) =>
      service.tools.call(name, JSON.stringify(input), { scopeKey: scope, surface: 'text', audience: 'owner_alone', memory: toolSessionMemory(key) });
    const first = turn('message-1');
    const id = idIn(await first('study.create', { kind: 'story', title: '雨の駅', body: STORY }));
    const again = await first('study.create', { kind: 'story', title: '雨の駅', body: `  ${STORY}` });
    expect(again).toMatchObject({ ok: true, text: expect.stringContaining('二つにはしなかった') });
    expect(again.text).toContain(id);
    // A retry of the same message writes the story again under the same title, with a similar body: still the one piece.
    expect((await turn('message-1')('study.create', { kind: 'story', title: '雨の駅', body: `${STORY}別の書き方。` })).text).toContain(id);
    expect(store.study.list(scope)).toHaveLength(1);
    // The same title for something else of the same message is another piece: another kind, or a different body.
    expect((await turn('message-1')('study.create', { kind: 'note', title: '雨の駅', body: '駅の取材メモ。改札の位置。' })).text).not.toContain(id);
    expect((await turn('message-1')('study.create', { kind: 'story', title: '雨の駅', body: '山の上の小屋で、猫が手紙を待っていた。冬が来る前の話。' })).text).not.toContain(id);
    expect(store.study.list(scope)).toHaveLength(3);
    expect(similarBodies('静かな駅の話。雨が降る。', '静かな駅の話。雨が降る。傘を忘れた。')).toBe(true);
    expect(similarBodies('静かな駅の話', '猫と手紙の物語')).toBe(false);
    // Another message may write another piece with that title; and the same text much later is a new piece.
    expect(await turn('message-2')('study.create', { kind: 'story', title: '雨の駅', body: `${STORY}二本目。` })).toMatchObject({ ok: true });
    clock.at = '2026-10-05T02:00:00.000Z';
    expect((await turn('message-3')('study.create', { kind: 'story', title: '雨の駅', body: STORY })).text).not.toContain(id);
    expect(store.study.list(scope)).toHaveLength(5);
  });

  it('does not append the same part twice for the same owner message', async () => {
    const { service, store } = harness();
    const turn = (key: string) => (name: string, input: unknown) =>
      service.tools.call(name, JSON.stringify(input), { scopeKey: scope, surface: 'text', audience: 'owner_alone', memory: toolSessionMemory(key) });
    const id = idIn(await turn('message-1')('study.create', { kind: 'story', title: '続く話', body: STORY }));
    const part = { id, mode: 'append', body: '二日目の朝、駅にはまた傘があった。', changeNote: '続き。' };
    expect(await turn('message-2')('study.update', part)).toMatchObject({ ok: true, text: expect.stringContaining('続きを足した') });
    // A retry of the same message: the same part is not appended again.
    expect(await turn('message-2')('study.update', part)).toMatchObject({ ok: true, text: expect.stringContaining('二度は足さなかった') });
    expect(store.study.get(scope, id)!.version).toBe(2);
    // Another message may append it (she means it again).
    expect(await turn('message-3')('study.update', part)).toMatchObject({ ok: true, text: expect.stringContaining('続きを足した') });
    expect(store.study.get(scope, id)!.version).toBe(3);
  });
});
