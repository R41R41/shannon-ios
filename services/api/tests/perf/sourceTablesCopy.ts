/* Which tables a receipt's answer and a moment (the guard's epoch) read, on a copy of a real database (exploration, not a test). */
import { DatabaseSync } from 'node:sqlite';
import { SQLiteShannonStore } from '../../src/infra/sqlite/sqliteStore.js';
import { SkillMemory } from '../../src/mind/memory/memoryPorts.js';
import { skillTurnPorts } from '../../src/wiring/skillMemoryWiring.js';
import { createFcaReadSources } from '../../src/wiring/fcaReadSources.js';
import { createTaskRuntimeWiring } from '../../src/wiring/taskRuntimeWiring.js';
import { MemoryWithholding } from '../../src/mind/memory/memoryVisibility.js';
import { conversationSecrets } from '../../src/mind/inhibition/disclosurePorts.js';
import { actionHarness } from '../support/actionThreadHarness.js';

const path = process.env.DB!, taskId = process.env.TASK!, scope = 'owner';
const clock = { at: Date.parse(process.env.AT ?? '2026-10-20T01:40:00.000Z') };
const now = () => new Date(clock.at).toISOString();
console.info = () => {}; console.warn = () => {};
const store = new SQLiteShannonStore({ path, now, moodHistory: null, predictionShadow: false, decisionTraces: false, predictionLedger: false, choiceLedger: false });
const skillDb = new DatabaseSync(path);
const memory = new SkillMemory({ database: skillDb, createsSchema: false });
const skills = skillTurnPorts(memory, scopeKey => store.snapshot(scopeKey), store);
const reader = createFcaReadSources({ ownerScope: scope, ownerAlone: () => true, state: store, conversations: store, now,
  skill: (scopeKey, id, revision) => skills.readSource?.(scopeKey, id, revision) ?? null,
  skillChecks: (scopeKey, renew) => skills.readSourceChecks?.(scopeKey, renew) ?? null });
store.readSourceVisible = reader;
const runtime = createTaskRuntimeWiring({ db: store.fcaDatabase(), actions: actionHarness(now).actions, scopeKey: scope, ownerAlone: () => true, now,
  canRunTask: () => false, model: { async decide() { throw new Error('unused'); }, toolResults: results => ({ results }) } }).runtime;
const sources = runtime.taskSources(scope, taskId);
const receipts = [...new Map(sources.flatMap(source => (source.readSourceIds ?? []).map(id => [`${id} ${source.observedAt}`, [id, source.observedAt] as const]))).values()];
// Every statement is compiled again after a schema change, so the authorizer sees what each region reads.
let region = 'setup';
const read = new Map<string, Set<string>>();
for (const db of [store.fcaDatabase(), skillDb]) {
  db.setAuthorizer((action, table) => {
    if (action === 20 && table) { let tables = read.get(region); if (!tables) read.set(region, tables = new Set()); tables.add(String(table)); }
    return 0;
  });
}
store.fcaDatabase().exec('CREATE TABLE bench_schema_touch(x INTEGER); DROP TABLE bench_schema_touch;');
region = 'epoch';
const state = store.snapshot(scope), candidates = store.experienceCandidates(scope);
const withholding = new MemoryWithholding(state, store, scope, candidates);
withholding.withheldExperiences();
conversationSecrets(state, { experienceCandidates: () => candidates }, scope).carries('テスト');
withholding.withholdsReply({ text: 'テスト', observedAt: now(), recalledMemoryIds: sources.flatMap(source => source.recalledMemoryIds).slice(0, 50) });
region = 'answer';
const shared = { state, withholding: new MemoryWithholding(state, store, scope, candidates), walk: {} };
let visible = 0;
shared.withholding.withReadSnapshot(() => { for (const [id, at] of receipts) if (reader(scope, id, at, shared)) visible += 1; });
console.log(`receipts=${receipts.length} visible=${visible} families=${[...new Set(receipts.map(([id]) => id.split('://')[0]))].join(',')}`);
for (const [name, tables] of read) if (name !== 'setup') console.log(`${name}: ${[...tables].sort().join(' ')}`);
