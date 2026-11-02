// The scene replay of the way past the Nether (2026-11-02, S3), on the mode's own path: the live state as a live decision builds it
// (`llmcTransient`: the facts, the road and the meter, the plan's kinds) and the model with the mode's hooks (`minecraftV2Hooks`: the
// rewritten live state and the stage knowledge). `scripts/minecraft-llmc-scene.ts` builds the older, plain live state and picks no stage, so
// it cannot show what the stages' words and the facts of this stretch change. Nothing reaches a body.
//
//   cd services/api && node --import tsx scripts/minecraft-llmc-endgame-scene.ts <scenes.json> --dry
//   cd services/api && ANTHROPIC_API_KEY=… node --import tsx scripts/minecraft-llmc-endgame-scene.ts <scenes.json> [--models=sonnet] [--repeat=1]
//     [--scenes=a,b] [--out=answers.json] [--cap=1.0] [--spent=0]
//
// A scene is `LlmcScene` (`minecraftLlmcScene.ts`) with one more field: `eyes`, thrown eyes the ledger holds already (`{ x, z, bearingDeg, flew,
// broke, at }`). `--dry` prints, a scene at a time, the stages picked, the facts lines, and the tokens of the stage knowledge and the live state
// (no key, no call). The same script runs on an older tree (the facts and the ledger are then simply absent), so the same scenes are asked of
// both and the answers read side by side. It stops before a call once the spending (with `--spent`) passes `--cap` dollars.
import { readFileSync, writeFileSync } from 'node:fs';
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
import { candidateLive, candidateMenuTools, minecraftV2Hooks } from '../src/surfaces/minecraft/minecraftLlmcV2.js';

type EndScene = LlmcScene & { eyes?: Array<{ x: number; z: number; bearingDeg: number; flew: number; broke: boolean; at: number }>;
  /** The body's `state.end` of the scene (the End fight; S1's `endObservation`). */
  end?: object };
const MODELS: Record<string, string> = { haiku: 'claude-haiku-5-5', sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5' };
const args = process.argv.slice(2);
const flag = (name: string) => args.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const file = args.find(arg => !arg.startsWith('--'));
const dry = args.includes('--dry');
const apiKey = process.env.SHANNON_ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_API_KEY;
if (!file || (!dry && !apiKey)) {
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
    connected: true, state: { world: scene.world as never, ...(scene.end ? { end: scene.end } : {}) }, facts: { alive: true } } as unknown as BodyObservation;
  const tree = treeOf(scene);
  const view = { revision: tree.revision, ...planPath(tree) };
  // The scene's clock is half a minute after its newest throw (the ledger does not read a throw older than 45 minutes).
  const sceneNow = Math.max(0, ...(scene.eyes ?? []).map(item => item.at)) + 30_000;
  const throws = (scene.eyes ?? []).map((item, index) => ({ id: `scene${index}`, toX: item.x, toZ: item.z, ...item }));
  const endgame = endgameModule?.createEndgame({ minecraftEyes: { v: 1, throws } }, () => sceneNow);
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
}

async function replay(): Promise<void> {
  const names = (flag('models') ?? 'sonnet').split(',').map(name => MODELS[name.trim()] ?? name.trim());
  const repeat = Math.max(1, Number(flag('repeat') ?? 1));
  const cap = Number(flag('cap') ?? Infinity);
  const out = flag('out');
  let spent = Number(flag('spent') ?? 0);
  const answers: unknown[] = [];
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
          const hands = ((prepared?.input as { hands?: ActHand[] } | undefined)?.hands ?? []).map(hand => String(hand.do));
          answers.push({ model: name, round, scene: scene.name, ms: Math.round(performance.now() - began), calls, hands, costUsd: cost, expect: scene.expect });
          console.log(`${scene.name}\t${name}\tr${round}\t${Math.round(performance.now() - began)}ms\thands=${hands.join(',') || '-'}\t$${cost.toFixed(4)}\t${JSON.stringify(calls)}`);
        } catch (error) {
          console.log(`${scene.name}\t${name}\tr${round}\terror ${String(error)}`);
        }
        if (out) writeFileSync(out, JSON.stringify(answers, null, 1));
      }
    }
  }
  console.log(`TOTAL spent (with --spent) $${spent.toFixed(4)}`);
}

if (dry) for (const scene of scenes) show(scene);
else await replay();
