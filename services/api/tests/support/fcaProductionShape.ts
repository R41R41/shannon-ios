import { DatabaseSync } from 'node:sqlite';
import { actionHarness } from './actionThreadHarness.js';
import { memoryWorld } from './memoryWorld.js';
import { leaseOf } from '../../src/contracts/actionThreadContract.js';
import { inActionExecution } from '../../src/infra/context/actionExecution.js';
import { migrateAgentTasks } from '../../src/mind/action/agentTasks/store/agentTaskPersistenceSupport.js';
import { createTaskRuntimeWiring } from '../../src/wiring/taskRuntimeWiring.js';
import type { FcaModelInput, FcaModelOutput } from '../../src/mind/action/fca/fcaPorts.js';
import { createFcaConversationBridge, createFcaSourceGuard } from '../../src/mind/action/fca/fcaConversationPorts.js';
import { createFcaReadSources } from '../../src/wiring/fcaReadSources.js';
import { SkillMemory } from '../../src/mind/memory/memoryPorts.js';
import { skillTurnPorts } from '../../src/wiring/skillMemoryWiring.js';
import { ShannonMemoryService } from '../../src/mind/memory/memoryService.js';
import type { TaskStep } from '../../src/mind/action/taskRuntime/taskRuntimePorts.js';

/**
 * The shape of production on 2026-10-12 (owner scope): 855 remembered turns that recall each other, one forgotten memory
 * (so the withholding rules are active), ten skills, and the voice conversation task after fourteen turns (each recalling
 * ~36 memories and reading ~6 skill revisions), with six research children and ~64 inbox reports from them.
 */
export const PRODUCTION_SHAPE = Object.freeze({ experiences: 855, turns: 14, recalledPerTurn: 36, readsPerTurn: 6, children: 6, messages: 64, skills: 10 });
const emotion = { valence: 0, arousal: 0.3, openness: 0.35, expression: 'calm' as const };

export function fcaProductionShape(shape: Partial<Record<keyof typeof PRODUCTION_SHAPE, number>> & { budgetMs?: number;
  /** Which earlier turns a remembered turn recalled (default: ten, spread); the dense graph of the loop-stall bench gives its own. */
  recalledOf?: (index: number, earlier: readonly string[]) => string[];
  /** Characters of each skill's steps (default 400; a real skill's body is several thousand). */
  skillBody?: number;
  /** How many of the latest remembered turns are forgotten (default 1; production had two controls on 2026-10-19). */
  forgets?: number } = {}) {
  const size = { ...PRODUCTION_SHAPE, ...shape };
  const world = memoryWorld();
  const ids: string[] = [];
  for (let index = 0; index < size.experiences; index++) {
    world.advance(60_000);
    const recalled = shape.recalledOf ? shape.recalledOf(index, ids)
      : ids.length ? Array.from({ length: Math.min(10, ids.length) }, (_, k) => ids[(index * 7 + k * 13) % ids.length]!) : [];
    ids.push(world.store.appendTurn('owner', `thread-${index % 3}`, `質問${index}について${String.fromCharCode(0x4e00 + index)}${'あ'.repeat(120)}`,
      `返答${index}${String.fromCharCode(0x5000 + index)}${'い'.repeat(160)}`, world.now(),
      { capturedStateVersion: 0, messageEmotion: emotion, recalledMemoryIds: recalled }).id);
  }
  const forgotten = ids.at(-1)!;
  for (let k = 0; k < (shape.forgets ?? 1); k++) new ShannonMemoryService(world.store, world.store, world.now).mutate('owner', { memoryId: ids.at(-1 - k)!, action: 'forget' });
  const skillDb = new DatabaseSync(':memory:');
  const memory = new SkillMemory({ database: skillDb, createsSchema: true, defer: work => work() });
  for (let index = 0; index < size.skills; index++) {
    const added = memory.create('owner', { draft: { name: `skill-${index}`, description: `手順${index}`, steps: `手順${index}の本文${'う'.repeat(shape.skillBody ?? 400)}`,
      aids: '- 確認', references: '- 元資料' }, evidence: [] }, { carries: () => false }, world.now());
    if ('rejected' in added) throw new Error(added.rejected);
  }
  const skills = skillTurnPorts(memory, scope => world.store.snapshot(scope), world.store);
  const skillSources = skills.indexSources!('owner');
  let alone = true;
  const ownerAlone = () => alone;
  const readSourceVisible = createFcaReadSources({ ownerScope: 'owner', ownerAlone, state: world.store, conversations: world.store,
    skill: (scope, id, revision) => skills.readSource!(scope, id, revision) });
  world.store.readSourceVisible = readSourceVisible;
  const at = () => world.now();
  const h = actionHarness(at); migrateAgentTasks(h.db);
  const steps: FcaModelInput[] = [];
  let visible!: ReturnType<typeof createFcaSourceGuard>;
  // A research step that reads its inputs and waits: what each running research child does every few seconds.
  const driver = createTaskRuntimeWiring({ db: h.db, actions: h.actions, scopeKey: 'owner', ownerAlone, now: at,
    canRunTask: (_runtime, id) => visible('owner', id),
    model: { async decide(input): Promise<FcaModelOutput> { steps.push(input); return { decision: { kind: 'wait', summary: 'Still waiting' }, history: [{ role: 'assistant', content: 'waiting' }] }; },
      toolResults: results => ({ role: 'user', results }) },
    stepPorts: (_runtime, step) => ({ sourcesVisible: () => visible.sources('owner', step.snapshot.task, step.snapshot.sources),
      taskVisible: id => visible('owner', id) }) });
  const runtime = driver.runtime;
  visible = createFcaSourceGuard({ runtime, state: world.store, conversations: world.store, ownerScope: 'owner', ownerAlone, readSourceVisible });
  // Correctness checks run without the wall-clock budget (a loaded CI runner must not change what they see); its own test sets it.
  const bridge = createFcaConversationBridge({ runtime, ownerScope: 'owner', visible, budgetMs: shape.budgetMs ?? 60_000 });
  let turns = 0;
  const foreground = async <T>(work: () => Promise<T>) => {
    const action = (await h.actions.admitRespond({ scopeKey: 'owner', kind: 'respond', origin: 'owner_request', sourceId: `turn-${++turns}` }))!;
    const lease = leaseOf(action);
    try { return await inActionExecution({ lease, signal: new AbortController().signal, permit: () => h.actions.dispatch(lease) }, work); }
    finally { await h.actions.finish(lease, 'completed', 'responded'); }
  };
  const thread = 'thread-0';
  const recalledFor = (turn: number) => Array.from({ length: size.recalledPerTurn }, (_, k) => ids[(turn * 53 + k * 11 + 100) % (ids.length - 1)]!);
  const begin = (turn: number) => bridge.begin({ scopeKey: 'owner', threadId: thread, observedAt: at(), recalledMemoryIds: recalledFor(turn), ownerAlone })!;
  const children: string[] = [];
  return {
    world, ids, forgotten, memory, skills, skillSources, readSourceVisible, h, runtime, driver, steps, visible, bridge, foreground, begin, thread, children, size,
    setAlone(value: boolean) { alone = value; },
    /** Builds the conversation task as production had it. */
    async build() {
      let conversationId = '';
      for (let turn = 0; turn < size.turns; turn++) {
        world.advance(60_000);
        await foreground(async () => {
          const fca = begin(turn);
          const reads = Array.from({ length: size.readsPerTurn }, (_, k) => skillSources[(turn + k) % skillSources.length]!);
          bridge.observeRead('owner', { name: 'skill.read', ok: true, documents: { sourceIds: reads } });
          if (turn % 2 === 0 && children.length < size.children) {
            const child = fca.delegate!({ title: `調べもの${turn}`, goal: `公開情報を調べる${turn}` });
            children.push(child.id); conversationId = child.parentId!;
          }
          fca.commit(world.store.appendTurn('owner', thread, `話${turn}`, `返事${turn}`, at()).id);
        });
      }
      for (let index = 0; index < size.messages; index++) {
        runtime.send('owner', children[index % children.length]!, conversationId, `途中経過${index}：${'え'.repeat(200)}`, `report-${index}`);
      }
      return conversationId;
    },
    async close() { await driver.close(); h.close(); skillDb.close(); world.close(); },
  };
}

export type ProductionShape = ReturnType<typeof fcaProductionShape>;
export type { TaskStep };
