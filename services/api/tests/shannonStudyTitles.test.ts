import { describe, expect, it } from 'vitest';
import { configuredAutonomy } from '../src/mind/inhibition/autonomyBudget.js';
import { ShannonAutonomyService } from '../src/autonomyService.js';
import { SQLiteAutonomyStore } from '../src/autonomyStore.js';
import { toolTraceCall, toolTracePrompt, traceLabel } from '../src/mind/tools/shannonToolTrace.js';
import { toolSessionMemory } from '../src/mind/tools/shannonToolTypes.js';
import { shannonTool, type ToolResult } from '../src/mind/tools/shannonTools.js';

/**
 * Build 138, text chat, 2026-10-05: she wanted to read 『名脇役のハッチを叩いて』 and could not, because study.read took
 * only an id and she knew the piece by its title. Every study tool that names one piece now takes its title too.
 */
const scope = 'owner';
const TITLE = '名脇役のハッチを叩いて';
const BODY = `ハッチの向こうで、だれかが三回叩いた。${'主役ではない人の手だった。'.repeat(3)}`;

function harness() {
  const store = new SQLiteAutonomyStore(':memory:');
  const service = new ShannonAutonomyService({ store, config: configuredAutonomy({}), now: () => '2026-10-05T06:00:00.000Z' });
  const memory = toolSessionMemory();
  const call = (name: string, input: Record<string, unknown>) =>
    service.tools.call(name, JSON.stringify(input), { scopeKey: scope, surface: 'text', audience: 'owner_alone', memory });
  return { store, call };
}

const idIn = (result: ToolResult) => /id: ([0-9a-f-]{36})/u.exec(result.text)![1]!;

describe('naming a piece of her study by its title', () => {
  it('lists every piece with its id, then reads 『名脇役のハッチを叩いて』 by its title, with and without the brackets', async () => {
    const { call } = harness();
    const id = idIn(await call('study.create', { kind: 'story', title: TITLE, body: BODY }));
    await call('study.create', { kind: 'note', title: '雨の図書館', body: '雨の日の図書館は、音が少しやわらかい。' });
    const listed = await call('study.list', {});
    expect(listed.text).toContain(`id: ${id}｜物語「${TITLE}」｜下書き`);
    for (const named of [TITLE, `『${TITLE}』`, `「${TITLE}」`, ` 名脇役の ハッチを叩いて `, '名脇役のﾊｯﾁを叩いて']) {
      const read = await call('study.read', { id: named });
      expect(read, named).toMatchObject({ ok: true });
      expect(read.text).toContain(BODY);
    }
    // By id as before.
    expect((await call('study.read', { id })).text).toContain(BODY);
    // The id survives in what she remembers of the list for her next turns.
    const trace = toolTraceCall('study.list', '{}', listed, undefined);
    expect(trace.names).toContain(`物語「${TITLE}」（下書き、id: ${id}）`);
    expect(toolTracePrompt([{ record: { turnId: 't1', threadId: 'talk', recordedAt: '2026-10-05T06:00:00.000Z', asked: false, calls: [trace] }, label: traceLabel(1) }])).toContain(`id: ${id}`);
  });

  it('lets update, rename, move, delete and restore take a title too', async () => {
    const { call, store } = harness();
    const id = idIn(await call('study.create', { kind: 'story', title: TITLE, body: BODY }));
    expect(await call('study.update', { id: `『${TITLE}』`, mode: 'append', body: '\nおしまい。', changeNote: '終わりを足した。' })).toMatchObject({ ok: true });
    expect(await call('study.rename', { id: TITLE, title: 'ハッチの音' })).toMatchObject({ ok: true });
    expect(store.study.get(scope, id)).toMatchObject({ title: 'ハッチの音', version: 3 });
    expect(await call('study.move', { id: 'ハッチの音', to: 'put_away' })).toMatchObject({ ok: true });
    expect(await call('study.move', { id: '「ハッチの音」', to: 'take_back' })).toMatchObject({ ok: true });
    expect(await call('study.delete', { id: 'ハッチの音' })).toMatchObject({ ok: true });
    expect(store.study.get(scope, id)).toBeNull();
    // In the trash only reading and restoring find it.
    expect(await call('study.rename', { id: 'ハッチの音', title: 'x' })).toMatchObject({ ok: false, failure: 'not_found' });
    expect(await call('study.read', { id: 'ハッチの音' })).toMatchObject({ ok: true });
    expect(await call('study.restore', { id: '『ハッチの音』' })).toMatchObject({ ok: true });
    expect(store.study.get(scope, id)).toMatchObject({ title: 'ハッチの音' });
  });

  it('does not guess between two pieces under one title: it gives both ids and stages; an unknown title is not found', async () => {
    const { call } = harness();
    const first = idIn(await call('study.create', { kind: 'note', title: '覚え書き', body: '一つ目のメモ。' }));
    const second = idIn(await call('study.create', { kind: 'note', title: '覚え書き', body: '二つ目のメモ、別のこと。' }));
    const both = await call('study.read', { id: '『覚え書き』' });
    expect(both).toMatchObject({ ok: false, failure: 'conflict', refusal: { wouldWork: expect.stringContaining('id') } });
    expect(both.text).toContain(`id: ${first}｜メモ「覚え書き」`);
    expect(both.text).toContain(`id: ${second}｜メモ「覚え書き」`);
    expect((await call('study.read', { id: second })).text).toContain('二つ目のメモ');
    // An exact title wins over one that only matches when normalised.
    idIn(await call('study.create', { kind: 'note', title: '覚え書き 2', body: '三つ目。' }));
    expect((await call('study.read', { id: '覚え書き 2' })).text).toContain('三つ目');
    expect(await call('study.read', { id: 'ない題名' })).toMatchObject({ ok: false, failure: 'not_found', refusal: { wouldWork: expect.stringContaining('study.list') } });
    // A title of one character is accepted by the schema; the description says a title is fine.
    expect(shannonTool('study.read')!.input.properties.id).toMatchObject({ minLength: 1 });
    expect(shannonTool('study.read')!.description).toContain('題名でもよい');
  });

  it('prefers the live piece under a title for reading and changing, and the one in the trash for restoring (review 6)', async () => {
    const { call, store } = harness();
    const old = idIn(await call('study.create', { kind: 'note', title: '買い物', body: '古いメモ。' }));
    expect(await call('study.delete', { id: old })).toMatchObject({ ok: true });
    const live = idIn(await call('study.create', { kind: 'note', title: '買い物', body: '新しいメモ、別の中身。' }));
    expect((await call('study.read', { id: '買い物' })).text).toContain('新しいメモ');
    expect(await call('study.rename', { id: '『買い物』', title: '買い物リスト' })).toMatchObject({ ok: true });
    expect(store.study.get(scope, live)).toMatchObject({ title: '買い物リスト' });
    expect(await call('study.restore', { id: '買い物' })).toMatchObject({ ok: true });
    expect(store.study.get(scope, old)).toMatchObject({ title: '買い物' });
    // Two in the trash under one title are still not guessed.
    const another = idIn(await call('study.create', { kind: 'note', title: '買い物', body: '三つ目のまったく違う中身。' }));
    await call('study.delete', { id: old });
    await call('study.delete', { id: another });
    expect(await call('study.restore', { id: '買い物' })).toMatchObject({ ok: false, failure: 'conflict' });
  });
});
