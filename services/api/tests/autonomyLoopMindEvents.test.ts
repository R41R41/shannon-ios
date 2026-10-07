import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { SQLiteShannonStore } from '../src/infra/sqlite/sqliteStore.js';
import { SQLiteInitiativeStore } from '../src/surfaces/outreach/store/initiativeStore.js';
import { SQLiteReachOutSpeaker } from '../src/surfaces/outreach/reachOutDelivery.js';
import { MIND_INBOX_AUDIENCES, MIND_INBOX_KINDS, checkedMindInboxDraft } from '../src/contracts/mindInboxContract.js';
import { configuredMind, configuredMindInbox } from '../src/wiring/mindWiring.js';
import { FakeModel, loopHarness, runUntilIdle } from './autonomyLoopHarness.js';
import { apiSourceNames, importedModules, readApiSource } from './support/sources.js';

/**
 * Syzygy ADR-0008 stage 3: her own time is handed one function of the mind, `emitMindEvent`, and nothing else (rule
 * `own-time-without-private-stores`, `docs/mind-workspace-contract.md`). What it hands is a row of closed fields: a step's kind or
 * tool, how it ended, who could see her; never a word. The conversation's workspace then says what she did, to the owner alone.
 */
const directory = mkdtempSync(join(tmpdir(), 'shannon-loop-mind-'));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

describe('her own time and the mind', () => {
  it('hands the mind a step that did something, as closed values, and nothing for a thought or a rest', async () => {
    const path = join(directory, 'loop.sqlite');
    const clock = { at: '2026-10-07T01:00:00.000Z' };
    const persistent = new SQLiteShannonStore({ path, now: () => clock.at });
    const initiatives = new SQLiteInitiativeStore(path, () => clock.at);
    const mind = configuredMind({}, { databasePath: path, now: () => clock.at, schedule: task => task() })!;
    const emitted: unknown[] = [];
    const inbox = configuredMindInbox({}, { databasePath: path })!;
    const model = new FakeModel();
    const speaker = new SQLiteReachOutSpeaker(path);
    const harness = loopHarness({ path: join(directory, 'autonomy.sqlite'), clock, model, reachOuts: speaker,
      emitMindEvent: (scopeKey, draft, at) => { emitted.push(draft); inbox.emit(scopeKey, draft, at); } });
    model.plans = [{ thought: 'ライ氏はいま何をしているのでしょう。', steps: [{ action: 'reach_out', reason: 'wonder' }] }];
    await runUntilIdle(harness.loop);
    expect(model.kinds()).toContain('reach_out');
    // One row: the message she sent; her thoughts and her rest are not handed over.
    expect(emitted).toEqual([{ kind: 'own_time_step', code: 'done', audience: 'owner', source: 'own_time', sourceId: expect.any(String), tool: 'owner.reach_out' }]);
    for (const draft of emitted) expect(() => checkedMindInboxDraft(draft as never)).not.toThrow();
    mind.host!.tick();
    expect(mind.host!.view('owner', clock.at).held.map(item => item.surface)).toEqual(['own_time']);
    mind.close(); inbox.close(); harness.store.close(); speaker.close(); initiatives.close(); persistent.close();
  });

  it('is handed nothing else of the mind: no loop module names the workspace, perception or the host', () => {
    const loopSources = apiSourceNames().filter(name => /^autonomyLoop.*\.ts$/u.test(name));
    for (const name of loopSources) {
      const source = readApiSource(name);
      expect(source, name).not.toMatch(/MindHost|MindTurnPorts|perceive\(|workspacePorts|perceptionPorts|mindInboxStore|render\(/u);
      for (const imported of importedModules(name)) expect(imported, name).not.toMatch(/^(?:mindHost|promptLayout|workspace.*|perception.*|.*Perception|mindInbox.*|mindWiring)\.ts$/u);
    }
    // The one member of the mind in her step dependencies, and its closed shape.
    const steps = readApiSource('autonomyLoopSteps.ts');
    expect(steps.match(/^\s+emitMindEvent\?:/gmu)).toHaveLength(1);
    expect(steps).toMatch(/kind: 'own_time_step';\n\s+code: 'done' \| 'failed';\n\s+audience: 'owner' \| 'others';\n\s+source: 'own_time';\n\s+sourceId: string;\n\s+tool: string;\n\}/u);
    expect([...MIND_INBOX_KINDS]).toContain('own_time_step');
    expect([...MIND_INBOX_AUDIENCES]).toEqual(['owner', 'others']);
    // The worker opens the inbox's writer through the wiring, and hands the loop its function only.
    const worker = readFileSync(new URL('../src/autonomyWorker.ts', import.meta.url), 'utf8');
    expect(worker).toContain("...(mindInbox ? { emitMindEvent: mindInbox.emit } : {}),");
  });
});
