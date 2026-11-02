// S4's isolated head + body rig (2026-11-02, dragon sprint): the head's own code and the body's own code in ONE process, over a lab Minecraft server, for the
// section trials (scripts/minecraft-trials/rig.py) beside a real run. It touches nothing of production: its own database file, its own operator socket (beside
// that file), its own lab server and body account; the production shannon-home, body account, services and database are not opened. The model keys are read
// from the env file given (on the VM only) into this process's memory and never printed.
//
// It is the head's hold-and-resume lab (tests/minecraftHoldResumeLab.ts: the operator's CLI and socket, the task runtime and its FCA steps, the LLM-centric
// step parts, the control and its lease rules) with the two stand-ins replaced: the model by the production's (`configuredMinecraftLlmc`, or a script for the
// plumbing test without a key) and the body by the real one (`NativeCommonFcaBody` over a mineflayer bot, run by `CommonFcaControlLoop` whose HTTP poll goes to the
// control in-process). The budget is the production's (`fcaBudget`, the operator's `--budget-yen` lowers a request's cap).
//
//   cd <head tree>/services/api && node --import tsx scripts/minecraft-rig.ts
//   env: RIG_DIR (work dir, made if missing)  RIG_PORT (the lab server's game port)  RIG_BODY_BUNDLE (rig-body.mjs, bundled from the body tree)  RIG_BODY_NAME (default I_am_Shannon)
//        RIG_MODEL=real|script  RIG_ENV_FILE (api.env, for real)  RIG_STOP_FILE (the file whose existence ends the rig; default <RIG_DIR>/rig.stop)
// It prints `RIG_READY {...}` when the operator socket and the body are up, `RIG_USAGE {...}` for every paid call, `RIG_LOG ...` lines of the head, and exits 0 on SIGTERM.
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { actionHarness } from '../tests/support/actionThreadHarness.js';
import { createTaskRuntimeWiring } from '../src/wiring/taskRuntimeWiring.js';
import { MinecraftControl } from '../src/surfaces/minecraft/minecraftControl.js';
import { MinecraftControlStore } from '../src/surfaces/minecraft/store/minecraftControlStore.js';
import { configuredMinecraftBody } from '../src/contracts/minecraftBodyContract.js';
import { actionResource } from '../src/contracts/actionThreadContract.js';
import { ActionLeaseReader } from '../src/mind/action/threads/store/actionLeaseReader.js';
import { bodyLeaseAttempt, bodyLeaseKnown, bodyLeaseValid } from '../src/wiring/actionLeaseRules.js';
import { configuredMinecraftLlmc, llmcLifecycle, llmcStepParts, LLMC_HISTORY_POLICY, type LlmcWiring } from '../src/wiring/minecraftLlmcWiring.js';
import { createFcaHistoryAhead } from '../src/mind/action/fca/fcaHistory.js';
import { createMinecraftTaskBody } from '../src/surfaces/minecraft/minecraftReflexAdapter.js';
import { combineFcaTools, fcaMinecraftTools } from '../src/wiring/fcaMinecraftTools.js';
import { createFcaProgressTools } from '../src/mind/action/fca/fcaProgressTools.js';
import { minecraftGoalBinding } from '../src/wiring/fcaMinecraftGoalBinding.js';
import { actionPermit, currentActionExecution } from '../src/infra/context/actionExecution.js';
import { admittedMinecraftRequest, MINECRAFT_REQUEST_CONTEXT, MINECRAFT_REQUEST_CRITERIA } from '../src/wiring/fcaMinecraftRequests.js';
import { operatorMinecraftRequests } from '../src/wiring/operatorMinecraftRequests.js';
import { configuredOperatorAudit, startOperatorMinecraft } from '../src/wiring/operatorServerWiring.js';
import { fcaBudget } from '../src/wiring/fcaBudgetWiring.js';
import { TaskBudgetStore } from '../src/mind/action/taskRuntime/store/taskBudgetStore.js';
import { fcaCompactAboveTokens } from '../src/infra/models/anthropic/anthropicFcaCompaction.js';
import { ownerLocalClock, ownerTimeZone } from '../src/infra/time/localDate.js';
import { MC_ACT_TOOL } from '../src/contracts/minecraftActContract.js';
import type { FcaModel } from '../src/mind/action/fca/fcaPorts.js';

const env = process.env;
const DIR = env.RIG_DIR ?? '', PORT = Number(env.RIG_PORT), BUNDLE = env.RIG_BODY_BUNDLE ?? '', NAME = env.RIG_BODY_NAME ?? 'I_am_Shannon', MODE = env.RIG_MODEL ?? 'script';
if (!DIR || !Number.isInteger(PORT) || !BUNDLE || !fs.existsSync(BUNDLE)) throw new Error('RIG_DIR, RIG_PORT and RIG_BODY_BUNDLE (an existing rig-body.mjs) are required');
fs.mkdirSync(DIR, { recursive: true });
const STOP_FILE = env.RIG_STOP_FILE ?? path.join(DIR, 'rig.stop');
const log = (line: string) => console.log(`RIG_LOG [${new Date().toISOString().slice(11, 19)}] ${line}`);
const emit = (tag: string, value: unknown) => console.log(`${tag} ${JSON.stringify(value)}`);

/** The env file's values (the production api.env on the VM); only what the Minecraft path reads, so no other feature of the head wakes up. */
function readValues(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/u)) {
    const m = /^([A-Z0-9_]+)=(.*)$/u.exec(line.trim());
    if (!m) continue;
    const key = m[1]!;
    if (!/^(SHANNON_(ANTHROPIC|HAIKU|FCA_|MINECRAFT_LLMC|SONNET|TIMEZONE|OWNER)|ANTHROPIC_)/u.test(key)) continue;
    out[key] = m[2]!.replace(/^(['"])(.*)\1$/u, '$2');
  }
  return out;
}
const values: Record<string, string> = MODE === 'real' ? readValues(env.RIG_ENV_FILE ?? '') : {};
// The body's modules read these at load (it never connects to either here) and its probe floor is the default one.
env.MONGODB_URI ??= 'mongodb://127.0.0.1:1/rig-not-used';
env.OPENAI_API_KEY ??= 'offline-test-not-used';
Object.assign(env, { SHANNON_ISOLATED_MINEBOT_PROBE: 'true', MINECRAFT_COGNITION_MODE: 'off', MINECRAFT_OUTAGE_NO_LLM: 'true', MINECRAFT_HUNT_NO_LLM: 'true', MINECRAFT_PROBE_FLOOR: 'default' });
const body = await import(BUNDLE) as any;

// ---- the head (the hold lab's wiring, with the production's budget and models) ------------------------------------------------------------------
const dbPath = path.join(DIR, 'head', 'shannon.db');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const nowIso = () => new Date().toISOString();
const h = actionHarness(nowIso, dbPath);
const SERVER_ID = 'rig';
const configuration = configuredMinecraftBody({ SHANNON_MINECRAFT_BODY_JSON: JSON.stringify({ deviceId: 'minebot',
  servers: [{ serverId: SERVER_ID, title: 'rig', onlineMode: false, ownerUuid: 'b9191317-c52d-4d67-85fe-ab831e6db146' }] }) })!;
const leases = new ActionLeaseReader(h.db);
const bodyResource = actionResource('minebot', 'minecraft-body');
const known = (lease: any, taskId: string) => bodyLeaseAttempt(leases.get(lease.id), 'owner', lease, taskId);
const control = new MinecraftControl(new MinecraftControlStore(h.db), configuration, { now: Date.now, ownerAlone: () => true,
  leaseKnown: (lease, taskId) => bodyLeaseKnown(known(lease, taskId), bodyResource),
  leaseValid: (lease, taskId) => bodyLeaseValid(known(lease, taskId), lease, bodyResource, nowIso()),
  leaseAttempted: (lease, taskId) => known(lease, taskId) !== null });

const audit = configuredOperatorAudit({ ...values, SHANNON_OPERATOR_MINECRAFT: 'on' }, dbPath)!;
let driver: ReturnType<typeof createTaskRuntimeWiring>;
const budget = fcaBudget({ actions: h.actions, store: new TaskBudgetStore(h.db), now: nowIso, ownTime: null,
  minecraftRequest: task => admittedMinecraftRequest(task as never, (task as { parentId?: string }).parentId ? driver.runtime.get((task as { scopeKey: string }).scopeKey, (task as { parentId: string }).parentId) as never : null,
    Boolean(control.store.body((task as { id: string }).id))),
  taskCapYen: (id: string) => audit.store.budgetYen(id) });
let spentUsd = 0, calls = 0;
const timeZone = ownerTimeZone(values);
const recordUsage = (usage: { estimatedCostUsd: number; usageComplete: boolean; model: string; inputTokens: number; cachedInputTokens: number; outputTokens: number }) => {
  budget.recordUsage(usage.estimatedCostUsd, !usage.usageComplete);
  spentUsd += usage.estimatedCostUsd; calls++;
  emit('RIG_USAGE', { n: calls, model: usage.model, usd: Number(usage.estimatedCostUsd.toFixed(4)), totalUsd: Number(spentUsd.toFixed(4)), inTokens: usage.inputTokens,
    cachedIn: usage.cachedInputTokens, outTokens: usage.outputTokens, complete: usage.usageComplete });
};

/** The plumbing test's model: a script of what a decision gives, so the whole chain runs without a key. */
const scriptModel = (): FcaModel => {
  let decisions = 0;
  return {
    async decide() {
      decisions++;
      await delay(300);
      const hands = [{ do: 'look' }];
      return decisions === 2 ? { decision: { kind: 'tools', calls: [{ id: `rig-${decisions}`, name: MC_ACT_TOOL, input: { hands, why: '[rig] script' } }] }, history: [{ role: 'assistant', content: 'act' }] }
        : { decision: { kind: 'tools', calls: [{ id: `look-${decisions}`, name: 'task.list', input: {} }] }, history: [{ role: 'assistant', content: 'look' }] };
    },
    toolResults: results => ({ role: 'user', results }),
  } as FcaModel;
};
const clock = () => ({ localTime: ownerLocalClock(new Date(), timeZone), timeZone });
const real = MODE === 'real'
  ? configuredMinecraftLlmc(values, { recordUsage: recordUsage as never, clock, compactAboveTokens: fcaCompactAboveTokens(values.SHANNON_FCA_COMPACT_ABOVE_TOKENS), stopGraceMilliseconds: 20_000 },
    { log: line => log(`llmc: ${line}`) })
  : null;
if (MODE === 'real' && !real) throw new Error('RIG_NO_MODEL_KEY: configuredMinecraftLlmc made nothing (no key for the main model in the env file)');
const fake = scriptModel();
const llmc: LlmcWiring = real ?? { names: { main: 'rig-script', escalate: null, plan: 'rig-script' } as never, models: { main: fake, escalate: null }, summarizer: null,
  policy: LLMC_HISTORY_POLICY, historyAhead: createFcaHistoryAhead() };
if (real) emit('RIG_MODELS', { main: real.names.main, escalate: real.names.escalate, plan: real.names.plan });

driver = createTaskRuntimeWiring({ db: h.db, actions: h.actions, scopeKey: 'owner', ownerAlone: () => true, now: nowIso, model: llmc.models.main, budget, continueAtOnce: true,
  stepPorts: (runtime, step) => {
    const small = llmcStepParts(llmc, step, control, line => log(`head: ${line}`));
    const taskBody = createMinecraftTaskBody({ control, runtime, step, ownerAlone: () => true, sourcesVisible: () => true, ...small.body });
    const permit = async () => {
      await actionPermit();
      const active = currentActionExecution();
      if (!active || active.lease.id !== step.lease.id) throw new Error('FCA_SOURCE_WITHHELD');
      active.signal.throwIfAborted();
      if (runtime.get(step.scopeKey, step.taskId)?.phase !== 'executing') throw new Error('FCA_TASK_STOPPING');
    };
    const binding = minecraftGoalBinding(step.snapshot.task, `minecraft:${SERVER_ID}`);
    const life = llmcLifecycle(small, taskBody.body);
    const ports = { keepBodyTools: () => true, body: life, sourcesVisible: () => true, waitCounterpart: () => false,
      tools: createFcaProgressTools(combineFcaTools(small.planTools, fcaMinecraftTools({ control, step, ownerAlone: () => true, sourcesVisible: () => true, ...small.tools }), taskBody.tools),
        { checkpoint: step.snapshot.checkpoint, binding, requireConditions: true, permit }),
      ...small.ports };
    return small.menu(ports as never);
  } } as never);
const wakeTimer = setInterval(() => { void driver.tick().catch(() => undefined); }, 200);

const spec = (goal: string) => ({ title: goal.slice(0, 120), goal, completionCriteria: MINECRAFT_REQUEST_CRITERIA, context: MINECRAFT_REQUEST_CONTEXT });
const bound = () => { const tasks = []; for (const task of driver.runtime.list('owner', { limit: 100, offset: 0 })) if (control.store.body(task.id)) tasks.push(task); return tasks; };
const requests = operatorMinecraftRequests({ control, runtime: driver.runtime, ownerScope: 'owner', stop: driver.stop, atomic: work => work(), bound, spec } as never);
const operator = startOperatorMinecraft({ audit, path: dbPath, scopeKey: 'owner', now: nowIso, ownerAlone: () => true, log: line => log(`operator: ${line}`),
  requests: { ...requests, wake: () => { void driver.tick(); } }, lifecycle: null, actions: h.actions,
  activity: { append: () => undefined } as never, config: { timeZone } as never,
  conversation: { threadId: () => 'thread', appendNoteOnce: () => null } } as never);

// ---- the body: the real one, over the lab server ---------------------------------------------------------------------------------------------------
const actor: any = await body.createProbeBot(PORT, NAME);
actor.on('error', (error: Error) => log(`body error: ${String(error?.message ?? error).slice(0, 200)}`));
actor.on('death', () => emit('RIG_EVENT', { event: 'death', at: nowIso() }));
actor.on('end', (reason: unknown) => { emit('RIG_EVENT', { event: 'body_end', reason: String(reason).slice(0, 120) }); });
const nativeBody = new body.NativeCommonFcaBody(actor, { serverId: SERVER_ID, capture: async () => { throw new Error('no picture in the rig'); }, rendererConfigured: () => false });
let pollErrors = 0;
const fetcher = async (_url: unknown, init: { body: string }) => {
  try { return new Response(JSON.stringify(control.poll({ scopeKey: 'owner', deviceId: 'minebot' } as never, JSON.parse(init.body)))); }
  catch (error) {
    if (!pollErrors++) log(`the body's poll was refused: ${String((error as Error)?.message ?? error).slice(0, 200)}`);
    return new Response(JSON.stringify({ error: 'FCA_BODY_POLL_INVALID' }), { status: 400 });
  }
};
const loop = new body.CommonFcaControlLoop({ baseUrl: 'http://127.0.0.1:3000', token: 'rig-device-token-0000', serverId: SERVER_ID, actuator: nativeBody, fetcher, pollMilliseconds: 150 });
loop.start();

const socketReady = () => fs.existsSync(path.join(path.dirname(dbPath), 'operator-runtime', 'operator.sock'));
for (let waited = 0; waited < 30_000 && !(socketReady() && control.available().length === 1); waited += 200) await delay(200);
if (!(socketReady() && control.available().length === 1)) { emit('RIG_FAILED', { reason: 'the head never saw the body or the operator socket is missing', socket: socketReady(), bodies: control.available().length }); process.exit(3); }
emit('RIG_READY', { db: dbPath, socket: path.join(path.dirname(dbPath), 'operator-runtime', 'operator.sock'), body: NAME, port: PORT, mode: MODE, pid: process.pid });

let closing = false;
async function shutdown(code: number): Promise<never> {
  if (!closing) {
    closing = true;
    clearInterval(wakeTimer);
    emit('RIG_STOPPING', { totalUsd: Number(spentUsd.toFixed(4)), calls });
    await loop.stop().catch(() => undefined);
    await operator.close().catch(() => undefined);
    await driver.close().catch(() => undefined);
    try { body.closeProbeBot(actor); } catch { /* the lab is closing */ }
  }
  setTimeout(() => process.exit(code), 500).unref();
  return new Promise<never>(() => undefined);
}
process.on('SIGTERM', () => { void shutdown(0); });
process.on('SIGINT', () => { void shutdown(0); });
for (;;) {
  await delay(1000);
  if (fs.existsSync(STOP_FILE)) await shutdown(0);
}
