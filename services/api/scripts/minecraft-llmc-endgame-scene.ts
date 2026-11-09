// The scene replay of the way past the Nether (2026-11-02, S3), on the mode's own path: the live state as a live decision builds it
// (`llmcTransient`: the facts, the road and the meter, the plan's kinds) and the model with the mode's hooks (`minecraftV2Hooks`: the
// rewritten live state and the stage knowledge). `scripts/minecraft-llmc-scene.ts` builds the older, plain live state and picks no stage, so
// it cannot show what the stages' words and the facts of this stretch change. Nothing reaches a body.
//
//   cd services/api && node --import tsx scripts/minecraft-llmc-endgame-scene.ts <scenes.json> --dry
//   cd services/api && ANTHROPIC_API_KEY=… node --import tsx scripts/minecraft-llmc-endgame-scene.ts <scenes.json> [--models=sonnet] [--repeat=1]
//     [--scenes=a,b] [--out=answers.json] [--cap=1.0] [--spent=0]
//   cd services/api && [ANTHROPIC_API_KEY=…] node --import tsx scripts/minecraft-llmc-endgame-scene.ts <scenes.json> --film [--fake] [--route]
//     [--film-main=sonnet] [--repeat=1] [--scenes=a,b] [--out=answers.json] [--cap=1.0]   (the filming's model pipe: see `film`)
//
// A scene is `LlmcScene` (`minecraftLlmcScene.ts`) with one more field: `eyes`, thrown eyes the ledger holds already (`{ x, z, bearingDeg, flew,
// broke, at }`). `--dry` prints, a scene at a time, the stages picked, the facts lines, and the tokens of the stage knowledge and the live state
// (no key, no call). The same script runs on an older tree (the facts and the ledger are then simply absent), so the same scenes are asked of
// both and the answers read side by side. It stops before a call once the spending (with `--spent`) passes `--cap` dollars.
import { readFileSync, writeFileSync } from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import { planDisplay, planFromSeeds, planPath, readPlanTree, type PlanSeed, type PlanTree } from '@shannon/mind';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { MC_ACT_TOOL, type ActHand } from '../src/contracts/minecraftActContract.js';
import { createAnthropicFcaModel, type AnthropicFcaUsage } from '../src/infra/models/anthropic/anthropicFcaModel.js';
import type { FcaModelInput } from '../src/mind/action/fca/fcaPorts.js';
import { seedPlan } from '../src/surfaces/minecraft/minecraftFirstPlan.js';
import { llmcPrepare } from '../src/surfaces/minecraft/minecraftLlmc.js';
import { llmcTransient } from '../src/surfaces/minecraft/minecraftLlmcBody.js';
import type { LlmcBodyParts } from '../src/surfaces/minecraft/minecraftLlmcBodyFacts.js';
import { createLlmcEvents } from '../src/surfaces/minecraft/minecraftLlmcEvents.js';
import { llmcLiveTokens, llmcPlanTokens, llmcTokens } from '../src/surfaces/minecraft/minecraftLlmcLive.js';
import { SCENE_TOOLS, type LlmcScene } from '../src/surfaces/minecraft/minecraftLlmcScene.js';
import { stagesFor } from '../src/surfaces/minecraft/minecraftLlmcV2Knowledge.js';
import { sceneVerdict, type SceneCheck } from '../src/surfaces/minecraft/minecraftLlmcSceneCheck.js';
import { candidateLive, candidateMenuTools, minecraftV2Hooks } from '../src/surfaces/minecraft/minecraftLlmcV2.js';
import { ROUTE_SYSTEM, routeInput } from '../src/surfaces/minecraft/minecraftRoutePlanner.js';
import { configuredMinecraftLlmc, decidedBy, llmcModelRouter } from '../src/wiring/minecraftLlmcConfiguration.js';

type EndScene = LlmcScene & { /** The blazes' watch at the camp: minutes since they came near, and the kills since. */
  blaze?: { minutes: number; kills: number };
  /** The endermen hunt: minutes since they came near, the deaths since, and the pearls carried then. */
  hunt?: { minutes: number; kills: number; pearls0: number };
  eyes?: Array<{ x: number; z: number; bearingDeg: number; flew: number; broke: boolean; at: number }>;
  /** What the hands of a good decision hold (`minecraftLlmcSceneCheck.ts`); the replay counts the decisions that meet it. */
  check?: SceneCheck };
const MODELS: Record<string, string> = { haiku: 'claude-haiku-5-5', sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5' };
const args = process.argv.slice(2);
const flag = (name: string) => args.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const file = args.find(arg => !arg.startsWith('--'));
const dry = args.includes('--dry');
const apiKey = process.env.SHANNON_ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_API_KEY;
if (!file || (!dry && !apiKey && !(args.includes('--film') && args.includes('--fake')))) {
  console.error('usage: [ANTHROPIC_API_KEY=…] node --import tsx scripts/minecraft-llmc-endgame-scene.ts <scenes.json> [--dry] [--models=sonnet] [--repeat=1]');
  process.exit(2);
}
const only = flag('scenes')?.split(',').map(name => name.trim());
const scenes = (JSON.parse(readFileSync(file, 'utf8')) as EndScene[]).filter(scene => !only || only.includes(scene.name));
// The dragon's facts and the ledger exist only on a tree that has them (this script is also run on the tree before them).
const endgameModule = await import('../src/surfaces/minecraft/minecraftEndgame.js').catch(() => null);

function treeOf(scene: EndScene): PlanTree {
  const given = Array.isArray(scene.plan) ? planFromSeeds(scene.plan as readonly PlanSeed[]) : scene.plan ? readPlanTree(scene.plan) : seedPlan(scene.goal);
  if (!given) throw new Error(`scene ${scene.name}: no plan`);
  return scene.current && given.nodes.some(node => node.id === scene.current) ? { ...given, current: scene.current } : given;
}

/** The decision input of a scene on the mode's own path, and the live object the stages are picked from. */
function inputOf(scene: EndScene): { input: FcaModelInput; live: Record<string, unknown> } {
  const observation = { schemaVersion: 1, bodyId: 'minecraft:scene', sequence: 1, stateAt: new Date(0).toISOString(), receivedAt: new Date(0).toISOString(),
    connected: true, state: { world: scene.world as never }, facts: { alive: true } } as unknown as BodyObservation;
  const tree = treeOf(scene);
  const view = { revision: tree.revision, ...planPath(tree) };
  // The scene's clock is half a minute after its newest throw (the ledger does not read a throw older than 45 minutes).
  const sceneNow = Math.max(scene.blaze || scene.hunt ? 3_600_000 : 0, ...(scene.eyes ?? []).map(item => item.at)) + 30_000;
  const throws = (scene.eyes ?? []).map((item, index) => ({ id: `scene${index}`, toX: item.x, toZ: item.z, ...item }));
  const watch = scene.blaze ? { minecraftBlazeWatch: { v: 1, since: sceneNow - scene.blaze.minutes * 60_000, lastNear: sceneNow - 5_000,
    kills: Array.from({ length: scene.blaze.kills }, (_, index) => ({ key: `scene:${index}`, at: sceneNow - 60_000 })) } } : {};
  const chase = scene.hunt ? { minecraftEnderHunt: { v: 1, since: sceneNow - scene.hunt.minutes * 60_000, lastNear: sceneNow - 5_000, pearls0: scene.hunt.pearls0,
    kills: Array.from({ length: scene.hunt.kills }, (_, index) => ({ key: `scene:${index}`, at: sceneNow - 60_000 })) } } : {};
  const endgame = endgameModule?.createEndgame({ minecraftEyes: { v: 1, throws }, ...watch, ...chase }, () => sceneNow);
  const parts = { plan: () => planDisplay(tree), planView: () => view, planTree: () => tree, ...(endgame ? { endgame } : {}) } as unknown as LlmcBodyParts;
  const events = createLlmcEvents(`scene-${scene.name}`);
  for (const line of scene.events ?? []) events.note(line);
  events.take(null);
  const transient = llmcTransient(parts, events, observation, scene.elapsedMinutes ?? null, [], {}, `scene-${scene.name}`);
  const tools = candidateMenuTools(SCENE_TOOLS);
  const input = { task: { id: `scene-${scene.name}`, title: scene.goal, goal: scene.goal, completionCriteria: '依頼の達成を新しい観測で確かめる' },
    messages: [], children: [], history: [], tools, coreTools: tools, catalog: tools.map(item => ({ name: item.name, description: item.description })),
    transient, plan: view } as unknown as FcaModelInput;
  return { input, live: { plan: view, body: transient } };
}

function show(scene: EndScene): void {
  const { live, input } = inputOf(scene);
  const shown = candidateLive(live);
  const facts = (shown.live.body as { facts?: unknown } | undefined)?.facts;
  console.log(`## ${scene.name}  stages=${stagesFor(live).join('+')}  stageTokens=${shown.stage ? llmcTokens(shown.stage) : 0}  liveTokens=${llmcLiveTokens(shown.live)}`
    + `  planTokens=${llmcPlanTokens(input.plan)}`);
  console.log(JSON.stringify(facts ?? [], null, 0));
  const body = shown.live.body as { shortage?: string | null } | undefined;
  if (body?.shortage) console.log(`   shortage: ${body.shortage}`);
}

/**
 * `--film` (thru-1110, 11/9: the pipe of the 11/10 filming before it is paid for live): the models are made by the head's own factory
 * (`configuredMinecraftLlmc`) from the filming's environment, `SHANNON_MINECRAFT_LLMC_MODEL` alone (Sonnet, `--film-main=` to change it), so the
 * plan model is the head's default (Opus) and no escalation; each scene goes through `llmcModelRouter` with its plan as the checkpoint, so a scene
 * on an End or dragon node is decided by the strong model and the rest by the main one. With `--route`, the first scene's world is also asked of
 * the plan model as a route (`ROUTE_SYSTEM`), the planner path of the run. Each answer prints the model the router chose, the model the provider
 * answered as, the cache read and written, and whether the act could be read. `--fake` sends nothing: a client that records the model each request
 * names and refuses it, so the routing is seen without a key or a cent.
 */
async function film(): Promise<void> {
  const fake = args.includes('--fake');
  const main = MODELS[flag('film-main') ?? 'sonnet'] ?? flag('film-main')!;
  const env: Record<string, string> = { SHANNON_MINECRAFT_LLMC_MODEL: main, SHANNON_ANTHROPIC_API_KEY: fake ? 'fake-key-no-call' : apiKey! };
  const asked: Array<{ model: string; cached: boolean }> = [];
  const answered: Array<{ model: string; read: number; written: number }> = [];
  const real = fake ? null : new Anthropic({ apiKey: apiKey!, maxRetries: 0, timeout: 120_000 });
  const client = { messages: { async create(body: Anthropic.MessageCreateParamsNonStreaming, options?: { signal?: AbortSignal; headers?: Record<string, string> }) {
    asked.push({ model: String(body.model), cached: JSON.stringify(body).includes('"cache_control"') });
    if (!real) throw new Error(`FAKE_NO_CALL model=${body.model}`);
    const message = await real.messages.create(body, { signal: options?.signal, ...(options?.headers ? { headers: options.headers } : {}) });
    const usage = message.usage as { cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null };
    answered.push({ model: message.model, read: usage.cache_read_input_tokens ?? 0, written: usage.cache_creation_input_tokens ?? 0 });
    return message;
  } } };
  const usage: AnthropicFcaUsage[] = [];
  const llmc = configuredMinecraftLlmc(env, { recordUsage: value => { usage.push(value); }, client: client as never },
    { log: line => console.log(line), client: client as never });
  if (!llmc) throw new Error('no LLM-centric wiring');
  console.log(`FILM env: SHANNON_MINECRAFT_LLMC_MODEL=${main} (nothing else) -> main=${llmc.names.main} plan=${llmc.names.plan} escalate=${llmc.names.escalate ?? 'none'}`);
  const repeat = Math.max(1, Number(flag('repeat') ?? 1));
  const cap = Number(flag('cap') ?? 1);
  let spent = Number(flag('spent') ?? 0);
  const out = flag('out');
  const answers: unknown[] = [];
  const spend = (from: number) => usage.slice(from).reduce((sum, item) => sum + item.estimatedCostUsd, 0);
  const note = (label: string, chosen: string, from: number, fromAsked: number, fromAnswered: number, began: number, extra: string, error?: unknown) => {
    const cost = fake ? 0 : spend(from); spent += cost; // a refused fake request is booked by the head as unknown (its worst case): not spent
    const sent = asked.slice(fromAsked).map(item => `${item.model}${item.cached ? '+cache' : ''}`).join(',') || '-';
    const back = answered.slice(fromAnswered);
    const line = { label, chosen, sent, answeredAs: back.map(item => item.model), cacheRead: back.reduce((s, i) => s + i.read, 0),
      cacheWritten: back.reduce((s, i) => s + i.written, 0), costUsd: cost, ms: Math.round(performance.now() - began), extra, error: error ? String(error).slice(0, 160) : null };
    answers.push(line);
    console.log(`${label}\tchosen=${chosen}\tsent=${sent}\tanswered=${line.answeredAs.join(',') || '-'}\tread=${line.cacheRead}\twritten=${line.cacheWritten}`
      + `\t$${cost.toFixed(4)}\t${line.ms}ms\t${error ? `error ${line.error}` : extra}`);
    if (out) writeFileSync(out, JSON.stringify(answers, null, 1));
  };
  if (args.includes('--route') && scenes[0]) {
    const from = usage.length, a = asked.length, b = answered.length, began = performance.now();
    try {
      const reply = await llmc.planner!(ROUTE_SYSTEM, routeInput(scenes[0].world as Record<string, unknown>, 0, null), new AbortController().signal);
      note(`route:${scenes[0].name}`, llmc.names.plan, from, a, b, began, `reply=${JSON.stringify(reply).slice(0, 120)}`);
    } catch (error) { note(`route:${scenes[0].name}`, llmc.names.plan, from, a, b, began, '', error); }
  }
  for (const scene of scenes) {
    for (let round = 0; round < repeat; round += 1) {
      if (spent > cap) { console.log(`STOP: spent $${spent.toFixed(3)} > cap $${cap}`); return; }
      const dimension = String((scene.world as { dimension?: unknown } | undefined)?.dimension ?? '') || null;
      const model = llmcModelRouter(llmc.models, { fcaPlanTree: treeOf(scene) }, line => console.log(line), `scene-${scene.name}`, () => dimension);
      const chosen = decidedBy(llmc, model);
      const from = usage.length, a = asked.length, b = answered.length, began = performance.now();
      try {
        const output = await model.decide(inputOf(scene).input, new AbortController().signal);
        const calls = output.decision.kind === 'tools' ? output.decision.calls : [];
        const act = calls.find(call => call.name === MC_ACT_TOOL);
        const prepared = act ? llmcPrepare(MC_ACT_TOOL, act.input) : null;
        const hands = ((prepared?.input as { hands?: ActHand[] } | undefined)?.hands ?? []).map(hand => String((hand as { do?: unknown }).do));
        note(`${scene.name}\tr${round}`, chosen, from, a, b, began, `kind=${output.decision.kind} act=${act ? (prepared ? 'readable' : 'UNREADABLE') : 'none'} hands=${hands.join(',') || '-'}`);
      } catch (error) { note(`${scene.name}\tr${round}`, chosen, from, a, b, began, '', error); }
    }
  }
  console.log(`TOTAL spent (head's count, with --spent) $${spent.toFixed(4)}; requests ${asked.length}: ${[...new Set(asked.map(item => item.model))].join(', ')}`);
}

async function replay(): Promise<void> {
  const names = (flag('models') ?? 'sonnet').split(',').map(name => MODELS[name.trim()] ?? name.trim());
  const repeat = Math.max(1, Number(flag('repeat') ?? 1));
  const cap = Number(flag('cap') ?? Infinity);
  const out = flag('out');
  let spent = Number(flag('spent') ?? 0);
  const answers: unknown[] = [];
  const tally = new Map<string, { pass: number; of: number; ms: number; usd: number }>();
  for (const name of names) {
    const usage: AnthropicFcaUsage[] = [];
    const model = createAnthropicFcaModel({ model: name, apiKey: apiKey!, recordUsage: value => { usage.push(value); }, minecraftOwnPrompt: true, minecraftV2: minecraftV2Hooks() });
    for (const scene of scenes) {
      for (let round = 0; round < repeat; round += 1) {
        if (spent > cap) { console.log(`STOP: spent $${spent.toFixed(3)} > cap $${cap}`); return; }
        const before = usage.length;
        const began = performance.now();
        try {
          const output = await model.decide(inputOf(scene).input, new AbortController().signal);
          const cost = usage.slice(before).reduce((sum, item) => sum + item.estimatedCostUsd, 0);
          spent += cost;
          const calls = output.decision.kind === 'tools' ? output.decision.calls.map(call => ({ name: call.name, input: call.input })) : [];
          const act = calls.find(call => call.name === MC_ACT_TOOL);
          const prepared = act ? llmcPrepare(MC_ACT_TOOL, act.input) : null;
          const full = ((prepared?.input as { hands?: ActHand[] } | undefined)?.hands ?? []) as unknown as Array<Record<string, unknown>>;
          const hands = full.map(hand => String(hand.do));
          const ms = Math.round(performance.now() - began);
          const verdict = sceneVerdict(scene.check, full);
          const mine = usage.slice(before);
          const tokens = { input: mine.reduce((sum, item) => sum + item.inputTokens, 0), cached: mine.reduce((sum, item) => sum + item.cachedInputTokens, 0),
            output: mine.reduce((sum, item) => sum + item.outputTokens, 0) };
          const total = tally.get(name) ?? { pass: 0, of: 0, ms: 0, usd: 0 };
          tally.set(name, { pass: total.pass + (verdict.pass ? 1 : 0), of: total.of + 1, ms: total.ms + ms, usd: total.usd + cost });
          answers.push({ model: name, round, scene: scene.name, ms, calls, hands: full, pass: verdict.pass, why: verdict.why, tokens, costUsd: cost, expect: scene.expect });
          console.log(`${scene.name}\t${name}\tr${round}\t${ms}ms\t${verdict.pass ? 'PASS' : `FAIL(${verdict.why.join(' / ')})`}\thands=${hands.join(',') || '-'}\t`
            + `$${cost.toFixed(4)}\tin=${tokens.input} cached=${tokens.cached} out=${tokens.output}\t${JSON.stringify(calls)}`);
        } catch (error) {
          console.log(`${scene.name}\t${name}\tr${round}\terror ${String(error)}`);
        }
        if (out) writeFileSync(out, JSON.stringify(answers, null, 1));
      }
    }
  }
  for (const [model, total] of tally) {
    console.log(`SUMMARY ${model}: ${total.pass}/${total.of} meet the checks, ${Math.round(total.ms / total.of)} ms a decision, $${(total.usd / total.of).toFixed(4)} a decision`);
  }
  console.log(`TOTAL spent (with --spent) $${spent.toFixed(4)}`);
}

if (dry) for (const scene of scenes) show(scene);
else if (args.includes('--film')) await film();
else await replay();
