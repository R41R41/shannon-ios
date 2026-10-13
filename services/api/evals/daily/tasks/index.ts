import type { DailyEvalTask, EvalSet } from '../types.js';
import A1 from './regression/A1.js';
import D1 from './regression/D1.js';
import D2 from './regression/D2.js';
import D3 from './regression/D3.js';
import E1 from './regression/E1.js';
import E2 from './regression/E2.js';
import E3 from './regression/E3.js';
import M1 from './regression/M1.js';
import M3 from './regression/M3.js';
import M4 from './regression/M4.js';
import R1 from './regression/R1.js';
import R3 from './regression/R3.js';
import R4 from './regression/R4.js';
import R5 from './regression/R5.js';
import V1 from './regression/V1.js';
import V3 from './regression/V3.js';

/** Every task, in the spec's order. A new task file is added here (the definition test fails on an unlisted file). */
export const ALL_TASKS: readonly DailyEvalTask[] = Object.freeze([E1, E2, E3, R1, R3, R4, R5, D1, D2, D3, M1, M3, M4, V1, V3, A1]);

/**
 * Spec tasks of the regression slice that are not implemented, and why (the README repeats this).
 */
export const DROPPED_TASKS: Readonly<Record<string, string>> = Object.freeze({
  A3: 'Minecraft (「エンドラ討伐して」) needs her Minecraft body: the lifecycle, the native control queue and attack/death evidence. '
    + 'The sandbox has no Minebot actuator yet, so the request tools are not offered and the task would only test a refusal.',
});

export function tasksOf(set: EvalSet, ids?: readonly string[]): DailyEvalTask[] {
  const wanted = ids?.length ? new Set(ids.map(id => id.toUpperCase())) : null;
  return ALL_TASKS.filter(task => task.set === set && (!wanted || wanted.has(task.id)));
}
