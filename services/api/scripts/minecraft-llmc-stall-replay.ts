// The strong model that makes the plan again when the body stands still (2026-11-02, S3), asked on saved stalls: the brief as the run builds it
// (`replanBrief`), the answer read and applied to the plan the way the plan takes it. No body, no world. Cost and seconds are printed beside the ops.
//
//   cd services/api && ANTHROPIC_API_KEY=… node --import tsx scripts/minecraft-llmc-stall-replay.ts tests/fixtures/minecraft/endgame-stalls.json
//     [--model=opus|sonnet] [--repeat=1] [--stalls=a,b] [--out=answers.json] [--cap=1.0] [--dry]
//
// `--dry` prints the briefs' sizes (no key, no call).
import { readFileSync, writeFileSync } from 'node:fs';
import { applyPlanUpdate, planFromSeeds, readPlanTree, type PlanSeed, type PlanTree } from '@shannon/mind';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import type { AnthropicFcaUsage } from '../src/infra/models/anthropic/anthropicFcaModel.js';
import { seedPlan } from '../src/surfaces/minecraft/minecraftFirstPlan.js';
import { doneFacts, doneStatusWords } from '../src/surfaces/minecraft/minecraftPlanDone.js';
import { kindOf } from '../src/surfaces/minecraft/minecraftPlanFacts.js';
import { llmcTokens } from '../src/surfaces/minecraft/minecraftLlmcLive.js';
import { stageTextsForKind } from '../src/surfaces/minecraft/minecraftLlmcV2Knowledge.js';
import { REPLAN_SYSTEM, replanOf } from '../src/surfaces/minecraft/minecraftLlmcReplan.js';
import { nowLines, replanBrief } from '../src/surfaces/minecraft/minecraftLlmcReplanBrief.js';
import { createEndgame } from '../src/surfaces/minecraft/minecraftEndgame.js';
import { configuredMinecraftLlmc } from '../src/wiring/minecraftLlmcConfiguration.js';
import { doneClaimProblem } from '../src/wiring/minecraftLlmcReplanWiring.js';

interface Stall {
  name: string; goal: string; current?: string; seconds: number; expect: string;
  stall: { kind: string; why: string; node: string | null };
  plan?: unknown; world: Record<string, unknown>; results: string[]; queue: string[]; earlier: never[]; sameNode: number;
  eyes?: Array<{ x: number; z: number; bearingDeg: number; flew: number; broke: boolean; at: number }>;
}
const MODELS: Record<string, string> = { sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5' };
const args = process.argv.slice(2);
const flag = (name: string) => args.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const file = args.find(arg => !arg.startsWith('--'));
const dry = args.includes('--dry');
const apiKey = process.env.SHANNON_ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_API_KEY;
if (!file || (!dry && !apiKey)) {
  console.error('usage: [ANTHROPIC_API_KEY=…] node --import tsx scripts/minecraft-llmc-stall-replay.ts <stalls.json> [--model=opus] [--repeat=1] [--dry]');
  process.exit(2);
}
const only = flag('stalls')?.split(',').map(name => name.trim());
const stalls = (JSON.parse(readFileSync(file, 'utf8')) as Stall[]).filter(item => !only || only.includes(item.name));

function treeOf(item: Stall): PlanTree {
  const given = Array.isArray(item.plan) ? planFromSeeds(item.plan as readonly PlanSeed[]) : item.plan ? readPlanTree(item.plan) : seedPlan(item.goal);
  if (!given) throw new Error(`stall ${item.name}: no plan`);
  return item.current && given.nodes.some(node => node.id === item.current) ? { ...given, current: item.current } : given;
}

function briefOf(item: Stall): { brief: string; tree: PlanTree; observation: BodyObservation } {
  const observation = { schemaVersion: 1, bodyId: 'minecraft:scene', sequence: 1, stateAt: new Date(0).toISOString(), receivedAt: new Date(0).toISOString(),
    connected: true, state: { world: item.world as never }, facts: { alive: true } } as unknown as BodyObservation;
  const tree = treeOf(item);
  const node = tree.nodes.find(candidate => candidate.id === item.stall.node);
  const facts = doneFacts(observation);
  const sceneNow = Math.max(0, ...(item.eyes ?? []).map(eye => eye.at)) + 30_000;
  const throws = (item.eyes ?? []).map((eye, index) => ({ id: `stall${index}`, toX: eye.x, toZ: eye.z, ...eye }));
  const endgame = createEndgame({ minecraftEyes: { v: 1, throws } }, () => sceneNow).lines(observation, true).lines;
  const brief = replanBrief({ goal: item.goal, seconds: item.seconds, stall: item.stall, tree, doneStatus: node ? doneStatusWords(node.doneWhen, facts, node.target) : null,
    now: nowLines(observation), facts: endgame, results: item.results, queue: item.queue, earlier: item.earlier, sameNode: item.sameNode,
    knowledge: stageTextsForKind(node ? kindOf(node) : 'other', facts?.dimension ?? 'overworld') });
  return { brief, tree, observation };
}

async function replay(): Promise<void> {
  const name = MODELS[flag('model') ?? 'opus'] ?? flag('model')!;
  const repeat = Math.max(1, Number(flag('repeat') ?? 1));
  const cap = Number(flag('cap') ?? Infinity);
  const usage: AnthropicFcaUsage[] = [];
  const llmc = configuredMinecraftLlmc({ SHANNON_ANTHROPIC_API_KEY: apiKey!, SHANNON_MINECRAFT_LLMC_PLAN_MODEL: name },
    { recordUsage: value => { usage.push(value); } }, { log: () => undefined });
  if (!llmc?.replanner) throw new Error('no replanner');
  const answers: unknown[] = [];
  let spent = 0, valid = 0, asked = 0, ms = 0;
  for (const item of stalls) {
    for (let round = 0; round < repeat; round += 1) {
      if (spent > cap) { console.log(`STOP: spent $${spent.toFixed(3)} > cap $${cap}`); return; }
      const { brief, tree, observation } = briefOf(item);
      const before = usage.length, began = performance.now();
      try {
        const reply = await llmc.replanner(REPLAN_SYSTEM, brief, new AbortController().signal);
        const took = Math.round(performance.now() - began);
        const cost = usage.slice(before).reduce((sum, entry) => sum + entry.estimatedCostUsd, 0);
        const made = replanOf(reply);
        const result = made && (made.update.ops?.length || made.update.current) ? applyPlanUpdate(tree, made.update, { at: new Date(0).toISOString() }) : null;
        const claim = result?.changed ? doneClaimProblem(tree, result.tree, observation) : null;
        const problem = !made ? 'unreadable' : result?.problem ?? claim ?? null;
        asked += 1; ms += took; spent += cost; valid += made && !problem ? 1 : 0;
        answers.push({ stall: item.name, model: name, round, ms: took, costUsd: cost, problem, reply, expect: item.expect });
        console.log(`${item.name}\t${name}\tr${round}\t${took}ms\t$${cost.toFixed(4)}\t${problem ? `PROBLEM(${problem})` : 'ok'}\tops=${made?.update.ops?.length ?? 0}\t${JSON.stringify(reply)}`);
      } catch (error) {
        console.log(`${item.name}\t${name}\tr${round}\terror ${String(error)}`);
      }
      if (flag('out')) writeFileSync(flag('out')!, JSON.stringify(answers, null, 1));
    }
  }
  console.log(`SUMMARY ${name}: ${valid}/${asked} readable and takable by the plan, ${asked ? Math.round(ms / asked) : 0} ms an answer, $${asked ? (spent / asked).toFixed(4) : '0'} an answer`);
}

if (dry) for (const item of stalls) console.log(`## ${item.name}  briefTokens=${llmcTokens(briefOf(item).brief)}`);
else await replay();
