import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { InMemoryCompanionStateStore } from '@shannon/cognition';
import { actionHarness } from '../../../../tests/support/actionThreadHarness.js';
import { InMemoryConversationStore } from '../../../../src/mind/memory/store/conversationStore.js';
import { SQLiteAutonomyStore } from '../../../../src/wiring/autonomyStoreWiring.js';
import { ShannonToolRunner } from '../../../../src/mind/tools/toolRunnerPorts.js';
import type { HostFolderOperations } from '../../../../src/mind/action/ownTime/hostFolderOperations.js';
import { createTaskRuntimeWiring } from '../../../../src/wiring/taskRuntimeWiring.js';
import { fcaResearchTools } from '../../../../src/wiring/fcaResearchWiring.js';
import { createFcaReadSources } from '../../../../src/wiring/fcaReadSources.js';
import { createFcaSourceGuard, fcaReadReceiptSources } from '../../../../src/mind/action/fca/fcaConversationSources.js';
import { SkillMemory } from '../../../../src/mind/memory/memoryPorts.js';
import { skillTurnPorts } from '../../../../src/wiring/skillMemoryWiring.js';
import { configuredSkillImporter } from '../../../../src/wiring/skillImportWiring.js';
import { standardSkillPack } from '../../../../src/infra/config/standardSkillPack.js';
import { validSkillInput } from '../../../../src/surfaces/minecraft/minecraftControlValidation.js';

// Deterministic real runtime/registry/source checks. Never creates a production task or calls a provider/body.
const at = '2026-10-10T00:00:00.000Z';
const pack = standardSkillPack('legacy-minecraft', 'draft-1')!;
assert.equal(pack.skills.length, 4);
assert.equal(standardSkillPack('legacy-minecraft', '../draft-1'), null);
const reads: { name: string; revisionId: string; ancestryRevocationChecked: boolean }[] = [];
let planHash = '', packSha256 = '';
for (const entry of pack.skills) {
  const h = actionHarness(() => at), store = new SQLiteAutonomyStore(':memory:');
  const state = new InMemoryCompanionStateStore(() => at), conversations = new InMemoryConversationStore();
  const tools = new ShannonToolRunner(store, { boundHosts: () => [] } as unknown as HostFolderOperations,
    { recordConversationAction() {} }, () => at);
  const memory = new SkillMemory({ database: h.db, createsSchema: true, defer: work => work() });
  const skills = skillTurnPorts(memory, scope => state.snapshot(scope), Object.assign(conversations, { snapshot: state.snapshot.bind(state) }));
  tools.useSkills(skills);
  const readVisible = createFcaReadSources({ ownerScope: 'owner', ownerAlone: () => true, state, conversations,
    study: store.study, skill: (scope, id, revision) => skills.readSource!(scope, id, revision) });
  let visible: ReturnType<typeof createFcaSourceGuard>;
  const driver = createTaskRuntimeWiring({ db: h.db, actions: h.actions, scopeKey: 'owner', ownerAlone: () => true, now: () => at,
    canRunTask: (_, id) => visible('owner', id), model: {
      async decide(input) {
        assert(input.skillIndex?.includes(entry.name));
        assert(input.tools.some(tool => tool.name === 'skill.read'));
        return { decision: { kind: 'tools' as const, calls: [{ id: 'read', name: 'skill.read', input: { name: entry.name } }] },
          history: [{ role: 'assistant', content: 'read selected legacy trial' }] };
      }, toolResults: results => ({ role: 'user', results }),
    }, stepPorts: (runtime, step) => ({ sourcesVisible: () => visible.sources('owner', step.snapshot.task, step.snapshot.sources),
      tools: fcaResearchTools({ tools, state, conversations, scopeKey: 'owner', ownerAlone: () => true,
        task: { id: step.taskId, origin: step.snapshot.task.origin, leaseId: step.lease.id }, checkpoint: step.snapshot.checkpoint,
        sourcesVisible: () => visible.sources('owner', step.snapshot.task, step.snapshot.sources),
        observeRead(operationId, receipt) {
          const ids = fcaReadReceiptSources(receipt).readSourceIds ?? [];
          if (ids.some(id => !readVisible('owner', id, at))) return false;
          if (!runtime.observeSources(step, { observationId: `read:${operationId}`, recalledMemoryIds: [], readSourceIds: ids })) return false;
          step.snapshot.sources = runtime.taskSources('owner', step.taskId, step.messageIds);
          return visible.sources('owner', step.snapshot.task, step.snapshot.sources);
        } }),
    }),
  });
  visible = createFcaSourceGuard({ runtime: driver.runtime, state, conversations, ownerScope: 'owner', ownerAlone: () => true, readSourceVisible: readVisible });
  try {
    const importer = configuredSkillImporter(memory, { ownerScopeKey: 'owner', state, conversations })!;
    const plan = importer.dryRun('owner', pack);
    assert.deepEqual(plan.problems, []); assert.deepEqual(memory.store.all('owner'), []);
    planHash = plan.planHash; packSha256 = plan.packSha256;
    const imported = importer.apply('owner', pack, { planHash, approvalReference: 'owner-request-local-fixture' }, at);
    assert(!('rejected' in imported));
    const trial = imported.receipt.skills.find(item => item.name === entry.name)!;
    assert.equal(memory.store.get('owner', trial.skillId)!.status, 'trial');
    assert.equal(memory.store.get('owner', trial.skillId)!.successes, 0);
    assert.deepEqual(memory.store.get('owner', trial.skillId)!.uses, []);
    const task = driver.runtime.createChild('owner', driver.runtime.ensureRoot('owner').id,
      { title: 'Read curated trial', goal: 'Read the selected legacy trial', origin: 'owner_request' }, 'read-curated-trial');
    await driver.tick(); await driver.drain();
    assert(JSON.stringify(driver.runtime.snapshot('owner', task.id)!.history).includes(JSON.stringify(entry.body).slice(1, -1)));
    const source = driver.runtime.taskSources('owner', task.id).flatMap(item => item.readSourceIds ?? [])
      .find(id => id.startsWith(`shannon-skill://${trial.skillId}/revision/`))!;
    assert(source); assert(readVisible('owner', source, at));
    assert.equal(skills.open('owner', entry.name)!.provenance?.origin, 'operator_authored');
    assert.deepEqual(memory.store.get('owner', trial.skillId)!.uses, []);
    assert.equal(memory.store.get('owner', trial.skillId)!.successes, 0);
    state.apply('owner', { type: 'memory-control-upserted', control: { memoryId: `import:${imported.receipt.receiptId}`,
      kind: 'experience', status: 'forgotten', pinned: false, updatedAt: at, changeReason: 'owner' } });
    assert.equal(skills.open('owner', entry.name), null); assert(!readVisible('owner', source, at)); assert(!visible('owner', task.id));
    reads.push({ name: entry.name, revisionId: trial.revisionId, ancestryRevocationChecked: true });
  } finally { await driver.close(); await h.close(); store.close(); }
}

// Source-derived parameter projection only: fresh live catalog availability is deliberately not inferred.
const report = JSON.parse(readFileSync(new URL('selection-report.json', import.meta.url), 'utf8'));
assert(pack.sourceReference.endsWith(createHash('sha256').update(readFileSync(new URL('selection-report.json', import.meta.url))).digest('hex')));
const samples: Record<string, { values: Record<string, unknown>; required: string[] }> = {
  'craft-one': { values: { itemName: 'stone_pickaxe', count: 1 }, required: ['itemName'] },
  'mine-block': { values: { blockName: 'stone', count: 1, searchRadius: 32, collectionPolicy: 'target' }, required: ['blockName'] },
  'start-smelting': { values: { x: 0, y: 0, z: 0, inputItem: 'raw_iron', fuelItem: 'coal', count: 1 }, required: ['x', 'y', 'z', 'inputItem', 'fuelItem'] },
  'withdraw-from-furnace': { values: { x: 0, y: 0, z: 0, slot: 'output', waitForCompletion: false }, required: ['x', 'y', 'z'] },
  'dig-shelter': { values: {}, required: [] }, 'leave-water': { values: {}, required: [] },
  'equip-item': { values: { itemName: 'shield', destination: 'off' }, required: ['itemName'] },
};
for (const definition of report.nativeCatalog.definitions) {
  const sample = samples[definition.nativeName]; assert(sample);
  assert.deepEqual(definition.parameterNames, Object.keys(sample.values));
  const params = definition.parameterDefinitions as { name: string; type: string; required: boolean; hasDefault: boolean }[];
  const required = params.filter(param => param.required && !param.hasDefault).map(param => param.name);
  assert.deepEqual(required, sample.required);
  const schema = { type: 'object', properties: Object.fromEntries(params.map(param => [param.name,
    param.required && !param.hasDefault ? { type: param.type } : { anyOf: [{ type: param.type }, { type: 'null' }] }])),
    required, additionalProperties: false };
  assert(validSkillInput(sample.values, schema)); assert(!validSkillInput({ ...sample.values, unregistered: true }, schema));
  if (sample.required.length) { const omitted = { ...sample.values }; delete omitted[sample.required[0]!]; assert(!validSkillInput(omitted, schema)); }
  if (params.length) { const first = params[0]!; assert(!validSkillInput({ ...sample.values, [first.name]: first.type === 'string' ? 1 : 'wrong' }, schema)); }
}
writeFileSync(new URL('local-verification.json', import.meta.url), JSON.stringify({ observedAt: new Date().toISOString(), packId: pack.packId,
  revision: pack.revision, packSha256, fixturePlanHash: planHash, planHashScope: 'in-memory empty owner fixture; never a production apply plan',
  importedTrialCount: 4, actualFcaSkillReads: reads, nativeParameterProjectionChecks: 7, providerCalls: 0, gameActions: 0,
  productionMutation: false, liveCatalogAvailability: 'unmeasured', liveHttpDryRun: 'parent-owned pending' }, null, 2) + '\n');
console.log(JSON.stringify({ passed: true, trialSkills: 4, actualFcaSkillReads: reads.length, nativeParameterProjectionChecks: 7, packSha256,
  fixturePlanHash: planHash, productionMutation: false }));
