import type { Appraisal } from './appraisal.js';
import type { FeelingAudience, FeelingRegister } from './feelingEvent.js';

/**
 * Her composure reserve and the register it holds (Syzygy ADR-0013 D16, §4.8, stage 2 item 7). Pure.
 *
 * The register she shows in front of an audience (demure on a stream) is a front she chooses; the strength to keep it is a reserve,
 * kept per key (person or scene, and audience). Provocations deplete it, weighed by how much they provoke and by who sends them (one
 * who repeats weighs more); one source can take only so much in a window, so a single troll cannot break it at once. It recovers with
 * time, kindness and quiet, more slowly than it went. The register follows it in five steps with a gap between the thresholds going
 * down and coming back (no flicker). A step across a threshold by a sharp drop may let one raw reaction slip (a mask slip), which is
 * usually covered up after.
 *
 * Treating self-control as a resource (Baumeister et al. 1998) did not replicate cleanly (Hagger et al. 2016); here it is a modelling
 * assumption for the behaviour "the front wears thin under provocation and comes back with rest" (ADR-0006 principle 3), which agrees in
 * direction with the cost of suppressing expression (Gross 1998). Every number below is an assumption the owner tunes on the Observer's
 * graph (ADR-0013 §7 item 9).
 */
export interface ComposureState {
  /** 0..1, full at 1. */
  composure: number;
  /** 0 her ordinary register (the owner alone), 1–5 the steps of a front. */
  level: number;
  lastAt: number | null;
  /** Depletion per source in the current window (the per-source cap). */
  window: { startedAt: number; bySource: Readonly<Record<string, number>> };
  /** A slip happened on the last step and is not covered yet. */
  slipPending: boolean;
}

export const COMPOSURE_COEFFICIENTS = Object.freeze({
  /** One provocation of weight 1 takes this much. */
  depletion: 0.22,
  /** A source that repeats weighs more: × (1 + this × earlier provocations from it), up to `repeatMax`. */
  repeatWeight: 0.25,
  repeatMax: 2,
  /** One source takes at most this much in a window. */
  sourceCap: 0.35,
  windowMs: 10 * 60_000,
  /** Recovery per minute of quiet (slower than depletion: about 40 minutes from empty to full). */
  recoveryPerMinute: 0.025,
  /** A kindness gives back this much (times its relief). */
  kindness: 0.12,
  /** Thresholds of levels 1→5 going down (composure below them), and the gap before a level is left going up. */
  downAt: Object.freeze([0.8, 0.6, 0.4, 0.2]),
  hysteresis: 0.08,
  /** With the owner alone the front matters little: provocations weigh this much (her 「もう知らない」 within one talk). */
  ownerWeight: 0.35,
  /** A drop of at least this much that crosses a threshold may let one raw reaction slip. */
  slipDrop: 0.12,
});
const C = COMPOSURE_COEFFICIENTS;
export type ComposureCoefficients = {
  readonly [K in keyof typeof COMPOSURE_COEFFICIENTS]: (typeof COMPOSURE_COEFFICIENTS)[K] extends readonly number[] ? readonly number[] : number;
};

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, Number.isFinite(value) ? value : 0));

/** Full composure, and the register the audience starts with: her ordinary one alone, demure in front of others. */
export function createComposure(audience: FeelingAudience): ComposureState {
  return { composure: 1, level: audience === 'owner_alone' ? 0 : 1, lastAt: null, window: { startedAt: 0, bySource: {} }, slipPending: false };
}

/** The register of a level: 0 normal, 1 demure, 2 strained smile, 3 curt, 4 rough, 5 confront. */
export function registerOfLevel(level: number): FeelingRegister {
  return (['normal', 'demure', 'strained_smile', 'curt', 'rough', 'confront'] as const)[clamp(Math.round(level), 0, 5)]!;
}

/** The level a composure asks for from a level (going down at the thresholds, coming back only past them by the gap). */
export function levelFor(composure: number, current: number, floor: number, c: ComposureCoefficients = C): number {
  // In front of others the front starts at 1 (demure); alone her ordinary register is 0 and a worn reserve goes straight to 2.
  const step = (below: number) => (below === 0 ? floor : below + 1);
  const down = step(c.downAt.filter(threshold => composure < threshold).length);
  // Coming back, a step is left only once composure is past its threshold by the gap (the gap was applied the wrong way: the level
  // could leave a step early and then fall back into it while composure rose).
  const up = step(c.downAt.filter(threshold => composure < threshold + c.hysteresis).length);
  const asked = down > current ? down : Math.min(current, up);
  return Math.max(floor, Math.min(5, asked));
}

function recovered(state: ComposureState, at: number, c: ComposureCoefficients): ComposureState {
  if (state.lastAt === null || !(at > state.lastAt)) return { ...state, lastAt: state.lastAt ?? at };
  const minutes = (at - state.lastAt) / 60_000;
  const window = at - state.window.startedAt > c.windowMs ? { startedAt: at, bySource: {} } : state.window;
  return { ...state, composure: clamp(state.composure + c.recoveryPerMinute * minutes, 0, 1), lastAt: at, window };
}

/** The reserve at an instant after its last event: quiet gives back, and the register follows with its gap (stage 5). */
export function composureAt(state: ComposureState, at: number, audience: FeelingAudience, c: ComposureCoefficients = C): ComposureState {
  const base = recovered(state, at, c);
  const floor = audience === 'owner_alone' ? 0 : 1;
  return { ...base, level: levelFor(base.composure, Math.max(base.level, floor), floor, c) };
}

export interface ComposureStep {
  state: ComposureState;
  /** A raw reaction slipped through on this step (the feeling turn may reach for 舌打ち, then a cover-up). */
  slip: boolean;
  /** The last step slipped: this one is the cover-up. */
  coverUp: boolean;
}

/** One event from one source in front of one audience. */
export function stepComposure(state: ComposureState, appraisal: Appraisal, source: string, audience: FeelingAudience, at: number,
  c: ComposureCoefficients = C): ComposureStep {
  const base = recovered(state, at, c);
  const floor = audience === 'owner_alone' ? 0 : 1;
  const coverUp = base.slipPending;
  const earlier = base.window.bySource[source] ?? 0;
  const repeat = 1 + Math.min(c.repeatMax, c.repeatWeight * Math.round(earlier / Math.max(0.01, c.depletion)));
  const weight = audience === 'owner_alone' ? c.ownerWeight : 1;
  const wanted = c.depletion * appraisal.provocation * repeat * weight;
  const taken = clamp(Math.min(wanted, c.sourceCap - earlier), 0, 1);
  const kindness = appraisal.relief > 0 && appraisal.goodness > 0 ? c.kindness * appraisal.relief * 4 : 0;
  const composure = clamp(base.composure - taken + kindness, 0, 1);
  const level = levelFor(composure, Math.max(base.level, floor), floor, c);
  const crossed = level > Math.max(base.level, floor);
  const slip = crossed && taken >= c.slipDrop && level >= 3;
  return {
    state: { composure, level, lastAt: at, window: { startedAt: base.window.startedAt || at, bySource: { ...base.window.bySource, [source]: earlier + taken } },
      slipPending: slip },
    slip, coverUp,
  };
}
