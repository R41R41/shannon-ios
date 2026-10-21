import { planFromSeeds, planPath, readPlanTree, type PlanSeed, type PlanTree } from '@shannon/mind';
import type { FcaModel, FcaModelInput, FcaModelOutput, FcaToolDefinition } from '../../mind/action/fca/fcaPorts.js';
import { PLAN_UPDATE_DEFINITION } from '../../mind/action/fca/fcaPlanTools.js';
import type { BodyObservation } from '../../contracts/bodyControlContract.js';
import {
  ACT_DESCRIPTION, ACT_INPUT_SCHEMA, MC_ACT_TOOL, MC_VIEW_TOOL, VIEW_DESCRIPTION, VIEW_INPUT_SCHEMA, type ActHand,
} from '../../contracts/minecraftActContract.js';
import { createFoodTrend, minecraftLlmcLive } from './minecraftLlmcLive.js';
import { seedPlan } from './minecraftFirstPlan.js';
import { llmcInputProblem } from './minecraftLlmc.js';

/**
 * The scene replay (design mb-llm-centric 4, "確かめ方 1"; owner 2026-10-21: the main model is chosen after Haiku, Sonnet and Opus solve
 * the same scenes): one decision of the mode, asked of any decision model on a frozen scene (a frame of the world with its map, the plan,
 * what happened just before), exactly as a live decision is built (the same tools, instructions, live state), and its answer as data:
 * the calls, the hands, whether the input is one the body takes, how long it took. Nothing reaches a body. `scripts/minecraft-llmc-scene.ts`
 * runs a scene file against the models named on its command line.
 */
export interface LlmcScene {
  name: string;
  goal: string;
  /** The frame's `state.world` (with `localMap`, `mapLandmarks`, `recentStops`, `inventory`, `nearbyThreats`, …). */
  world: Record<string, unknown>;
  /** The plan: a stored tree, or seeds (a tree is made of them), or absent (the goal's seed). `current` names the node now. */
  plan?: PlanTree | readonly PlanSeed[];
  current?: string;
  /** What happened just before (the last act's lines, an event), as the live state's events. */
  events?: readonly string[];
  elapsedMinutes?: number;
  /** What a right answer does, for the reader of the report (not checked here). */
  expect?: string;
}
export interface LlmcSceneAnswer {
  scene: string; ms: number;
  calls: ReadonlyArray<{ name: string; input: unknown }>;
  /** The hands of the act, as `do` names, and why the head would refuse it (null: the body would get it). */
  hands: readonly string[]; problem: string | null;
  decision: FcaModelOutput['decision']['kind'];
}

const tool = (name: string, description: string, schema: Record<string, unknown>, effect: 'read' | 'write'): FcaToolDefinition => ({
  name, description, input: { type: 'object', properties: {}, required: [], additionalProperties: false }, nativeInputSchema: schema,
  domain: 'minecraft_body', effect, cost: 'none', audiences: ['owner_alone'], surfaces: ['text'] });
/** The menu of a decision of the mode (its body tools in the head's words, and plan.update). */
export const SCENE_TOOLS: readonly FcaToolDefinition[] = [tool(MC_ACT_TOOL, ACT_DESCRIPTION, ACT_INPUT_SCHEMA, 'write'),
  tool(MC_VIEW_TOOL, VIEW_DESCRIPTION, VIEW_INPUT_SCHEMA, 'read'), PLAN_UPDATE_DEFINITION];

function sceneTree(scene: LlmcScene): PlanTree | null {
  const given = Array.isArray(scene.plan) ? planFromSeeds(scene.plan as readonly PlanSeed[]) : scene.plan ? readPlanTree(scene.plan) : seedPlan(scene.goal);
  if (!given || !scene.current) return given;
  return given.nodes.some(node => node.id === scene.current) ? { ...given, current: scene.current } : given;
}

/** The decision input of a scene, as a live decision of the mode is built (transient: the core tools, the live body, the plan's path). */
export function sceneInput(scene: LlmcScene): FcaModelInput {
  const observation: BodyObservation = { schemaVersion: 1, bodyId: 'minecraft:scene', sequence: 1, stateAt: new Date(0).toISOString(),
    receivedAt: new Date(0).toISOString(), connected: true, state: { world: scene.world as never }, facts: { alive: true } };
  const tree = sceneTree(scene);
  return { task: { id: `scene-${scene.name}`, title: scene.goal, goal: scene.goal, completionCriteria: '依頼の達成を新しい観測で確かめる' },
    messages: [], children: [], history: [], tools: SCENE_TOOLS, coreTools: SCENE_TOOLS,
    catalog: SCENE_TOOLS.map(item => ({ name: item.name, description: item.description })),
    transient: minecraftLlmcLive({ observation, elapsedMinutes: scene.elapsedMinutes ?? null, trend: createFoodTrend(), events: scene.events ?? [] }),
    ...(tree ? { plan: { revision: tree.revision, ...planPath(tree) } } : {}) };
}

/** One decision of a model on a scene. */
export async function sceneDecision(scene: LlmcScene, model: FcaModel, signal = new AbortController().signal): Promise<LlmcSceneAnswer> {
  const began = performance.now();
  const output = await model.decide(sceneInput(scene), signal);
  const ms = Math.round(performance.now() - began);
  const calls = output.decision.kind === 'tools' ? output.decision.calls.map(call => ({ name: call.name, input: call.input })) : [];
  const act = calls.find(call => call.name === MC_ACT_TOOL);
  const hands = act ? ((act.input as { hands?: ActHand[] }).hands ?? []).map(hand => String(hand?.do)) : [];
  return { scene: scene.name, ms, calls, hands, problem: act ? llmcInputProblem(MC_ACT_TOOL, act.input) : null, decision: output.decision.kind };
}
