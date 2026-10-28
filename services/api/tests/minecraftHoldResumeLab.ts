/**
 * Run 44, resume 1 (2026-10-28): the fix run's hold and resume through the REAL head, end to end, with no model and no paid key.
 *
 * The lab of the body (`backend/scripts/minecraft-incident-lab-probe.ts`) played the head's part itself: it sent the resume on the held act as the
 * probe liked, and the head's own way (the operator's `resume`, a new step, its lease, the task queue) was never run. In run 44 that way failed:
 * the act sent again was refused by the head's own control (FCA_BODY_LEASE_INVALID), the head ran on, and the body kept refusing every act.
 *
 * Here the head is the head's code: the operator's CLI and socket (`runOperatorCli`, `startOperatorMinecraft`), the audit, the task runtime and its
 * FCA steps (`createTaskRuntimeWiring`), the LLM-centric step parts with the task queue and the resume (`llmcStepParts`), the body tools and the
 * reflex lifecycle (`fcaMinecraftTools`, `createMinecraftTaskBody`), the control and its lease rules (`MinecraftControl`, the rules of
 * `fcaBodyWiring.ts`). Only the model is a script (it gives the acts a decision would).
 * The body is the body's code where the hold lives: its control loop (`CommonFcaControlLoop`, the same poll and receipts, called in-process
 * instead of over HTTP), its incidents (`Incidents`: the hold file, freeze/unfreeze, beforeAct/afterAct) and its scene saver (`SceneSaver`) over a
 * stand-in server that answers `list`, `tick freeze|unfreeze|query` and `save-all`. Its act is a stand-in that stops `stuck` while the lab's world
 * is broken (the server refuses a place) and passes once it is fixed. A restart is a new bot, new incidents (the same hold file), a new loop
 * and connection: as a deploy of the body.
 *
 *   (in Shannon) npx esbuild backend/scripts/lab/hold-lab-body.ts --bundle --platform=node --format=esm --packages=external  *                  --tsconfig=backend/tsconfig.json --outfile=backend/lab-bundle/hold-lab-body.mjs
 *   SHANNON_BODY_BUNDLE=<Shannon>/backend/lab-bundle/hold-lab-body.mjs npx tsx tests/minecraftHoldResumeLab.ts
 *   (the body compiled as its own tsconfig does it: class fields set after the constructor's parameters; its packages from its own node_modules)
 *
 * It prints PASS/FAIL lines and `HOLD_LAB_RESULT {...}`; exit 0 when every check passed.
 */
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { actionHarness } from './support/actionThreadHarness.js';
import { createTaskRuntimeWiring } from '../src/wiring/taskRuntimeWiring.js';
import { MinecraftControl } from '../src/surfaces/minecraft/minecraftControl.js';
import { MinecraftControlStore } from '../src/surfaces/minecraft/store/minecraftControlStore.js';
import { configuredMinecraftBody } from '../src/contracts/minecraftBodyContract.js';
import { actionResource } from '../src/contracts/actionThreadContract.js';
import { ActionLeaseReader } from '../src/mind/action/threads/store/actionLeaseReader.js';
import { bodyLeaseAttempt, bodyLeaseKnown, bodyLeaseValid } from '../src/wiring/actionLeaseRules.js';
import { llmcLifecycle, llmcStepParts, LLMC_HISTORY_POLICY, type LlmcWiring } from '../src/wiring/minecraftLlmcWiring.js';
import { createFcaHistoryAhead } from '../src/mind/action/fca/fcaHistory.js';
import { createMinecraftTaskBody } from '../src/surfaces/minecraft/minecraftReflexAdapter.js';
import { combineFcaTools, fcaMinecraftTools } from '../src/wiring/fcaMinecraftTools.js';
import { createFcaProgressTools } from '../src/mind/action/fca/fcaProgressTools.js';
import { minecraftGoalBinding } from '../src/wiring/fcaMinecraftGoalBinding.js';
import { actionPermit, currentActionExecution } from '../src/infra/context/actionExecution.js';
import { MINECRAFT_REQUEST_CONTEXT, MINECRAFT_REQUEST_CRITERIA } from '../src/wiring/fcaMinecraftRequests.js';
import { operatorMinecraftRequests } from '../src/wiring/operatorMinecraftRequests.js';
import { configuredOperatorAudit, startOperatorMinecraft } from '../src/wiring/operatorServerWiring.js';
import { runOperatorCli } from '../src/infra/ops/operatorCli.js';
import { MC_ACT_TOOL } from '../src/contracts/minecraftActContract.js';
import type { FcaModel, FcaModelInput } from '../src/mind/action/fca/fcaPorts.js';

const BODY = process.env.SHANNON_BODY_BUNDLE ?? '';
if (!BODY || !fs.existsSync(BODY)) throw new Error('SHANNON_BODY_BUNDLE must name the body bundle (backend/scripts/lab/hold-lab-body.ts, bundled with esbuild)');
for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']) if (process.env[key]) throw new Error(`HOLD_LAB_REFUSES_PAID_KEY:${key}`);
// The body's config reads these at load (it never connects to either here).
process.env.MONGODB_URI ??= 'mongodb://127.0.0.1:1/hold-lab-not-used';
process.env.OPENAI_API_KEY ??= 'offline-test-not-used';
const bodyCode = await import(BODY) as any;
const body = { loop: bodyCode, incidents: bodyCode, scene: bodyCode };

const log = (line: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${line}`);
const checks: Array<{ name: string; passed: boolean; detail: string }> = [];
const check = (name: string, passed: boolean, detail = '') => { checks.push({ name, passed, detail: detail.slice(0, 300) }); log(`${passed ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail.slice(0, 260)}` : ''}`); };
async function until(condition: () => boolean, ms: number, step = 100): Promise<boolean> {
  for (let waited = 0; waited < ms; waited += step) { if (condition()) return true; await delay(step); }
  return condition();
}

// ---- the stand-in server and world -------------------------------------------------------------------------------------------------------
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hold-lab-'));
const server = { frozen: false, players: ['LabBody'], said: [] as string[], broken: true };
const serverDir = path.join(dir, 'server');
fs.mkdirSync(path.join(serverDir, 'world', 'region'), { recursive: true }); fs.mkdirSync(path.join(serverDir, 'logs'), { recursive: true });
fs.writeFileSync(path.join(serverDir, 'world', 'level.dat'), 'L'); fs.writeFileSync(path.join(serverDir, 'logs', 'latest.log'), '');
for (const file of body.scene.regionsAround(0, 0)) fs.writeFileSync(path.join(serverDir, 'world', 'region', file), 'R');
const serverCommand = async (text: string) => {
  server.said.push(text);
  if (text === 'list') return `There are ${server.players.length} of a max of 20 players online: ${server.players.join(', ')}`;
  if (text === 'tick freeze') { server.frozen = true; return 'The game is frozen'; }
  if (text === 'tick unfreeze') { server.frozen = false; return 'The game is running normally'; }
  if (text === 'tick query') return server.frozen ? 'The game is frozen' : 'The game is running normally';
  if (text.startsWith('save-all')) return 'Saved the game';
  return '';
};
const holdFile = path.join(dir, 'body', 'incident-hold.json');

// ---- the head ------------------------------------------------------------------------------------------------------------------------------
const dbPath = path.join(dir, 'head', 'shannon.db');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const nowIso = () => new Date().toISOString();
const h = actionHarness(nowIso, dbPath);
const configuration = configuredMinecraftBody({ SHANNON_MINECRAFT_BODY_JSON: JSON.stringify({ deviceId: 'minebot', servers: [{ serverId: 'lab', title: 'lab', onlineMode: false, ownerUuid: 'b9191317-c52d-4d67-85fe-ab831e6db146' }] }) })!;
const leases = new ActionLeaseReader(h.db);
const bodyResource = actionResource('minebot', 'minecraft-body');
const known = (lease: any, taskId: string) => bodyLeaseAttempt(leases.get(lease.id), 'owner', lease, taskId);
// The lease rules of `fcaBodyWiring.ts`, as production makes the control.
const control = new MinecraftControl(new MinecraftControlStore(h.db), configuration, { now: Date.now, ownerAlone: () => true,
  leaseKnown: (lease, taskId) => bodyLeaseKnown(known(lease, taskId), bodyResource),
  leaseValid: (lease, taskId) => bodyLeaseValid(known(lease, taskId), lease, bodyResource, nowIso()),
  leaseAttempted: (lease, taskId) => known(lease, taskId) !== null });

/** The model: a script of what a decision gives (an act or a look), one decision every 300 ms. */
const model = { script: [] as Array<'gap' | 'walk'>, decisions: 0, acts: 0, inputs: [] as FcaModelInput[] };
const fake: FcaModel = {
  async decide(input) {
    model.decisions++; model.inputs.push(input);
    const last = (input.history as unknown[]).at(-1);
    if (process.env.HOLD_LAB_VERBOSE && last) log(`model: last ${JSON.stringify(last).slice(0, 400)}`);
    if (process.env.HOLD_LAB_VERBOSE && model.decisions === 1) log(`model: tools ${input.tools.map(tool => tool.name).join(',')} kinds ${JSON.stringify((input as { decisions?: unknown }).decisions ?? null)}`);
    await delay(300);
    const next = model.script.shift();
    if (next) {
      model.acts++;
      const hands = next === 'gap' ? [{ do: 'go', to: { x: 9, y: 100, z: 0 }, canPlace: ['cobblestone'], seconds: 30 }] : [{ do: 'go', to: { x: 11, y: 100, z: 2 }, seconds: 30 }];
      return { decision: { kind: 'tools', calls: [{ id: `lab-${model.decisions}`, name: MC_ACT_TOOL, input: { hands, why: next === 'gap' ? '[lab] 穴を渡る' : '[lab] 続き' } }] },
        history: [{ role: 'assistant', content: `act ${next}` }] };
    }
    // Between acts a decision only reads its tasks (a real one would think, and maybe add to the queue).
    return { decision: { kind: 'tools', calls: [{ id: `look-${model.decisions}`, name: 'task.list', input: {} }] }, history: [{ role: 'assistant', content: 'look' }] };
  },
  toolResults: results => ({ role: 'user', results }),
} as FcaModel;
const llmc: LlmcWiring = { names: { main: 'lab-script', escalate: null, plan: 'lab-script' } as never, models: { main: fake, escalate: null }, summarizer: null,
  policy: LLMC_HISTORY_POLICY, historyAhead: createFcaHistoryAhead() };

function withoutHistory<T extends { history?: unknown }>(ports: T): Omit<T, 'history'> { const { history: _history, ...rest } = ports; return rest; }
const driver = createTaskRuntimeWiring({ db: h.db, actions: h.actions, scopeKey: 'owner', ownerAlone: () => true, now: nowIso, model: fake,
  stepPorts: (runtime, step) => {
    // As `serverFcaWiring.ts` makes a body task's step in the LLM-centric mode (its plan, queue, resume, menu), without the parts this lab has no use for.
    const small = llmcStepParts(llmc, step, control, line => log(`head: ${line}`));
    const taskBody = createMinecraftTaskBody({ control, runtime, step, ownerAlone: () => true, sourcesVisible: () => true, ...small.body });
    const permit = async () => {
      await actionPermit();
      const active = currentActionExecution();
      if (!active || active.lease.id !== step.lease.id) throw new Error('FCA_SOURCE_WITHHELD');
      active.signal.throwIfAborted();
      if (runtime.get(step.scopeKey, step.taskId)?.phase !== 'executing') throw new Error('FCA_TASK_STOPPING');
    };
    const binding = minecraftGoalBinding(step.snapshot.task, 'minecraft:lab');
    const ports = { keepBodyTools: () => true, body: llmcLifecycle(small, taskBody.body), sourcesVisible: () => true, waitCounterpart: () => false,
      tools: createFcaProgressTools(combineFcaTools(small.planTools, fcaMinecraftTools({ control, step, ownerAlone: () => true, sourcesVisible: () => true, ...small.tools }), taskBody.tools),
        { checkpoint: step.snapshot.checkpoint, binding, requireConditions: true, permit }),
      // The mode's ports but its history codec (the Anthropic model's rounds): the script's rounds are plain, as the runtime's own tests give them.
      ...withoutHistory(small.ports) };
    return small.menu(ports as never);
  } });
const wakeTimer = setInterval(() => { void driver.tick().catch(() => undefined); }, 200);

const values = { SHANNON_OPERATOR_MINECRAFT: 'on' };
const audit = configuredOperatorAudit(values, dbPath)!;
const spec = (goal: string) => ({ title: goal.slice(0, 120), goal, completionCriteria: MINECRAFT_REQUEST_CRITERIA, context: MINECRAFT_REQUEST_CONTEXT });
const bound = () => { const tasks = []; for (const task of driver.runtime.list('owner', { limit: 100, offset: 0 })) if (control.store.body(task.id)) tasks.push(task); return tasks; };
const requests = operatorMinecraftRequests({ control, runtime: driver.runtime, ownerScope: 'owner', stop: driver.stop, atomic: work => work(), bound, spec });
const operator = startOperatorMinecraft({ audit, path: dbPath, scopeKey: 'owner', now: nowIso, ownerAlone: () => true, log: line => log(`head: ${line}`),
  requests: { ...requests, wake: () => { void driver.tick(); } }, lifecycle: null, actions: h.actions,
  activity: { append: () => undefined } as never, config: { timeZone: 'Asia/Tokyo' } as never,
  conversation: { threadId: () => 'thread', appendNoteOnce: () => null } });
const socketReady = () => fs.existsSync(path.join(path.dirname(dbPath), 'operator-runtime', 'operator.sock'));
async function cli(...argv: string[]): Promise<{ code: number; out: string }> {
  const lines: string[] = [];
  const code = await runOperatorCli(['minecraft', ...argv], { SHANNON_DATABASE_PATH: dbPath, SHANNON_OPERATOR: 'lab' }, { out: line => lines.push(line), err: line => lines.push(`ERR ${line}`) });
  const out = lines.join('\n');
  log(`cli ${argv.join(' ')} -> ${code}: ${out.replace(/\s+/gu, ' ').slice(0, 300)}`);
  return { code, out };
}

// ---- the body ------------------------------------------------------------------------------------------------------------------------------
const ACT = { name: 'act', description: 'the body\'s act', readOnly: false, maxDurationMs: 120_000,
  inputSchema: { type: 'object', properties: { hands: { type: 'array', items: { type: 'object', properties: {}, required: [], additionalProperties: false } } },
    required: [], additionalProperties: false } };
type LabBody = { loop: any; incidents: any; bot: any; acts: string[]; refused: number };
let bodySequence = 0, pollErrors = 0;
function startBody(name: string): LabBody {
  const bot: any = Object.assign(new EventEmitter(), { username: undefined, _client: {}, health: 20, game: { dimension: 'overworld' },
    entity: { position: { x: 3.5, y: 100, z: 0.5, distanceTo: () => 0, clone() { return { ...this }; } }, onGround: true } });
  const scene = new body.scene.SceneSaver({ command: serverCommand, serverDir, root: path.join(dir, 'body', 'scenes'), self: () => body.scene.selfNames(bot) });
  const incidents = new body.incidents.Incidents(bot, { holdFile, scene });
  bot.username = 'LabBody';
  const lab: LabBody = { loop: null, incidents, bot, acts: [], refused: 0 };
  const result = (ok: boolean, line: string) => ({ v: 1, ok, done: ok ? 1 : 0, of: 1, at: { x: ok ? 9 : 3, y: 100, z: 0 }, hp: 20, food: 20, ms: 900,
    lines: [{ i: 1, do: 'go', status: ok ? 'done' : 'stopped', line }] });
  const actuator = {
    skills: [ACT],
    observe: () => ({ schemaVersion: 1, bodyId: 'minecraft:lab', sequence: ++bodySequence, stateAt: nowIso(), receivedAt: nowIso(), connected: true,
      state: { world: { position: { x: 3.5, y: 100, z: 0.5 } }, incidentHold: incidents.held() }, facts: { connected: true, alive: true, onGround: true } }),
    candidates: () => [],
    release: async () => true,
    resumeIncident: (id: string) => incidents.resume(id),
    cancelIncident: (id: string) => incidents.cancel(id),
    async execute(command: any) {
      const at = nowIso();
      const receipt = (outcome: string, text: string, extra: Record<string, unknown> = {}) => ({ id: command.id, connectionId: command.connectionId, outcome, inputsReleased: true, observedAt: at, result: text, ...extra });
      if (command.kind !== 'skill' || command.skill !== 'act') return receipt('failed', 'BODY_COMMAND_UNSUPPORTED');
      // As `NativeCommonFcaBody` does with an act (the incidents' beforeAct and afterAct, the receipt's `incident`).
      const heldWords = await incidents.beforeAct(command.context);
      if (heldWords) { lab.refused++; return receipt('failed', heldWords, { failureType: 'held', recoverable: false }); }
      lab.acts.push(command.id);
      const started = Date.now();
      await delay(400);
      const ok = !server.broken;
      const report = { ok, startedAt: started, done: ok ? 1 : 0, of: 1, stoppedBy: ok ? undefined : 'failure',
        lines: [{ i: 1, do: 'go', status: ok ? 'done' : 'stopped', line: ok ? 'go 着いた (9,100,0) 道 9 歩・掘 0・置 3・引き直し 0 回' : 'go 止まった stuck: 置いたブロックが世界に現れない（サーバーが置きを断った。1 回） (3,100,0) 道 3 歩・掘 0・置 0・引き直し 0 回' }] };
      const incident = await incidents.afterAct(command, report, Date.now() - started).catch(() => null);
      const text = body.incidents.withIncidentText(JSON.stringify(result(ok, report.lines[0]!.line)), incident);
      return receipt(ok ? 'completed' : 'failed', text, ok ? {} : { failureType: 'stuck', recoverable: true });
    },
  };
  const fetcher = async (_url: unknown, init: { body: string }) => {
    try { return new Response(JSON.stringify(control.poll({ scopeKey: 'owner', deviceId: 'minebot' } as never, JSON.parse(init.body)))); }
    catch (error) {
      if (!pollErrors++) log(`head: the body's poll was refused: ${String((error as Error)?.message ?? error).slice(0, 200)}`);
      return new Response(JSON.stringify({ error: 'FCA_BODY_POLL_INVALID' }), { status: 400 });
    }
  };
  lab.loop = new body.loop.CommonFcaControlLoop({ baseUrl: 'http://127.0.0.1:3000', token: 'lab-device-token-0000', serverId: 'lab', actuator, fetcher, pollMilliseconds: 100 });
  lab.loop.start();
  log(`body ${name} up (connection ${lab.loop.connectionId})`);
  return lab;
}
async function restart(old: LabBody, name: string): Promise<LabBody> {
  await old.loop.stop();
  await delay(3500); // the head's frame of the old connection goes stale
  return startBody(name);
}
/** The task a request's reply names (`taskId: <id>`). */
const taskOf = (reply: { out: string }) => /taskId: (\S+)/u.exec(reply.out)?.[1] ?? '';
const phase = (id: string) => driver.runtime.get('owner', id)?.phase ?? 'none';
const heldFile = () => fs.existsSync(holdFile);

// ---- the runs ------------------------------------------------------------------------------------------------------------------------------
let status = 1;
try {
  let lab = startBody('A');
  check('the head sees the body', await until(() => control.available().length === 1, 10_000), String(control.available()));
  if (control.available().length !== 1) throw new Error('the head never saw the body: nothing else can be checked');
  check('the operator socket is served', await until(socketReady, 10_000));

  // 1. Held: an act that stops stuck, asked to be held; the body holds and stops the world, the head holds the task and makes no decision.
  model.script = ['gap'];
  const started = await cli('request', '--operator', 'lab', '--hold-on-failure', '--max-minutes', '30', 'ラボ: 穴を渡る');
  check('the operator\'s request is accepted', started.code === 0 && /accepted/u.test(started.out), started.out);
  const task1 = taskOf(started);
  check('the body holds and stops the world', await until(() => heldFile() && server.frozen, 30_000), `file=${heldFile()} frozen=${server.frozen}`);
  check('the head holds the task (audited, stopped)', await until(() => audit.store.heldOf(task1) !== null && phase(task1) === 'stopped', 30_000), `phase=${phase(task1)}`);
  const decisionsAtHold = model.decisions;
  await delay(2000);
  check('no decision while held', model.decisions === decisionsAtHold, `${decisionsAtHold} → ${model.decisions}`);

  // 2. The body restarted (a deploy), and the cause fixed.
  lab = await restart(lab, 'B');
  check('after the restart the body is still held (its file), the world still stopped', heldFile() && server.frozen && lab.incidents.held()?.task === task1);
  check('the head sees the new connection', await until(() => control.available().length === 1, 10_000));
  server.broken = false;

  // 3. Resume: the body's hold ends first (the world moves), the task goes on, the held act is sent again and passes, then the next decision's act.
  model.script = ['walk'];
  const resumed = await cli('resume', '--operator', 'lab', '--latest');
  check('resume is accepted', resumed.code === 0 && /resumed/u.test(resumed.out), resumed.out);
  check('the body\'s hold ended and the world moves (before the act)', !heldFile() && !server.frozen && lab.incidents.held() === null, `file=${heldFile()} frozen=${server.frozen}`);
  check('the held act is sent again and passes', await until(() => lab.acts.length >= 1 && /成功/u.test(audit.store.recent('owner', 20).find(row => row.command === 'resume' && row.code === 'replayed')?.detail ?? ''), 30_000),
    audit.store.recent('owner', 20).find(row => row.command === 'resume' && row.code === 'replayed')?.detail ?? 'no replayed row');
  check('the decisions go on: the next act runs', await until(() => lab.acts.length >= 2, 30_000), `acts=${lab.acts.length} decisions=${model.decisions}`);
  check('no act was refused as held after the resume', lab.refused === 0, `refused=${lab.refused}`);
  const cancelled1 = await cli('cancel', '--operator', 'lab', '--latest');
  check('the task is cancelled at the end', cancelled1.code === 0, cancelled1.out);
  await until(() => ['stopped', 'failed', 'completed'].includes(phase(task1)), 15_000);

  // 4. Cancel of a held task after a restart: the body's hold ends, the world moves, the head's hold ends, a new request is taken.
  server.broken = true; model.script = ['gap'];
  const task2 = taskOf(await cli('request', '--operator', 'lab', '--hold-on-failure', '--max-minutes', '30', 'ラボ: 二つ目の穴'));
  check('held again (second request)', await until(() => heldFile() && server.frozen && audit.store.heldOf(task2) !== null && phase(task2) === 'stopped', 30_000));
  lab = await restart(lab, 'C');
  await until(() => control.available().length === 1, 10_000);
  const cancel2b = await cli('cancel', '--operator', 'lab', task2);
  check('cancel of the held task is accepted and says the body\'s hold ended', cancel2b.code === 0 && /体の保留も解け/u.test(cancel2b.out), cancel2b.out);
  check('after the cancel: no hold file, the world moves, no hold in the head', !heldFile() && !server.frozen && audit.store.heldOf(task2) === null);
  server.broken = false; model.script = ['walk'];
  const third = await cli('request', '--operator', 'lab', '--hold-on-failure', '--max-minutes', '30', 'ラボ: 三つ目');
  check('a new request is taken after the cancel', third.code === 0 && /accepted/u.test(third.out), third.out);
  const task3 = taskOf(third);
  check('its act runs', await until(() => lab.acts.length >= 1, 30_000), `acts=${lab.acts.length}`);
  // Its act ends and its receipt is taken before the body goes (a restart in the middle of an act is the unknown step's recovery, not this).
  await until(() => control.store.safe(task3), 15_000);
  await delay(1000);

  // 5. Disagreement: the body holds while the head runs the task (run 44 after the failed resend). Here: the body restarts with a hold file
  //    naming the running task. Its act is refused as held once; the head goes back to held, and the status says so.
  fs.mkdirSync(path.dirname(holdFile), { recursive: true });
  fs.writeFileSync(holdFile, JSON.stringify({ id: 'lab-mismatch-1', task: task3, at: nowIso(), frozen: true, freeze: 'The game is frozen', command: 'none', why: 'go_stuck' }));
  server.frozen = true;
  lab = await restart(lab, 'D');
  model.script = ['walk'];
  check('the head goes back to held when the body refuses an act as held (or shows the hold in its frame)', await until(() => audit.store.heldOf(task3) !== null && phase(task3) === 'stopped', 40_000),
    `phase=${phase(task3)} refused=${lab.refused}`);
  const decisionsAtMismatch = model.decisions;
  await delay(2000);
  check('at most one act is refused, and no decision after it', lab.refused <= 1 && model.decisions === decisionsAtMismatch, `refused=${lab.refused} decisions ${decisionsAtMismatch} → ${model.decisions}`);
  const shown = await cli('status');
  check('status shows the hold, and that the body refused an act', /体も同じ保留。体が act を断ったので頭が保留に戻した/u.test(shown.out), shown.out.slice(-400));
  model.script = ['walk'];
  const resumed3 = await cli('resume', '--operator', 'lab', '--latest');
  check('the hold taken back is resumed as any hold: the body ends it, the world moves, the decisions go on',
    resumed3.code === 0 && !heldFile() && !server.frozen && await until(() => lab.acts.length >= 1, 30_000), resumed3.out);
  await cli('cancel', '--operator', 'lab', '--latest');
  await until(() => ['stopped', 'failed', 'completed'].includes(phase(task3)), 15_000);

  // 5b (run 45, +929). A death between two acts of a task that asked to be held: the body holds it and stops the world, the head follows (the
  //    frame, or the next act's refusal), the operator resumes it, and the decisions go on.
  server.broken = false; model.script = ['walk'];
  const fourth = await cli('request', '--operator', 'lab', '--hold-on-failure', '--max-minutes', '30', 'ラボ: 死んでも保留');
  const task4 = taskOf(fourth);
  check('a request runs its act (before the death)', await until(() => lab.acts.length >= 2, 30_000), `acts=${lab.acts.length}`);
  await until(() => control.store.safe(task4), 15_000);
  await delay(1000);
  lab.bot.emit('death');
  check('a death outside an act: the body holds the task and stops the world', await until(() => heldFile() && server.frozen && lab.incidents.held()?.why === 'death', 10_000),
    JSON.stringify(lab.incidents.held()));
  model.script = ['walk'];
  check('the head holds it too (the frame, or the next act refused), and decides no more', await until(() => audit.store.heldOf(task4) !== null && phase(task4) === 'stopped', 40_000),
    `phase=${phase(task4)}`);
  const shownDeath = await cli('status');
  check('status says the body held outside an act', /体が act の外（死亡・瀕死）で保留し、頭も保留した/u.test(shownDeath.out), shownDeath.out.slice(-300));
  const actsBefore = lab.acts.length;
  model.script = ['walk'];
  const resumed4 = await cli('resume', '--operator', 'lab', '--latest');
  check('resume after the death: the world moves and the decisions go on', resumed4.code === 0 && !heldFile() && !server.frozen
    && await until(() => lab.acts.length > actsBefore, 30_000), resumed4.out);
  await cli('cancel', '--operator', 'lab', '--latest');
  await until(() => ['stopped', 'failed', 'completed'].includes(phase(task4)), 15_000);

  // 6. A hold file of a task that is gone (run 44's after the budget stopped it): the body comes up held, the head ends it (its tick).
  fs.writeFileSync(holdFile, JSON.stringify({ id: 'lab-stale-1', task: task1, at: nowIso(), frozen: false, freeze: 'others_present:I_am_Shannon', command: 'none', why: 'go_stuck' }));
  server.frozen = true;
  lab = await restart(lab, 'E');
  check('a hold of a task that is gone is ended and the world moves (the head\'s tick)', await until(() => !heldFile() && !server.frozen, 40_000), `file=${heldFile()} frozen=${server.frozen}`);
  check('the audit says so', await until(() => audit.store.recent('owner', 30).some(row => row.command === 'hold_stale' && row.code === 'released'), 10_000));
  await lab.loop.stop();
  status = checks.every(entry => entry.passed) ? 0 : 1;
} catch (error) {
  check('the lab ran to its end', false, String((error as Error)?.stack ?? error));
} finally {
  clearInterval(wakeTimer);
  console.log(`HOLD_LAB_RESULT ${JSON.stringify({ passed: status === 0, checks: checks.length, failed: checks.filter(entry => !entry.passed).map(entry => entry.name),
    decisions: model.decisions, acts: model.acts })}`);
  await operator.close().catch(() => undefined);
  await driver.close().catch(() => undefined);
  process.exit(status);
}
