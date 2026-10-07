import { afterEach, describe, expect, it } from 'vitest';
import { configuredAutonomy } from '../src/mind/inhibition/autonomyBudget.js';
import { autonomyDayLog, autonomyDayPhrases } from '../src/mind/inhibition/autonomyDayLog.js';
import { configuredAutonomyLoop } from '../src/mind/action/ownTime/autonomyLoopConfig.js';
import { AutonomyToolResults } from '../src/mind/action/ownTime/autonomyLoopToolStep.js';
import { ShannonAutonomyService } from '../src/mind/action/ownTime/autonomyService.js';
import { SQLiteAutonomyStore } from '../src/wiring/autonomyStoreWiring.js';
import { toolSessionMemory } from '../src/mind/tools/shannonToolTypes.js';
import { offeredTools } from '../src/mind/tools/shannonTools.js';
import { ownTimeFullDay, ownTimeWithTools, OWN_TIME_PRICES } from './ownerDocumentsScenario.js';
import { FakeAether } from './fakeAetherServer.js';
import { loopHarness, runUntilIdle, scope, type LoopHarnessOptions } from './autonomyLoopHarness.js';

/**
 * Her own time reading the owner's documents (owner decision 2026-10-06, Syzygy ADR-0007 「自分の時間に所有者の文書を読む」):
 * `ownerDocs.search` and `ownerDocs.read`, her own time only, for one of her active pursuits, only while
 * `SHANNON_AUTONOMY_OWNER_DOCUMENTS=on`. Unset, off or mistyped, everything is what it was on a10fdedd.
 */
const servers: FakeAether[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => server.stop())); });

/** `ownerDocumentsScenario.ts` run on a10fdedd (the commit before), with the flag unset, `off`, `On` and `on`: all four equal. */
const OWN_TIME_AT_A10FDEDD = [['think', '6226278233e39c92'], ['think', '1faff08ce417ecb3'], ['think', '3a1a5ce0540cca3f'], ['think', 'f9cb79957eb8404c']];
/**
 * `ownTimeFullDay` on a10fdedd: her tools, then a note, a draft and a message of hers; the same with the flag unset, `off` and `on` there.
 * Her temperament is taken out before digesting (`withoutTemperament`). One digest re-recorded on the stage-2 branch (2026-10-06,
 * scope (a) of owner decision "a"): the second thinking prompt prints what a thinking step needs free, estimated from the prompt's
 * length, and her persona's 65 more characters move it from 約24円 to 約25円 (6c50b1b6d37584fd before); nothing else changed.
 */
const FULL_DAY_AT_A10FDEDD = [
  ['think', 'fc7c0d375915ce41'], ['think', '0566c8e4b4d7d3b3'], ['think', '7ec6855733e08835'], ['note', '2977210b0f7b5e1c'], ['think', 'd1bbc8f5a63bb549'],
  ['draft', '3162903bd56a2e60'], ['think', '953d19b568a648dd'], ['reach_out', '09597eda74b05e3c'], ['think', 'b5f9fb6265c1b2b0'],
];
const rest = { action: 'rest', resumeInMinutes: 120, reason: 'ここまで' };

async function ownTime(flag: string | undefined = 'on', options: Partial<LoopHarnessOptions> = {}) {
  const fake = new FakeAether();
  servers.push(fake);
  const access = await fake.access();
  const owners = fake.ownerDocument('来月の計画', '湖のほとりの小さな宿に泊まる。');
  const harness = loopHarness({
    sessions: true, aether: access, toolResults: new AutonomyToolResults(), ...options,
    environment: { ...OWN_TIME_PRICES, ...options.environment }, ...(flag === undefined ? {} : { loopEnvironment: { SHANNON_AUTONOMY_OWNER_DOCUMENTS: flag } }),
  });
  const pursuit = harness.store.pursuits.list(scope, harness.clock.at)[0]!.id;
  const ownerReads = () => fake.requests.filter(request => request.path === '/api/shannon/v1/document' && request.body.documentId === owners.id).length;
  return { fake, harness, owners, pursuit, ownerReads };
}

describe('the owner\'s documents in her own time: switched off, nothing changes', () => {
  it('sends byte for byte the prompts of a10fdedd with her tools and Aether wired, with the switch unset, off, or mistyped', async () => {
    for (const flag of [undefined, 'off', 'On', 'yes', 'true', ' on-ish']) {
      expect((await ownTimeWithTools(flag)).map(call => [call.kind, call.digest]), String(flag)).toEqual(OWN_TIME_AT_A10FDEDD);
    }
    // Switched on, every thinking prompt lists the two tools, so none is the old one.
    const on = await ownTimeWithTools('on');
    expect(on.every(call => !OWN_TIME_AT_A10FDEDD.some(([, digest]) => digest === call.digest))).toBe(true);
  });

  it('sends byte for byte a10fdedd\'s note, draft and message prompts too, and with the switch on only the thinking prompts change', async () => {
    for (const flag of [undefined, 'off', 'On', 'yes']) {
      expect((await ownTimeFullDay(flag)).map(call => [call.kind, call.digest]), String(flag)).toEqual(FULL_DAY_AT_A10FDEDD);
    }
    const on = (await ownTimeFullDay('on')).map(call => [call.kind, call.digest]);
    expect(on.filter(([kind]) => kind !== 'think')).toEqual(FULL_DAY_AT_A10FDEDD.filter(([kind]) => kind !== 'think'));
    expect(on.filter(([kind], index) => kind === 'think' && FULL_DAY_AT_A10FDEDD[index]![1] === on[index]![1])).toEqual([]);
  });

  it('reads `on` only, as the owner\'s context reads `off` only', () => {
    expect(configuredAutonomyLoop({}).ownerDocuments).toBe(false);
    for (const value of ['off', 'ON', 'yes', 'true', '1', '']) expect(configuredAutonomyLoop({ SHANNON_AUTONOMY_OWNER_DOCUMENTS: value }).ownerDocuments, value).toBe(false);
    expect(configuredAutonomyLoop({ SHANNON_AUTONOMY_OWNER_DOCUMENTS: ' on ' }).ownerDocuments).toBe(true);
  });

  it('keeps the tools out of the list and refuses a call of them as a name that does not exist, also when the loop is told of them without the switch', async () => {
    const { harness, pursuit, ownerReads } = await ownTime('off');
    harness.model.plans = [{ thought: '読みます。', steps: [{ action: 'tool', name: 'ownerDocs.search', input: { query: '宿', pursuitId: pursuit } }] }, { thought: '休みます。', steps: [rest] }];
    await runUntilIdle(harness.loop);
    expect(harness.model.prompts('think')[0]).not.toContain('ownerDocs');
    expect(harness.service.tools.knownTool('ownerDocs_read')).toBeNull();
    expect(harness.entries().some(entry => entry.tool?.startsWith('ownerDocs.'))).toBe(false);
    expect(ownerReads()).toBe(0);
  });
});

describe('the owner\'s documents in her own time: switched on', () => {
  it('reads one of his documents for an active pursuit, records a sentence and the address only, and has the text in front of her next thought only', async () => {
    const { harness, owners, pursuit } = await ownTime();
    harness.model.plans = [
      { thought: '探します。', steps: [{ action: 'tool', name: 'ownerDocs.search', input: { query: '宿', pursuitId: pursuit } }] },
      { thought: '読みます。', steps: [{ action: 'tool', name: 'ownerDocs_read', input: { documentId: owners.id, pursuitId: pursuit } }] },
      { thought: '書斎を見ます。', steps: [{ action: 'tool', name: 'study.list', input: {} }] },
      { thought: '休みます。', steps: [rest] },
    ];
    await runUntilIdle(harness.loop);
    const thoughts = harness.model.prompts('think');
    expect(thoughts[0]).toContain('- ownerDocs.search: ');
    expect(thoughts[0]).toContain('- ownerDocs.read: ');
    expect(thoughts[1]).toContain(`id: ${owners.id}｜「来月の計画」｜ライ氏の文書`);
    expect(thoughts[2]).toContain('湖のほとりの小さな宿に泊まる。');
    expect(thoughts[3]).not.toContain('湖のほとり');
    const decisions = harness.entries().filter(entry => entry.kind === 'decision' && entry.tool?.startsWith('ownerDocs.'));
    expect(decisions.map(entry => [entry.tool, entry.domain, entry.outcome]).sort()).toEqual([['ownerDocs.read', 'owner_documents_read', 'allowed'], ['ownerDocs.search', 'owner_documents_read', 'allowed']]);
    const read = harness.entries().find(entry => entry.kind === 'action' && entry.tool === 'ownerDocs.read')!;
    expect(read).toMatchObject({ outcome: 'done', costYen: 0, link: `aether://documents/${owners.id}`, summary: 'ライ氏のAetherの文書を1つ読みました。' });
    for (const entry of harness.entries()) expect(JSON.stringify(entry)).not.toMatch(/来月の計画|湖のほとり/u);
    // The day's log names it only on a day it happened.
    expect(autonomyDayLog(harness.entries())).toContain('ライ氏の文書を1つ読み');
    expect(autonomyDayPhrases([{ kind: 'action', outcome: 'done', tool: 'study.note' }])).toEqual(['メモを1つ書いた']);
  });

  it('requires a pursuit she is working on now: none, an unknown one, or a closed one reads nothing', async () => {
    const { harness, owners, pursuit, ownerReads } = await ownTime();
    const own = harness.service.addPursuit(scope, { kind: 'question', title: '宿の話', why: '気になるからです。', origin: 'self' }).pursuit!;
    harness.service.updatePursuit(scope, own.id, { status: 'done' });
    const memory = toolSessionMemory();
    expect(harness.service.tools.prepare('ownerDocs.read', { documentId: owners.id }, { scopeKey: scope, surface: 'autonomy', audience: 'owner_alone', memory }))
      .toMatchObject({ result: { ok: false, failure: 'invalid_input' } });
    harness.model.plans = [
      { thought: '読みます。', steps: [{ action: 'tool', name: 'ownerDocs.read', input: { documentId: owners.id, pursuitId: 'no-such-pursuit' } }] },
      { thought: '読みます。', steps: [{ action: 'tool', name: 'ownerDocs.read', input: { documentId: owners.id, pursuitId: own.id } }] },
      { thought: '休みます。', steps: [rest] },
    ];
    await runUntilIdle(harness.loop);
    const thoughts = harness.model.prompts('think');
    expect(thoughts[1]).toContain('台帳にない id だった');
    expect(thoughts[2]).toContain('その気になっていることは、いま進めていない');
    expect(ownerReads()).toBe(0);
    expect(harness.entries().some(entry => entry.tool === 'ownerDocs.read')).toBe(false);
    expect(pursuit).toBeTruthy();
  });

  it('is refused by the gate while paused or switched off, and reads nothing on a day whose budget is spent', async () => {
    const paused = await ownTime();
    paused.harness.model.plans = [{ thought: '読みます。', steps: [{ action: 'tool', name: 'ownerDocs.read', input: { documentId: paused.owners.id, pursuitId: paused.pursuit } }] }];
    paused.harness.model.during = kind => { if (kind === 'think') paused.harness.service.setPaused(scope, true); };
    expect(await runUntilIdle(paused.harness.loop)).toContain('paused');
    expect(paused.ownerReads()).toBe(0);
    expect(paused.harness.entries().some(entry => entry.kind === 'action' && entry.tool === 'ownerDocs.read')).toBe(false);

    // At the gate: a free domain of its own, refused while paused or switched off.
    const read = { domain: 'owner_documents_read', summary: 'ライ氏のAetherの文書を1つ読みます。', tool: 'ownerDocs.read' };
    expect(paused.harness.service.authorize(scope, read)).toMatchObject({ decision: 'forbidden', reason: 'paused' });
    paused.harness.service.setPaused(scope, false);
    expect(paused.harness.service.authorize(scope, read)).toMatchObject({ decision: 'allow', domain: 'owner_documents_read' });
    const off = await ownTime('on', { enabled: false });
    off.harness.model.plans = [{ thought: '読みます。', steps: [{ action: 'tool', name: 'ownerDocs.read', input: { documentId: off.owners.id, pursuitId: off.pursuit } }] }];
    expect(await runUntilIdle(off.harness.loop)).toEqual(['disabled']);
    expect(off.ownerReads()).toBe(0);
    expect(off.harness.service.authorize(scope, read)).toMatchObject({ decision: 'forbidden', reason: 'disabled' });

    // A day whose budget cannot pay for a thought: no thought, so no step of hers chooses to read.
    const poor = await ownTime('on', { environment: { SHANNON_AUTONOMY_DAILY_BUDGET_YEN: '1' } });
    poor.harness.model.plans = [{ thought: '読みます。', steps: [{ action: 'tool', name: 'ownerDocs.read', input: { documentId: poor.owners.id, pursuitId: poor.pursuit } }] }];
    expect(await runUntilIdle(poor.harness.loop)).toContain('budget');
    expect(poor.harness.model.calls).toHaveLength(0);
    expect(poor.ownerReads()).toBe(0);
  });

  it('never exists on a conversation surface, and her own time still searches and reads only her folder through aether.*', async () => {
    const { harness, owners, pursuit } = await ownTime();
    for (const surface of ['text', 'voice'] as const) {
      for (const audience of ['owner_alone', 'others'] as const) {
        expect(harness.service.tools.offered(surface, audience, scope).some(tool => tool.name.startsWith('ownerDocs.')), `${surface} ${audience}`).toBe(false);
        expect(offeredTools(surface, audience).some(tool => tool.name.startsWith('ownerDocs.'))).toBe(false);
      }
      const called = await harness.service.tools.call('ownerDocs.read', JSON.stringify({ documentId: owners.id, pursuitId: pursuit }), { scopeKey: scope, surface, audience: 'owner_alone', memory: toolSessionMemory() });
      expect(called).toMatchObject({ ok: false, failure: 'not_offered' });
    }
    expect(harness.service.tools.offered('autonomy', 'others', scope).some(tool => tool.name.startsWith('ownerDocs.'))).toBe(false);
    // An API process (no switch handed to its service) has no such tool at all, whatever its environment says.
    const other = new FakeAether();
    servers.push(other);
    const api = new ShannonAutonomyService({ store: new SQLiteAutonomyStore(':memory:'), config: configuredAutonomy({}), now: () => harness.clock.at, aether: { access: await other.access() } });
    expect(api.tools.knownTool('ownerDocs.read')).toBeNull();
    expect(api.tools.offered('autonomy', 'owner_alone', scope).some(tool => tool.name.startsWith('ownerDocs.'))).toBe(false);

    harness.model.plans = [
      { thought: '探します。', steps: [{ action: 'tool', name: 'aether.search', input: { query: '宿' } }] },
      { thought: '読みます。', steps: [{ action: 'tool', name: 'aether.read', input: { documentId: owners.id } }] },
      { thought: '休みます。', steps: [rest] },
    ];
    await runUntilIdle(harness.loop);
    const thoughts = harness.model.prompts('think');
    expect(thoughts[1]).toContain('自分の時間には、ライ氏の文書は探さない');
    expect(thoughts[2]).toContain('シャノン用フォルダの外の文書なので、いまは読まない。');
    expect(thoughts.join('\n')).not.toContain('湖のほとり');
    expect(harness.store.informed.sessionInformedAt(harness.store.loop.sessions.latestClosed(scope)!.cycleId)).toBeNull();
  });
});
