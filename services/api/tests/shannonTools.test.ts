import { describe, expect, it } from 'vitest';
import { createInitialCompanionState } from '@shannon/cognition';
import { conversationSecrets, type SecretCheck } from '../src/mind/inhibition/conversationSecrets.js';
import { configuredAutonomy } from '../src/mind/inhibition/autonomyBudget.js';
import { ShannonAutonomyService } from '../src/mind/action/ownTime/autonomyService.js';
import { SQLiteAutonomyStore } from '../src/wiring/autonomyStoreWiring.js';
import { authorizeToolCall, toolRefusal } from '../src/mind/inhibition/shannonToolGate.js';
import { validToolInput } from '../src/mind/tools/shannonToolInput.js';
import { providerFunctionTools } from '../src/infra/models/chatModelTools.js';
import { similarBodies } from '../src/mind/tools/shannonStudyTools.js';
import { toolSessionMemory } from '../src/mind/tools/shannonToolTypes.js';
import {
  CONVERSATION_WRITE_CHARACTERS, SHANNON_TOOLS, TOOL_DOING, TOOL_FAILURE_KINDS, TOOL_SUMMARIES, toolDoing, isReadToolDomain, toolSummary, offeredTools, providerToolName, shannonTool, toolFromProviderName, toolResultForModel,
  type ToolResult, type ToolSurface,
} from '../src/mind/tools/shannonTools.js';

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

/** Her read tools of Syzygy ADR-0008 stage 2, step 3, and their own gate domains. */
/** The real web reads are text-only (deep research: a call hands research to a task with the voice-only `web.research`). */
const TEXT_ONLY = new Set(['web.search', 'web.read']);
const READ_TOOL_DOMAIN_OF: Readonly<Record<string, string>> = { 'notion.read': 'notion_read', 'voyager.tasks': 'voyager_read', 'schedule.upcoming': 'schedule_read', 'schedule.free_time': 'schedule_read', 'places.search': 'places_search', 'web.search': 'web_search', 'web.read': 'web_search' };
const DEVICE_TOOL_NAMES: ReadonlySet<string> = new Set(['reminder.create', 'timer.start', 'calendar.create_event', 'calendar.update_event', 'calendar.delete_event', 'calendar.undo', 'music.search', 'music.recent', 'music.play', 'music.control', 'music.playlist_create']);

describe('the tool registry (ADR-0003 stage 1)', () => {
  it('tags every tool as acting or describing (ADR-0008 §14): today exactly the write effect, and an unknown name never acts', () => {
    expect(Object.keys(TOOL_DOING).sort()).toEqual(SHANNON_TOOLS.map(tool => tool.name).sort());
    for (const definition of SHANNON_TOOLS) expect(toolDoing(definition.name), definition.name).toBe(definition.effect === 'write' ? 'acts' : 'describes');
    expect(toolDoing('web_search')).toBe('describes');
    expect(toolDoing('tool_open')).toBe('describes');
  });

  it('gives every tool a one-line summary of at most 60 characters, in her words, never sent in a schema (ADR-0008 stage 2)', () => {
    const seen = new Set<string>();
    expect(Object.keys(TOOL_SUMMARIES).sort()).toEqual(SHANNON_TOOLS.map(tool => tool.name).sort());
    for (const definition of SHANNON_TOOLS) {
      const tool = { name: definition.name, summary: toolSummary(definition) };
      expect(typeof tool.summary, tool.name).toBe('string');
      expect([...tool.summary].length, tool.name).toBeGreaterThan(0);
      expect([...tool.summary].length, tool.name).toBeLessThanOrEqual(60);
      expect(tool.summary, tool.name).not.toMatch(/[\n\r]/u);
      expect(tool.summary, tool.name).toMatch(/[ぁ-んァ-ヶ一-龠]/u);
      expect(tool.summary, tool.name).toBe(tool.summary.trim());
      // Each tells the tools apart: Jev chooses by them.
      expect(seen.has(tool.summary), tool.name).toBe(false);
      seen.add(tool.summary);
    }
    // The summary is the menu's line, not part of a definition, a provider's function, or anything that carries them.
    expect(SHANNON_TOOLS.every(item => !('summary' in item))).toBe(true);
    expect(providerFunctionTools(SHANNON_TOOLS).every(item => Object.keys(item).join() === 'type,name,description,parameters,strict')).toBe(true);
  });

  it('lists every tool once with a Japanese description, an object schema, a gate domain, its declared cost and allowed audiences/surfaces', () => {
    expect(new Set(SHANNON_TOOLS.map(tool => tool.name)).size).toBe(SHANNON_TOOLS.length);
    expect(SHANNON_TOOLS.map(tool => tool.name).sort()).toEqual([
      'aether.propose', 'aether.read', 'aether.search', 'aetherFolder.create', 'aetherFolder.delete', 'aetherFolder.list', 'aetherFolder.update',
      'brief.morning', 'folder.create', 'folder.delete', 'folder.list', 'folder.move', 'folder.read', 'folder.rename', 'folder.search', 'folder.update',
      'memory.read', 'memory.search', 'minecraft.cancel', 'minecraft.lifecycle_status', 'minecraft.login', 'minecraft.logout', 'minecraft.request', 'minecraft.set_day', 'minecraft.start', 'minecraft.status', 'minecraft.stop', 'notion.read', 'ownerDocs.read', 'ownerDocs.search', 'places.search', 'route.estimate', 'schedule.free_time', 'schedule.upcoming',
      'skill.read', 'study.create', 'study.delete', 'study.list', 'study.move', 'study.read', 'study.rename', 'study.restore', 'study.search', 'study.update', 'task.create', 'task.get', 'task.list', 'task.send', 'voyager.tasks', 'weather.forecast', 'web.read', 'web.research', 'web.search',
      'calendar.create_event', 'calendar.delete_event', 'calendar.undo', 'calendar.update_event', 'music.control', 'music.play', 'music.playlist_create', 'music.recent', 'music.search', 'reminder.create', 'timer.start',
    ].sort());
    // Conversation only: her Minecraft body (phase 4) and a proposal to the owner's Aether inbox.
    // and her read tools of ADR-0008 stage 2.
    // Her skills (ADR-0008 stage 2, step 6) too.
    // `minecraft.set_day` (2026-10-14): the owner's request in a conversation only, never her own time.
    const conversationOnly = (tool: { domain: string; name?: string }) => tool.name === 'minecraft.set_day' || tool.domain === 'memory_read' || tool.domain === 'task_runtime' || tool.domain === 'minecraft_body' || tool.domain === 'aether_proposal' || isReadToolDomain(tool.domain) || tool.domain === 'skill_read' || tool.domain === 'daily_read' || tool.domain === 'device_action';
    // Her own time only, with the owner alone: the owner's documents (ADR-0007, owner decision 2026-10-06; offered only while switched on).
    const ownTimeOnly = (tool: { domain: string }) => tool.domain === 'owner_documents_read';
    // With anyone else present: only her Aether reading tools (held to 「シャノン用フォルダ」 by the gate, Syzygy ADR-0007 revised).
    const shared = new Set(['aether.search', 'aether.read', 'aetherFolder.list']);
    for (const tool of SHANNON_TOOLS) {
      expect(tool.description, tool.name).toMatch(/[ぁ-んァ-ヶ一-龠]/u);
      expect(tool.input).toMatchObject({ type: 'object', additionalProperties: false });
      for (const required of tool.input.required) expect(Object.keys(tool.input.properties), tool.name).toContain(required);
      expect(tool.domain).toBe(DEVICE_TOOL_NAMES.has(tool.name) ? 'device_action' : tool.name.startsWith('memory.') ? 'memory_read' : tool.name.startsWith('task.') || tool.name === 'web.research' ? 'task_runtime' : tool.name.startsWith('study.') || tool.name.startsWith('aetherFolder.') || tool.name === 'aether.search' || tool.name === 'aether.read' ? 'aether_study'
        : ['minecraft.lifecycle_status', 'minecraft.login', 'minecraft.logout', 'minecraft.set_day', 'minecraft.start', 'minecraft.stop'].includes(tool.name) ? 'minecraft_lifecycle' : tool.name.startsWith('minecraft.') ? 'minecraft_body' : tool.name === 'aether.propose' ? 'aether_proposal' : tool.name.startsWith('ownerDocs.') ? 'owner_documents_read'
          : tool.name === 'skill.read' ? 'skill_read' : ['weather.forecast', 'route.estimate', 'brief.morning'].includes(tool.name) ? 'daily_read' : READ_TOOL_DOMAIN_OF[tool.name] ?? 'host_folder');
      // Place and current-web searches call bounded model helpers; every other tool calls no model itself.
      expect(tool.cost).toBe(['places.search', 'web.search', 'web.read', 'brief.morning'].includes(tool.name) ? 'model' : 'none');
      if (READ_TOOL_DOMAIN_OF[tool.name]) expect(tool.effect).toBe('read');
      expect(tool.audiences).toEqual(shared.has(tool.name) ? ['owner_alone', 'others'] : ['owner_alone']);
      if (shared.has(tool.name)) expect(tool.effect).toBe('read');
      expect(tool.surfaces).toEqual(TEXT_ONLY.has(tool.name) ? ['text'] : tool.name === 'web.research' ? ['voice'] : conversationOnly(tool) ? ['text', 'voice'] : ownTimeOnly(tool) ? ['autonomy'] : ['text', 'voice', 'autonomy']);
      if (ownTimeOnly(tool)) expect(tool).toMatchObject({ effect: 'read', input: { required: expect.arrayContaining(['pursuitId']) } });
      expect(toolFromProviderName(providerToolName(tool.name))).toBe(tool);
      expect(providerToolName(tool.name)).toMatch(/^[A-Za-z_]+$/u);
    }
    // The real web read is text-only; voice retains native current_web search. Other surface/audience contracts are unchanged.
    expect(offeredTools('autonomy', 'owner_alone')).toEqual(SHANNON_TOOLS.filter(tool => !conversationOnly(tool)));
    for (const surface of ['text', 'voice', 'autonomy'] as const) {
      expect(offeredTools(surface, 'owner_alone').map(tool => tool.name)).toEqual(SHANNON_TOOLS.filter(tool => (!TEXT_ONLY.has(tool.name) || surface === 'text') && (tool.name !== 'web.research' || surface === 'voice') && (surface !== 'autonomy' || !conversationOnly(tool)) && (surface === 'autonomy' || !ownTimeOnly(tool))).map(tool => tool.name));
      expect(offeredTools(surface, 'others').map(tool => tool.name)).toEqual([...shared]);
    }
    // No tool shows a story to the owner, marks it 「見せてもいい」, or reaches anyone else.
    expect(SHANNON_TOOLS.some(tool => tool.name !== 'task.send' && /show|ready|publish|send|share/u.test(tool.name))).toBe(false);
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
