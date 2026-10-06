import type { AutonomyReachOuts } from '../src/autonomyLoopReachOutStep.js';
import { AutonomyToolResults } from '../src/autonomyLoopToolStep.js';
import { digest, type ScenarioCall } from './autonomyLoopKillSwitchScenario.js';
import { FakeAether } from './fakeAetherServer.js';
import { callKind, loopHarness, runUntilIdle, type LoopHarnessOptions } from './autonomyLoopHarness.js';

/**
 * One session of her own time with her tools wired and Aether configured (a fake Aether over real HTTP): she searches her
 * folder, reads a document of it, writes one, and rests. The same file was run on a10fdedd, the commit before her own time
 * could read the owner's documents, and `ownerDocumentsOwnTime.test.ts` holds the digests of that run: with
 * `SHANNON_AUTONOMY_OWNER_DOCUMENTS` unset, `off` or mistyped every prompt is that commit's. Identifiers are random, so they
 * are replaced before a prompt is digested (`digest`); nothing else is.
 */
export const OWN_TIME_PRICES = { SHANNON_AUTONOMY_MODEL_PRICES_JSON: '{"gemini-3.8-flash":{"input":10,"output":10},"gpt-5.6-luna":{"input":10,"output":10}}', SHANNON_AUTONOMY_DAILY_BUDGET_YEN: '2000' };
const FOLDER = 'project_shannon_folder';

export async function ownTimeWithTools(flag: string | undefined, extra: Partial<LoopHarnessOptions> = {}): Promise<ScenarioCall[]> {
  const fake = new FakeAether();
  try {
    const access = await fake.access();
    fake.ownerDocument('来月の計画', '湖のほとりの小さな宿に泊まる。');
    const note = fake.put({ title: '駅のメモ', body: '夕方の駅は、音から書くとよさそう。', projectIds: [FOLDER], tags: [], type: 'note' });
    const harness = loopHarness({
      sessions: true, aether: access, toolResults: new AutonomyToolResults(), ...extra,
      environment: { ...OWN_TIME_PRICES, ...extra.environment },
      ...(flag === undefined ? {} : { loopEnvironment: { SHANNON_AUTONOMY_OWNER_DOCUMENTS: flag } }),
    });
    harness.model.plans = [
      { thought: '自分のフォルダを探します。', steps: [{ action: 'tool', name: 'aether.search', input: { query: '駅', scope: 'shannonFolder' } }] },
      { thought: '読みます。', steps: [{ action: 'tool', name: 'aether.read', input: { documentId: note.id } }] },
      { thought: '書いておきます。', steps: [{ action: 'tool', name: 'aetherFolder.create', input: { title: '読み返して', body: '駅の場面は音から書く。' } }] },
      { thought: '休みます。', steps: [{ action: 'rest', resumeInMinutes: 120, reason: 'ここまで' }] },
    ];
    await runUntilIdle(harness.loop);
    const calls = harness.model.calls.map(call => ({ kind: callKind(call), digest: digest(`${call.system}\n---\n${call.prompt}`) }));
    harness.store.close();
    return calls;
  } finally {
    await fake.stop();
  }
}

/**
 * The same session, longer: after her tools she reads a public page and writes a note about it, drafts a story, and speaks up
 * about what she wrote. Every kind of prompt her own time sends with the switch off (thinking, note, draft, message) is digested;
 * the digests of a10fdedd are in `ownerDocumentsOwnTime.test.ts`.
 */
export async function ownTimeFullDay(flag: string | undefined): Promise<ScenarioCall[]> {
  const fake = new FakeAether();
  try {
    const access = await fake.access();
    fake.ownerDocument('来月の計画', '湖のほとりの小さな宿に泊まる。');
    const note = fake.put({ title: '駅のメモ', body: '夕方の駅は、音から書くとよさそう。', projectIds: [FOLDER], tags: [], type: 'note' });
    const said: string[] = [];
    const reachOuts: AutonomyReachOuts = { sentOn: () => said.length, lastSentAt: () => null, audience: () => null, say: (_scope, input) => { said.push(input.text); return 'sent'; } };
    const harness = loopHarness({
      sessions: true, aether: access, toolResults: new AutonomyToolResults(), reachOuts, environment: OWN_TIME_PRICES,
      ...(flag === undefined ? {} : { loopEnvironment: { SHANNON_AUTONOMY_OWNER_DOCUMENTS: flag } }),
    });
    harness.model.plans = [
      { thought: '自分のフォルダを探します。', steps: [{ action: 'tool', name: 'aether.search', input: { query: '駅', scope: 'shannonFolder' } }] },
      { thought: '読みます。', steps: [{ action: 'tool', name: 'aether.read', input: { documentId: note.id } }] },
      { thought: '外も読みます。', steps: [{ action: 'read', url: 'https://example.org/station' }, { action: 'note' }] },
      { thought: '書きます。', steps: [{ action: 'draft', idea: '誰もいない駅に残された傘の話' }] },
      { thought: '話します。', steps: [{ action: 'reach_out', reason: 'share' }] },
      { thought: '休みます。', steps: [{ action: 'rest', resumeInMinutes: 120, reason: 'ここまで' }] },
    ];
    await runUntilIdle(harness.loop, 40);
    const calls = harness.model.calls.map(call => ({ kind: callKind(call), digest: digest(`${call.system}\n---\n${call.prompt}`) }));
    harness.store.close();
    return calls;
  } finally {
    await fake.stop();
  }
}
