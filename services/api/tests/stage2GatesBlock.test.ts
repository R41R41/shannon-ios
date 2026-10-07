import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import { createLocalApiKernel } from '../src/wiring/apiKernelWiring.js';
import type { ShannonChatModel, ShannonChatModelRequest, ShannonVoiceModelRequest } from '../src/infra/models/chatModel.js';
import { TurnDeadline, TEXT_TURN_DEADLINE } from '../src/mind/action/respond/turnDeadline.js';
import type { ShannonModelToolSession } from '../src/infra/models/chatModelTools.js';
import { SQLiteShannonStore } from '../src/infra/sqlite/sqliteStore.js';
import { createInMemoryAutonomyService } from '../src/wiring/autonomyServiceWiring.js';
import { SkillMemory } from '../src/mind/memory/skillMemory.js';
import { encodeSkill, type SkillDocument } from '../src/mind/memory/skillDocument.js';
import { ShannonSkillConsolidator } from '../src/mind/sleep/skillConsolidation.js';
import type { SkillSleepModel } from '../src/mind/sleep/skillSleepModel.js';
import type { TurnChooser } from '../src/mind/selectors/turnChoices.js';
import { withToolMenu } from '../src/mind/tools/shannonToolMenu.js';
import { shannonTool } from '../src/mind/tools/shannonTools.js';
import { toolSessionMemory } from '../src/mind/tools/shannonToolTypes.js';
import type { ReadToolPorts } from '../src/mind/tools/shannonReadTools.js';
import { readToolPorts } from '../src/wiring/skillRoutingWiring.js';
import { configuredSkillExport } from '../src/wiring/skillMemoryWiring.js';
import { configuredSonnet, tieredChatModel } from '../src/wiring/sonnetWiring.js';
import { configuredTurnRouting } from '../src/wiring/turnRoutingWiring.js';
import { FakeAetherFolder } from './support/fakeAetherFolder.js';
import { anthropicFixture, scriptedAnthropic } from './support/anthropicFixtures.js';

/**
 * Every stage-2 gate really blocks (Syzygy ADR-0008 §14, after Genesis, one of whose gates never worked because of a missing
 * import). Each test drives the gate through the code the server runs and checks that what lies behind it was never reached
 * (a port, an executor, a write, a request), beside a positive control that shows the same path does reach it when the gate is open.
 */
const AT = '2026-10-07T03:00:00.000Z';
const directory = mkdtempSync(join(tmpdir(), 'shannon-stage2-gates-'));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

function spiedReads() {
  const calls: string[] = [];
  const ports: ReadToolPorts = {
    notion: async query => { calls.push(`notion:${query}`); return { text: 'ページ', sources: [] }; },
    voyagerTasks: async query => { calls.push(`tasks:${query}`); return 'タスク'; },
    upcoming: () => { calls.push('upcoming'); return '予定'; },
    places: async () => { calls.push('places'); return '候補'; },
  };
  return { calls, ports };
}

describe('the read tools\' gate', () => {
  const context = { scopeKey: 'owner', memory: toolSessionMemory('gates') };

  it('never reaches a read port with anyone else present, in her own time, or with the switch off', async () => {
    const { calls, ports } = spiedReads();
    const autonomy = createInMemoryAutonomyService(() => AT);
    autonomy.tools.useReads(ports);
    for (const name of ['notion.read', 'voyager.tasks', 'schedule.upcoming', 'places.search']) {
      const input = name === 'schedule.upcoming' ? {} : { query: '設定' };
      expect((await autonomy.tools.call(name, input, { ...context, surface: 'text', audience: 'others' })).ok, name).toBe(false);
      expect((await autonomy.tools.call(name, input, { ...context, surface: 'voice', audience: 'others' })).ok, name).toBe(false);
      expect('result' in autonomy.tools.prepare(name, input, { ...context, surface: 'autonomy', audience: 'owner_alone' }), name).toBe(true);
    }
    expect(calls).toEqual([]);
    // Positive control: the owner alone in a conversation reaches the port.
    expect((await autonomy.tools.call('notion.read', { query: '設定' }, { ...context, surface: 'text', audience: 'owner_alone' })).ok).toBe(true);
    expect(calls).toEqual(['notion:設定']);
    // Switched off, the wiring hands no ports: the tools do not exist on the server.
    expect(readToolPorts({ SHANNON_READ_TOOLS: 'off' }, { notion: null, voyagerCatalog: { searchTasks: async () => [], listProjects: async () => [] }, upcoming: { promptFor: () => '' }, chatModel: null as never })).toBeNull();
    const off = createInMemoryAutonomyService(() => AT);
    expect(off.tools.offered('text', 'owner_alone', 'owner').some(tool => tool.name === 'notion.read')).toBe(false);
    expect(await off.tools.call('notion.read', { query: '設定' }, { ...context, surface: 'text', audience: 'owner_alone' })).toMatchObject({ ok: false, failure: 'not_offered' });
  });
});

describe('tool_open\'s limits', () => {
  function base(offered: string[]) {
    const ran: string[] = [];
    const session = {
      definitions: offered.map(name => shannonTool(name)!), maximumCalls: 6, deadline: new TurnDeadline(TEXT_TURN_DEADLINE),
      refuse: (name: string) => JSON.stringify({ ok: false, text: `refused ${name}` }),
      start: async (name: string) => { ran.push(name); return { output: JSON.stringify({ ok: true, text: 'ran' }), note: () => {} }; },
      call: async (name: string) => { ran.push(name); return JSON.stringify({ ok: true, text: 'ran' }); },
    } as unknown as ShannonModelToolSession;
    return { ran, session };
  }
  type Menu = ShannonModelToolSession & { meta(name: string, argumentsJson: string): string | null };

  it('never opens or runs a tool the turn does not offer, nor one it offers but has not opened', async () => {
    // The turn offers reads only (words not trusted to write): study.create is not on its offer.
    const { ran, session } = base(['study.list', 'study.read']);
    const menu = withToolMenu(session, ['study_read']) as Menu;
    expect(JSON.parse(menu.meta('tool_open', JSON.stringify({ name: 'study_create' }))!)).toMatchObject({ ok: false, failure: 'not_offered' });
    expect(menu.definitions.map(tool => tool.name)).not.toContain('study.create');
    expect(await menu.call('study_create', '{}')).toContain('refused study_create');
    // Offered but not opened: refused like a name the turn does not offer.
    expect(await menu.call('study_list', '{}')).toContain('refused study_list');
    expect(ran).toEqual([]);
    // Positive control: opened, it runs through the turn's own session.
    expect(JSON.parse(menu.meta('tool_open', JSON.stringify({ name: 'study_list' }))!)).toMatchObject({ ok: true });
    await menu.call('study_list', '{}');
    expect(ran).toEqual(['study_list']);
    // Opening is not a call: the turn's limit is the offer's.
    expect(menu.maximumCalls).toBe(6);
  });
});

describe('the skill sleep\'s writes', () => {
  const doc = (name: string, steps = '1. 三つ挙げる'): SkillDocument => ({ name, description: '週のふりかえりをする時', steps, aids: '- なし', references: '- 会話から' });
  const ok = { carries: () => false };
  const at = (minute: number) => new Date(Date.parse(AT) + minute * 60_000).toISOString();

  function memory() {
    const skills = new SkillMemory({ database: new DatabaseSync(':memory:'), createsSchema: true, defer: task => task(), log: () => {} });
    const id = (name: string) => (skills.create('owner', { draft: doc(name), evidence: [] }, ok, at(0)) as { skillId: string }).skillId;
    const pinned = id('pinned-one');
    const owned = id('owned-one');
    const free = id('free-one');
    for (const skillId of [pinned, owned, free]) skills.store.setStatus('owner', skillId, 'active', 'test', at(1));
    skills.store.setPinned('owner', pinned, true);
    expect(skills.adoptOwnerEdit('owner', owned, encodeSkill({ ...doc('owned-one', '1. 散歩しながら話す'), description: 'ライ氏が直した' }), { documentId: 'doc-1', version: 2 }, ok, at(2))).toBe('adopted');
    const page = (skills.createPattern('owner', { kind: 'strategy', title: '五つ挙げる', body: '五つ挙げる。' }, [], ok, at(2)) as { patternId: string }).patternId;
    return { skills, pinned, owned, free, page };
  }

  it('never writes to a pinned skill or the owner\'s version: no patch, branch, rollback, retirement or consolidation', () => {
    const { skills, pinned, owned, free, page } = memory();
    const before = [pinned, owned].map(skillId => ({ skill: skills.store.get('owner', skillId)!, revisions: skills.store.revisions('owner', skillId).length }));
    const patch = (skillId: string, version: number, extra: Record<string, unknown> = {}) =>
      skills.revise('owner', skillId, version, { replacements: [{ find: '三つ', replace: '五つ' }], evidence: [], purposePatternIds: [page], ...extra }, ok, at(3));
    expect(patch(pinned, 1)).toEqual({ rejected: 'pinned' });
    expect(patch(owned, 2)).toEqual({ rejected: 'owner_edited' });
    expect(patch(owned, 2, { baseRevisionId: `${owned}:v1` })).toEqual({ rejected: 'owner_edited' });
    expect(skills.rollback('owner', pinned, 1, 'sleep', at(3))).toBe('pinned');
    expect(skills.rollback('owner', owned, 1, 'sleep', at(3))).toBe('owner_edited');
    expect(skills.create('owner', { draft: doc('new-one'), evidence: [], consolidates: [pinned] }, ok, at(3))).toEqual({ rejected: 'pinned' });
    expect(skills.create('owner', { draft: doc('new-two'), evidence: [], consolidates: [owned] }, ok, at(3))).toEqual({ rejected: 'owner_edited' });
    // Uses that would retire any other skill.
    for (const skillId of [pinned, owned, free]) {
      const name = skills.store.get('owner', skillId)!.name;
      for (let index = 0; index < 6; index += 1) {
        skills.used('owner', name, { talk: `${name}-${index}`, growth: 0 }, at(4 + index));
        skills.nextTurn('owner', `${name}-${index}`, 0, at(4 + index));
      }
    }
    expect(skills.lifecycle('owner', at(20), ok).retired).toEqual([free]);
    for (const [index, skillId] of [pinned, owned].entries()) {
      expect(skills.store.get('owner', skillId)).toMatchObject({ status: 'active', version: before[index]!.skill.version, body: before[index]!.skill.body });
      expect(skills.store.revisions('owner', skillId)).toHaveLength(before[index]!.revisions);
    }
  });

  it('never lets the proposer reach them at night, whatever it answers', async () => {
    const { skills, pinned, owned, page } = memory();
    const answers = [pinned, owned].map(skillId => ({ action: 'propose', open: [], operation: 'patch', skillId, expectedVersion: skills.store.get('owner', skillId)!.version,
      name: 'x', description: 'x', steps: '1. x', aids: '- x', references: '- x', replacements: [{ find: '三つ', replace: '五つ' }], purposePatternIds: [page], consolidates: [] }));
    const proposer: SkillSleepModel = { model: 'scripted', json: async () => answers.shift() ?? { ...answers[0], action: 'none' } };
    const before = [pinned, owned].map(skillId => skills.store.get('owner', skillId)!.body);
    const night = await new ShannonSkillConsolidator(skills, { knowledge: () => [], experiences: () => [], choices: () => [], visible: () => () => true, check: () => ok },
      { maintainer: null, proposer }, { skillBudgetUsd: 1, now: () => at(30), log: () => {} }).consolidate('owner', at(-1440), at(30));
    expect(night.rejections).toEqual(expect.arrayContaining(['pinned', 'owner_edited']));
    expect([pinned, owned].map(skillId => skills.store.get('owner', skillId)!.body)).toEqual(before);
  });
});

describe('the export\'s holds', () => {
  it('never writes a copy the owner deleted, nor over an edit of his it could not adopt', async () => {
    const store = new SQLiteShannonStore({ path: join(directory, 'export.sqlite'), now: () => AT });
    const skills = new SkillMemory({ database: new DatabaseSync(join(directory, 'export.sqlite')), createsSchema: true, defer: task => task(), log: () => {} });
    const ok = { carries: () => false };
    const ids = ['deleted-one', 'held-one', 'free-one'].map(name => (skills.create('owner', { draft: { name, description: 'ふりかえりの時', steps: '1. 三つ挙げる', aids: '- なし', references: '- 会話から' }, evidence: [] }, ok, AT) as { skillId: string }).skillId);
    const folder = new FakeAetherFolder();
    const run = configuredSkillExport({}, { memory: skills, store, access: folder, log: () => {} })!;
    await run('owner', AT);
    const page = (skills.createPattern('owner', { kind: 'strategy', title: '五つ', body: '五つ。' }, [], ok, AT) as { patternId: string }).patternId;
    skills.holdExport('owner', ids[0]!, 'owner_deleted', AT);
    skills.holdExport('owner', ids[1]!, 'owner_edit_unadopted', AT);
    for (const skillId of ids) {
      skills.store.setStatus('owner', skillId, 'active', 'test', AT);
      expect(skills.revise('owner', skillId, 1, { replacements: [{ find: '三つ', replace: '五つ' }], evidence: [], purposePatternIds: [page] }, ok, AT)).toEqual({ version: 2 });
    }
    const writes = folder.writes.length;
    await run('owner', new Date(Date.parse(AT) + 60_000).toISOString());
    const written = folder.writes.slice(writes).map(write => write.documentId);
    // Positive control: the one without a hold is written again; the held ones are not.
    expect(written).toEqual([skills.store.get('owner', ids[2]!)!.aetherDocumentId]);
    for (const skillId of ids.slice(0, 2)) expect(folder.documents.get(skills.store.get('owner', skillId)!.aetherDocumentId ?? '')?.body).not.toContain('五つ');
    store.close();
  });
});

describe('the Sonnet routing switch', () => {
  class Luna implements ShannonChatModel {
    readonly mode = 'openai' as const;
    readonly model = 'luna';
    readonly all: Array<ShannonChatModelRequest | ShannonVoiceModelRequest> = [];
    async generate(request: ShannonChatModelRequest) { this.all.push(request); return { mode: this.mode, model: this.model, reply: 'はい。' }; }
    async generateVoice(request: ShannonVoiceModelRequest) { this.all.push(request); return { mode: this.mode, model: this.model, reply: 'はい。' }; }
  }
  const strong: TurnChooser = { difficulty: true, choose: async () => ({ menu: null, difficulty: { taskKind: 'analysis', needsStrongModel: 0.97, needsVerification: 0.05, multiStep: 0.05 }, retry: null }) };

  async function turn(environment: Record<string, string>) {
    const anthropic = scriptedAnthropic([anthropicFixture('structured-answer')]);
    const luna = new Luna();
    const sonnet = configuredSonnet(environment, { fetch: anthropic.fetcher });
    const database = new DatabaseSync(':memory:');
    const routing = configuredTurnRouting(environment, { databasePath: null, database, choices: null, sonnet, defer: task => task() })!;
    const api = createLocalApiKernel(() => AT, { chatModel: tieredChatModel(luna, sonnet), autonomy: createInMemoryAutonomyService(() => AT), turnChooser: strong, turnRouting: routing.routing });
    await api.dispatch({ method: 'POST', path: '/v1/chat', body: { scopeKey: 'owner', threadId: 'thread', message: '相対性理論を丁寧に説明して' } });
    database.close();
    return { anthropic: anthropic.bodies.length, luna: luna.all.at(-1) as ShannonChatModelRequest | undefined };
  }

  it('sends nothing to Anthropic without SHANNON_SONNET_ROUTING=on, even with the key and a turn that asks for the strong model', async () => {
    for (const environment of [{ ANTHROPIC_API_KEY: 'k' }, { ANTHROPIC_API_KEY: 'k', SHANNON_SONNET_ROUTING: 'off' }] as Array<Record<string, string>>) {
      const { anthropic, luna } = await turn(environment);
      expect(anthropic).toBe(0);
      expect(luna?.tier).toBe('luna_plus');
    }
    // Positive control: switched on, the same turn goes to Anthropic and not to luna.
    const on = await turn({ ANTHROPIC_API_KEY: 'k', SHANNON_SONNET_ROUTING: 'on' });
    expect(on.anthropic).toBeGreaterThan(0);
    expect(on.luna).toBeUndefined();
  });
});
