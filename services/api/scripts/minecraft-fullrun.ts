// Explicit Sonnet-only isolated full mission. Validation entry unchanged.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { actionHarness } from '../tests/support/actionThreadHarness.js';
import { createTaskRuntimeWiring } from '../src/wiring/taskRuntimeWiring.js';
import { bodyTaskOnlyRecovery } from '../src/wiring/fcaBodyRecovery.js';
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
import { MINECRAFT_CONTROL_PATH } from '../src/contracts/minecraftControlContract.js';
import type { FcaModel } from '../src/mind/action/fca/fcaPorts.js';
import { strictMinecraftLlmcModel } from '../src/wiring/minecraftLlmcModelPolicy.js';
import { createRigModelLifecycle, trackRigModelWork } from './minecraftRigModelPolicy.js';
import { rigObservationPorts } from './minecraftRigObservation.js';
import { installRigFirstPayload } from './minecraftRigFirstPayload.js';
import { claudeClient } from '../src/infra/models/claude/claudeClient.js';
import { anthropicApiKey } from '../src/infra/models/anthropic/anthropicConfig.js';
import { FULLRUN_MODEL, FULLRUN_GOAL, fullrunModelValues, fullrunTransport, fullrunNativeProof, fullrunBodyHandshake } from './sonnetFullrunPolicy.js';
import { fullrunLaunchPolicy } from './sonnetRetainedPolicy.js';
const env = process.env;
const DIR = env.RIG_DIR ?? '';
const PORT = Number(env.RIG_PORT);
const NAME = env.RIG_BODY_NAME ?? 'I_am_Shannon';
const MODE = env.RIG_MODEL ?? 'script';
if (!DIR || !Number.isInteger(PORT))
    throw new Error('RIG_DIR and RIG_PORT (the lab server\'s game port, for the record) are required');
if (MODE !== 'real' || env.RIG_LLM_MODEL !== FULLRUN_MODEL)
    throw new Error('FULLRUN_PROFILE_INVALID');
const launchPolicy = fullrunLaunchPolicy(env);
const deadline = Number(env.FULLRUN_DEADLINE);
if (!Number.isFinite(deadline) || deadline <= Date.now() || deadline > Date.now() + 10800000)
    throw new Error('FULLRUN_DEADLINE');
fs.mkdirSync(DIR, {
    recursive: true
});
const STOP_FILE = env.RIG_STOP_FILE ?? path.join(DIR, 'rig.stop');
const expectedGoalEvidence = JSON.parse(fs.readFileSync(path.join(DIR, 'goal-evidence-definition.json'), 'utf8'));
const log = (line: string) => console.log(`RIG_LOG [${new Date().toISOString().slice(11, 19)}] ${line}`);
const emit = (tag: string, value: unknown) => console.log(`${tag} ${JSON.stringify(value)}`);
if (fs.existsSync(path.join(DIR, 'head', 'shannon.db')) || fs.existsSync(path.join(DIR, 'transport-ledger.json')))
    throw new Error('FULLRUN_REQUIRES_FRESH_DATABASE');
/** The env file's values (the production api.env on the VM); only what the Minecraft path reads, so no other feature of the head wakes up. */
function readValues(file: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/u)) {
        const m = /^([A-Z0-9_]+)=(.*)$/u.exec(line.trim());
        if (!m)
            continue;
        const key = m[1]!;
        if (!/^(SHANNON_(ANTHROPIC|HAIKU|FCA_|MINECRAFT_LLMC|SONNET|TIMEZONE|OWNER)|ANTHROPIC_)/u.test(key))
            continue;
        out[key] = m[2]!.replace(/^(['"])(.*)\1$/u, '$2');
    }
    return out;
}
const values: Record<string, string> = fullrunModelValues(readValues(env.RIG_ENV_FILE ?? ''));
const strictModel = strictMinecraftLlmcModel(values);
const credential = anthropicApiKey(values);
if (!credential)
    throw new Error('FULLRUN_REGULAR_KEY_REQUIRED');
const durable = (name: string, value: unknown) => {
    const file = path.join(DIR, name);
    fs.writeFileSync(file + '.tmp', JSON.stringify(value, null, 2) + '\n', {
        mode: 0o600
    });
    fs.renameSync(file + '.tmp', file);
};
const transport = fullrunTransport(claudeClient({
    apiKey: credential, timeoutMilliseconds: 90000
}), {
    deadline, budget: launchPolicy.budget, save: value => durable('transport-ledger.json', value),
    stop: reason => { emit('FULLRUN_STOP', {
        reason
    }); fs.writeFileSync(STOP_FILE, reason + '\n', {
        mode: 0o600
    }); },
});
// ---- the head (the hold lab's wiring, with the production's budget and models) ------------------------------------------------------------------
const dbPath = path.join(DIR, 'head', 'shannon.db');
fs.mkdirSync(path.dirname(dbPath), {
    recursive: true
});
const nowIso = () => new Date().toISOString();
const h = actionHarness(nowIso, dbPath);
const SERVER_ID = 'rig';
const configuration = configuredMinecraftBody({
    SHANNON_MINECRAFT_BODY_JSON: JSON.stringify({
        deviceId: 'minebot',
        servers: [
            {
                serverId: SERVER_ID, title: 'rig', onlineMode: false, ownerUuid: 'b9191317-c52d-4d67-85fe-ab831e6db146'
            }
        ]
    })
})!;
const leases = new ActionLeaseReader(h.db);
const bodyResource = actionResource('minebot', 'minecraft-body');
const known = (lease: any, taskId: string) => bodyLeaseAttempt(leases.get(lease.id), 'owner', lease, taskId);
const control = new MinecraftControl(new MinecraftControlStore(h.db), configuration, {
    now: Date.now, ownerAlone: () => true,
    leaseKnown: (lease, taskId) => bodyLeaseKnown(known(lease, taskId), bodyResource),
    leaseValid: (lease, taskId) => bodyLeaseValid(known(lease, taskId), lease, bodyResource, nowIso()),
    leaseAttempted: (lease, taskId) => known(lease, taskId) !== null
});
const firstPayload = installRigFirstPayload({
    enabled: env.RIG_CAPTURE_FIRST_PAYLOAD, keep: env.RIG_KEEP === 'true', modelMode: MODE,
    directory: DIR, obsMode: rigObservationPorts({}, values).obsMode, minecraftTask: id => Boolean(control.store.body(id)), log
});
const audit = configuredOperatorAudit({
    ...values, SHANNON_OPERATOR_MINECRAFT: 'on'
}, dbPath)!;
let driver: ReturnType<typeof createTaskRuntimeWiring>;
const budget = fcaBudget({
    actions: h.actions, store: new TaskBudgetStore(h.db), now: nowIso, ownTime: null,
    minecraftRequest: task => admittedMinecraftRequest(task as never, (task as {
        parentId?: string;
    }).parentId ? driver.runtime.get((task as {
        scopeKey: string;
    }).scopeKey, (task as {
        parentId: string;
    }).parentId) as never : null, Boolean(control.store.body((task as {
        id: string;
    }).id))),
    taskCapYen: (id: string) => audit.store.budgetYen(id)
});
let spentUsd = 0;
let calls = 0;
let usageComplete = true;
const timeZone = ownerTimeZone(values);
const recordUsage = (usage: {
    estimatedCostUsd: number;
    usageComplete: boolean;
    model: string;
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
}) => {
    budget.recordUsage(usage.estimatedCostUsd, !usage.usageComplete);
    spentUsd += usage.estimatedCostUsd;
    calls++;
    usageComplete = usageComplete && usage.usageComplete;
    emit('RIG_USAGE', {
        n: calls, model: usage.model, usd: Number(usage.estimatedCostUsd.toFixed(4)), totalUsd: Number(spentUsd.toFixed(4)), inTokens: usage.inputTokens,
        cachedIn: usage.cachedInputTokens, outTokens: usage.outputTokens, complete: usage.usageComplete
    });
};
/** The plumbing test's model: a script of what a decision gives, so the whole chain runs without a key. */
const scriptModel = (): FcaModel => {
    let decisions = 0;
    return {
        async decide() {
            decisions++;
            await delay(300);
            const hands = [
                {
                    do: 'wait', seconds: 2
                }
            ];
            return decisions === 2 ? {
                decision: {
                    kind: 'tools', calls: [
                        {
                            id: `rig-${decisions}`, name: MC_ACT_TOOL, input: {
                                hands, why: '[rig] script'
                            }
                        }
                    ]
                }, history: [
                    {
                        role: 'assistant', content: 'act'
                    }
                ]
            }
                : {
                    decision: {
                        kind: 'tools', calls: [
                            {
                                id: `look-${decisions}`, name: 'task.list', input: {}
                            }
                        ]
                    }, history: [
                        {
                            role: 'assistant', content: 'look'
                        }
                    ]
                };
        },
        toolResults: results => ({
            role: 'user', results
        }),
    } as FcaModel;
};
const clock = () => ({
    localTime: ownerLocalClock(new Date(), timeZone), timeZone
});
const real = MODE === 'real'
    ? configuredMinecraftLlmc(values, {
        client: transport.client as never, recordUsage: recordUsage as never, clock, compactAboveTokens: fcaCompactAboveTokens(values.SHANNON_FCA_COMPACT_ABOVE_TOKENS), stopGraceMilliseconds: 20000
    }, {
        client: transport.client as never, log: line => log(`llmc: ${line}`)
    })
    : null;
if (MODE === 'real' && !real)
    throw new Error(("RIG_NO_MODEL_KEY: configuredMinecraftLlmc made nothing (no key for the main model in the env fi" + "le)"));
const fake = scriptModel();
const baseLlmc: LlmcWiring = real ?? {
    names: {
        main: 'rig-script', escalate: null, plan: 'rig-script'
    } as never, models: {
        main: fake, escalate: null
    }, summarizer: null,
    policy: LLMC_HISTORY_POLICY, historyAhead: createFcaHistoryAhead()
};
const modelLifecycle = createRigModelLifecycle();
const llmc = trackRigModelWork(baseLlmc, modelLifecycle);
if (real)
    emit('RIG_MODELS', {
        main: real.names.main, escalate: real.names.escalate, plan: real.names.plan,
        summary: strictModel, redecide: strictModel
    });
function withoutHistory<T extends {
    history?: unknown;
}>(ports: T): Omit<T, 'history'> { const { history: _history, ...rest } = ports; return rest; }
driver = createTaskRuntimeWiring({
    db: h.db, actions: h.actions, scopeKey: 'owner', ownerAlone: () => true, now: nowIso, model: llmc.models.main, budget, continueAtOnce: true,
    bodyRecovery: () => bodyTaskOnlyRecovery(id => control.store.body(id)),
    stepPorts: (runtime: any, step: any) => {
        const small = llmcStepParts(llmc, step, control, line => log(`head: ${line}`));
        const taskBody = createMinecraftTaskBody({
            control, runtime, step, ownerAlone: () => true, sourcesVisible: () => true, ...small.body
        });
        const permit = async () => {
            await actionPermit();
            const active = currentActionExecution();
            if (!active || active.lease.id !== step.lease.id)
                throw new Error('FCA_SOURCE_WITHHELD');
            active.signal.throwIfAborted();
            if (runtime.get(step.scopeKey, step.taskId)?.phase !== 'executing')
                throw new Error('FCA_TASK_STOPPING');
        };
        const binding = minecraftGoalBinding(step.snapshot.task, `minecraft:${SERVER_ID}`);
        const life = llmcLifecycle(small, taskBody.body);
        const ports = {
            keepBodyTools: () => true, body: life, sourcesVisible: () => true, waitCounterpart: () => false,
            tools: createFcaProgressTools(combineFcaTools(small.planTools, fcaMinecraftTools({
                control, step, ownerAlone: () => true, sourcesVisible: () => true, ...small.tools,
                evidence: result => {
                    try {
                        const bodyId = control.store.body(step.taskId);
                        const frame = bodyId ? control.frame(bodyId)?.poll : null;
                        if (!bodyId || !frame)
                            return;
                        const expected = {
                            scopeKey: step.scopeKey, taskId: step.taskId, bodyId, sessionId: step.id,
                            connectionId: frame.connectionId, goal: step.snapshot.task.goal, completionCriteria: step.snapshot.task.completionCriteria
                        };
                        const evidence = JSON.parse(result ?? 'null');
                        const measured = {
                            at: nowIso(), taskId: step.taskId, expected, evidence, deadlineMs: deadline,
                            verified: fullrunNativeProof(evidence, expected, deadline)
                        };
                        fs.appendFileSync(path.join(DIR, 'native-evidence.jsonl'), JSON.stringify(measured) + '\n', {
                            mode: 0o600
                        });
                        if (measured.verified || evidence?.boss?.verified === true || !fs.existsSync(path.join(DIR, 'native-verdict.json')))
                            durable('native-verdict.json', measured);
                    }
                    catch { /* failed measurement cannot manufacture a proof */ }
                }
            }), taskBody.tools), {
                checkpoint: step.snapshot.checkpoint, binding, requireConditions: true, permit
            }),
            // The script's rounds are plain (not the Anthropic model's signed rounds): without a key the mode's history codec is left out, as
            // the hold lab does.
            ...(MODE === 'real' ? small.ports : withoutHistory(small.ports))
        };
        return small.menu(rigObservationPorts(ports, values) as never);
    }
} as never);
const wakeTimer = setInterval(() => { void driver.tick().catch(() => undefined); }, 200);
const spec = (goal: string) => { if (goal !== FULLRUN_GOAL)
    throw new Error('FULLRUN_ORIGINAL_GOAL_ONLY'); return ({
    title: goal.slice(0, 120), goal, completionCriteria: MINECRAFT_REQUEST_CRITERIA, context: MINECRAFT_REQUEST_CONTEXT
}); };
const bound = () => { const tasks = []; for (const task of driver.runtime.list('owner', {
    limit: 100, offset: 0
}))
    if (control.store.body(task.id))
        tasks.push(task); return tasks; };
const requests = operatorMinecraftRequests({
    control, runtime: driver.runtime, ownerScope: 'owner', stop: driver.stop, atomic: (work: () => unknown) => work(), bound, spec
} as never);
const operator = startOperatorMinecraft({
    audit, path: dbPath, scopeKey: 'owner', now: nowIso, ownerAlone: () => true, log: (line: string) => log(`operator: ${line}`),
    requests: {
        ...requests, wake: () => { void driver.tick(); }
    }, lifecycle: null, actions: h.actions,
    activity: {
        append: () => undefined
    } as never, config: {
        timeZone
    } as never,
    conversation: {
        threadId: () => 'thread', appendNoteOnce: () => null
    }
} as never);
// ---- the body's door: the control's poll over HTTP on the loopback (production: the API's authenticated route; the body is the rig's other process) ---------
let pollErrors = 0;
const door = http.createServer((request, response) => {
    if (request.method !== 'POST' || request.url !== MINECRAFT_CONTROL_PATH) {
        response.statusCode = 404;
        response.end('{}');
        return;
    }
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(chunk as Buffer));
    request.on('end', () => {
        response.setHeader('content-type', 'application/json');
        try {
            const poll = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            const result = control.poll({
                scopeKey: 'owner', deviceId: 'minebot'
            } as never, poll);
            firstPayload?.observe(poll);
            response.end(JSON.stringify(result));
        }
        catch (error) {
            if (!pollErrors++)
                log(`the body's poll was refused: ${String((error as Error)?.message ?? error).slice(0, 200)}`);
            response.statusCode = 400;
            response.end(JSON.stringify({
                error: 'FCA_BODY_POLL_INVALID'
            }));
        }
    });
});
await new Promise<void>(resolve => door.listen(0, '127.0.0.1', resolve));
const httpPort = (door.address() as {
    port: number;
}).port;
emit('RIG_HTTP', {
    port: httpPort, url: `http://127.0.0.1:${httpPort}`
});
const socketReady = () => fs.existsSync(path.join(path.dirname(dbPath), 'operator-runtime', 'operator.sock'));
for (let waited = 0; waited < 150000 && !(socketReady() && control.available().length === 1); waited += 200)
    await delay(200);
if (!(socketReady() && control.available().length === 1)) {
    emit('RIG_FAILED', {
        reason: 'the head never saw the body or the operator socket is missing', socket: socketReady(), bodies: control.available().length
    });
    process.exit(3);
}
const readyPoll = control.frame(control.available()[0]!)!.poll;
const initialDimension = String(readyPoll.observation.facts.dimension ?? '').replace(/^minecraft:/u, '');
const checkedBody = fullrunBodyHandshake(env.FULLRUN_BODY_REV ?? '', readyPoll.bodyVersion, readyPoll.skills, expectedGoalEvidence);
const bodyHandshake = {
    ...checkedBody, initialDimension, profile: launchPolicy.profile,
    ok: checkedBody.ok && initialDimension === launchPolicy.initialDimension
};
durable('body-handshake.json', bodyHandshake);
if (!bodyHandshake.ok)
    throw new Error('FULLRUN_BODY_REVISION_OR_CATALOG_MISMATCH');
emit('RIG_READY', {
    db: dbPath, socket: path.join(path.dirname(dbPath), 'operator-runtime', 'operator.sock'), body: NAME, port: PORT, mode: MODE,
    configuredObsMode: rigObservationPorts({}, values).obsMode, pid: process.pid, httpPort, bodyHandshake
});
let closing = false;
async function shutdown(code: number): Promise<never> {
    if (closing)
        return new Promise<never>(() => undefined);
    closing = true;
    modelLifecycle.stopAccepting();
    transport.stopAccepting();
    clearInterval(wakeTimer);
    emit('RIG_STOPPING', {
        totalUsd: Number(spentUsd.toFixed(4)), calls
    });
    await new Promise<void>(resolve => door.close(() => resolve()));
    await operator.close().catch(() => undefined);
    await driver.close().catch(() => { usageComplete = false; });
    await modelLifecycle.drain();
    await transport.drain();
    durable('transport-final.json', transport.snapshot());
    firstPayload?.close();
    emit('RIG_STOPPED', {
        totalUsd: Number(spentUsd.toFixed(4)), calls, complete: usageComplete && transport.snapshot().complete
    });
    setTimeout(() => process.exit(code), 500).unref();
    return new Promise<never>(() => undefined);
}
process.on('SIGTERM', () => { void shutdown(0); });
process.on('SIGINT', () => { void shutdown(0); });
for (;;) {
    await delay(1000);
    if (Date.now() >= deadline || fs.existsSync(STOP_FILE))
        await shutdown(0);
}
