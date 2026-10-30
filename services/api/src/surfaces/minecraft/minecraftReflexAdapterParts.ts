import { type SkillGistsPort } from './minecraftSkillPointers.js';
import { createHash } from 'node:crypto';
import type { TaskRuntime, TaskStep } from '../../mind/action/taskRuntime/taskRuntimePorts.js';
import type { FcaEvidence } from '../../mind/action/fca/fcaEvidencePorts.js';
import { type ToolResult } from '../../mind/tools/toolRegistryPorts.js';
import { type ReflexEntrySelector, type ReflexLimits, type ReflexSelector } from '../../mind/action/reflex/reflexPorts.js';
import { type ReflexGovernor } from '../../mind/action/reflex/reflexGovernor.js';
import type { BodyObservation, BodyPlanView } from '../../contracts/bodyControlContract.js';
import { type MinecraftControl } from './minecraftControl.js';

export interface MinecraftTaskBodyParts {
  control: MinecraftControl;
  runtime: TaskRuntime;
  step: TaskStep;
  entry: ReflexEntrySelector | null;
  selector: ReflexSelector | null;
  ownerAlone(): boolean;
  sourcesVisible(): boolean;
  now?: () => number;
  pollMilliseconds?: number;
  gameplayAllowed?(): boolean;
  limits?: Partial<ReflexLimits>;
  evidence?: FcaEvidence;
  /** How long after a body's login, reconnection or respawn no reflex starts on its own (`MinecraftControl.settling`). */
  spawnGraceMilliseconds?: number;
  /** The skills she can open with `skill.read` now (`minecraftSkillPointers`); none when absent. */
  skillNames?(): ReadonlySet<string>;
  /** With `SHANNON_FCA_SKILL_GIST`: the gists of pointed skills (`fcaSkillGists.ts`); pointers alone when absent. */
  skillGists?: SkillGistsPort;
  /** A pointed skill whose shown gist this decision followed (a body tool it names, not read-only): a use of kind `gist`. */
  gistFollowed?(name: string): void;
  /** The task's automatic reflex entries across its steps (`reflexGovernor.ts`); one for this step alone when absent. */
  governor?: ReflexGovernor;
  /** Syzygy ADR-0011 stage 2 (`SHANNON_MINECRAFT_FAST_JUDGMENT`): danger is judged without an image
   * (`minecraftFastJudgment.ts`). */
  fastJudgment?: boolean;
  /** The strong model's route plan (`minecraftRouteWiring.ts`, `SHANNON_MINECRAFT_ROUTE_PLAN`): the answer's JSON,
   * or a throw; none when absent. */
  routePlanner?(system: string, input: string, signal: AbortSignal): Promise<unknown>;
  log?(line: string): void;
  /** Where the content-free measurement lines (`minecraftTaskMetrics`: milestones, stage, adoption, gaps) go; the
   * journal when absent. */
  metricsLog?(line: string): void;
  /**
   * the LLM-centric mode (design mb-llm-centric): a reflex session's context carries the plan. The live state and the recall's
   * events are the wrapper's (`withLlmcBody`, `minecraftLlmcBody.ts`). Absent: as before.
   */
  llmc?: { plan(): BodyPlanView | undefined };
  /** The task queue's open items (the command ids the step itself still waits for): not an unsettled operation for the guard
   * (`MinecraftControlStore.safe`). */
  openIds?(): ReadonlySet<string>;
}

export const hash = (value: string) => createHash('sha256').update(value).digest('hex');

export const toolOk = (text: string): ToolResult => ({ ok: true, text, retryable: false });

export const EMPTY = { type: 'object' as const, properties: {}, required: [], additionalProperties: false as const };

export const DEFAULT_LIMITS: ReflexLimits = {
  maxDurationMs: 20_000,
  maxDecisions: 6,
  maxActions: 4,
  maxActionMs: 5_000,
  maxStateAgeMs: 3_000,
  maxImageAgeMs: 3_000,
};

/** Frames in a row that must show concrete danger before a reflex starts on its own ahead of the task's first decision. */
export const REFLEX_DANGER_FRAMES = 2;

/**
 * The concrete evidence behind a body's `danger` fact (Minebot: health at most 8, oxygen at most 6, or a hostile within 5 blocks
 * that can reach it), read from the frame's world state; null when the frame shows none of it. Minecraft run 6 (2026-10-14): the
 * flag was true at spawn into a fresh world, before health had arrived (an unknown health reads as 0 there), and a reflex started
 * ahead of the task's first decision.
 */
export function concreteDanger(observation: BodyObservation): { kind: 'health' | 'oxygen' | 'threat'; value: number } | null {
  const world = observation.state.world as { health?: unknown; oxygen?: unknown; nearbyThreats?: unknown } | undefined;
  if (observation.facts.alive !== true || !world || typeof world !== 'object') return null;
  const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
  if (finite(world.health) && world.health > 0 && world.health <= 8) return { kind: 'health', value: world.health };
  if (finite(world.oxygen) && world.oxygen >= 0 && world.oxygen <= 6) return { kind: 'oxygen', value: world.oxygen };
  const threats = Array.isArray(world.nearbyThreats) ? (world.nearbyThreats as Array<{ distance?: unknown; canReachMe?: unknown }>) : [];
  const near = threats
    .filter((threat) => finite(threat?.distance) && threat.distance <= 5 && threat.canReachMe !== false)
    .map((threat) => threat.distance as number);
  return near.length ? { kind: 'threat', value: Math.min(...near) } : null;
}
