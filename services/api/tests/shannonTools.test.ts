import { describe, expect, it } from 'vitest';
import { configuredAutonomy } from '../src/autonomyBudget.js';
import { ShannonAutonomyService } from '../src/autonomyService.js';
import { SQLiteAutonomyStore } from '../src/autonomyStore.js';
import { authorizeToolCall, toolRefusal } from '../src/shannonToolGate.js';
import { validToolInput } from '../src/shannonToolInput.js';
import { toolSessionMemory } from '../src/shannonToolTypes.js';
import {
  SHANNON_TOOLS, TOOL_FAILURE_KINDS, offeredTools, providerToolName, shannonTool, toolFromProviderName, toolResultForModel,
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
      'study.create', 'study.delete', 'study.list', 'study.move', 'study.read', 'study.rename', 'study.restore', 'study.search', 'study.update',
    ]);
    for (const tool of SHANNON_TOOLS) {
      expect(tool.description, tool.name).toMatch(/[ぁ-んァ-ヶ一-龠]/u);
      expect(tool.input).toMatchObject({ type: 'object', additionalProperties: false });
      for (const required of tool.input.required) expect(Object.keys(tool.input.properties), tool.name).toContain(required);
      expect(tool.domain).toBe(tool.name.startsWith('study.') ? 'aether_study' : 'host_folder');
      expect(tool.cost).toBe('none');
      expect(tool.audiences).toEqual(['owner_alone']);
      expect(tool.surfaces).toEqual(['text', 'voice', 'autonomy']);
      expect(toolFromProviderName(providerToolName(tool.name))).toBe(tool);
      expect(providerToolName(tool.name)).toMatch(/^[a-z_]+$/u);
    }
    // Text, voice and her own time are given the same list; with anyone else present there is none.
    for (const surface of ['text', 'voice', 'autonomy'] as const) {
      expect(offeredTools(surface, 'owner_alone')).toEqual(SHANNON_TOOLS);
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
