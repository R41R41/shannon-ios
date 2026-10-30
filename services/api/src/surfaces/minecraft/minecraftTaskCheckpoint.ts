import type { MinecraftTaskBodyParts } from './minecraftReflexAdapterParts.js';
import { bedSearchMemory, createRoutePlanning, milestoneFollowMemory } from './minecraftSkillPointers.js';
import { createPaceLedger } from './minecraftPaceLedger.js';
import { minecraftMilestones } from './minecraftPace.js';

export function createMinecraftCheckpoint(parts: MinecraftTaskBodyParts, now: () => number, log: (line: string) => void) {
  const { step } = parts;

  const prior = step.snapshot.checkpoint as {
    fcaToolSelection?: { recentResults?: Array<{ name: string; ok: boolean; summary: string }> };
  } | null;

  let recentResults = (prior?.fcaToolSelection?.recentResults ?? [])
    .slice(-6)
    .map((value) => ({ name: value.name.slice(0, 160), ok: value.ok, summary: value.summary.slice(0, 1000) }));

  // The latest milestones, kept in the task's checkpoint across steps (`minecraftMilestones` key, through this
  // port's `checkpoint`).
  const kept = (step.snapshot.checkpoint as { minecraftMilestones?: unknown } | null)?.minecraftMilestones;

  let milestones = minecraftMilestones({ milestones: kept });

  // Her idle waits in this task, kept in the checkpoint as the milestones are (`minecraftIdleWaitMs`).
  const keptWait = Number((step.snapshot.checkpoint as { minecraftIdleWaitMs?: unknown } | null)?.minecraftIdleWaitMs ?? 0);

  let idleWaitMs = Number.isSafeInteger(keptWait) && keptWait > 0 ? keptWait : 0,
    pendingWaitMs = 0;

  // Her sheep search that found none, kept in the checkpoint for the rest of that day (`minecraftNoSheepDarkIn`,
  // `bedSearchMemory`).
  const marks = step.snapshot.checkpoint as {
      minecraftNoSheepDarkIn?: unknown;
      minecraftVillageSearched?: unknown;
      minecraftRoute?: unknown;
      minecraftRouteAsks?: unknown;
    } | null,
    bedSearch = bedSearchMemory(marks?.minecraftNoSheepDarkIn, marks?.minecraftVillageSearched),
    // Daytime decisions in a row that went elsewhere than the step now (`minecraftMilestoneFollow.ts`), kept as the marks are.
    follow = milestoneFollowMemory(
      (step.snapshot.checkpoint as { minecraftMilestoneDrift?: unknown } | null)?.minecraftMilestoneDrift,
      (decisions) => log(`Shannon Minecraft milestone steps task=${step.taskId} decisions=${decisions}`),
    ),
    // Her route to the Nether, planned by a strong model at the task's start and when a step is late (`minecraftRoutePlanner.ts`).
    routePlan = createRoutePlanning({
      kept: marks?.minecraftRoute,
      keptAsks: marks?.minecraftRouteAsks,
      planner: parts.routePlanner,
      log: (line) => log(line),
      taskId: step.taskId,
    });

  // A transient decision's pace beyond `minecraftPace` (`minecraftPaceLedger.ts`), kept in the checkpoint as the
  // above are, and its body state.
  const paceLedger = createPaceLedger({
    kept: (step.snapshot.checkpoint as { minecraftPaceLedger?: unknown } | null)?.minecraftPaceLedger,
    began: Date.parse(step.snapshot.task.createdAt),
    now,
  });
  return { prior, recentResults, kept, milestones, keptWait, idleWaitMs, pendingWaitMs, marks, bedSearch, follow, routePlan, paceLedger };
}
