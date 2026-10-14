import { SHANNON_AFFECT_DYNAMICS, stationaryBand } from './affectDynamics.js';
import type { Appraisal } from './appraisal.js';

/**
 * Her core affect and mood, from appraisals (Syzygy ADR-0013 D3, stage 2 item 2). Pure; built on ADR-0006's dynamics.
 *
 * - Core affect is pleasure, arousal and dominance (PAD: Mehrabian & Russell 1974). Between events each returns toward where it rests
 *   (the Ornstein–Uhlenbeck return of ADR-0006 2.1, θ and the attractor of `SHANNON_AFFECT_DYNAMICS`; dominance has no published
 *   dynamics and takes the same form: a modelling assumption). At an event it moves the share 1 − γ toward a bounded target
 *   (ADR-0006 stage 2's candidate B), so it never sticks to an edge.
 * - Surprise habituates: the arousal of a startle is scaled by how unexpected the event is, which falls with each repeat of the same
 *   thing (`appraisal.unexpected`; ADR-0006 2.2).
 * - Blame accumulates (D3.4): a meant violation of her no adds to it faster than it fades (its half-life is long: anger carried over,
 *   Zillmann 1971; rumination keeps it, Bushman et al. 2005), so the third time is felt more than the first, from the build-up and not
 *   from a table. An apology or a kindness relieves it as much as it was unexpected (prediction error, ADR-0006 2.4).
 * - Mood is the slow layer (ALMA: Gebhard 2005): it follows core affect at a slow rate and colours where it rests.
 *
 * The coefficients are modelling assumptions (ADR-0013 D14) unless `SHANNON_AFFECT_DYNAMICS` gives them; they are fitted later.
 */
export interface Pad { valence: number; arousal: number; dominance: number }

export interface CoreAffectState {
  pad: Pad;
  mood: Pad;
  /** Accumulated blame toward the key's person, 0..1. */
  blame: number;
  lastAt: number | null;
}

export const CORE_AFFECT_COEFFICIENTS = Object.freeze({
  /** γ of ADR-0006 stage 2 (Rutledge et al. 2014): the share an event leaves of where she was. */
  forgetting: SHANNON_AFFECT_DYNAMICS.eventForgetting,
  theta: SHANNON_AFFECT_DYNAMICS.theta,
  /** Blame fades with this half-life on the clock (model assumption: anger outlasts the startle by hours, not minutes). */
  blameHalfLifeMs: 6 * 60 * 60_000,
  /** How much one meant violation adds (of what is left to 1), before its provocation. Model assumption. */
  blameGain: 0.5,
  /** The slow layer's share per event (ALMA's mood follows emotion slowly; the current moodColour is 0.3). */
  moodRate: 0.15,
  /** No target goes past this, so no value sticks at the edge of the scale. */
  edge: 0.9,
  restingDominance: 0.5,
});
const K = CORE_AFFECT_COEFFICIENTS;
const REST = SHANNON_AFFECT_DYNAMICS.attractor;

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, Number.isFinite(value) ? value : 0));

export function createCoreAffect(): CoreAffectState {
  const pad = { valence: REST.valence, arousal: REST.arousal, dominance: K.restingDominance };
  return { pad, mood: { ...pad }, blame: 0, lastAt: null };
}

/** Where she rests, coloured by her mood (ADR-0006 2.3: the attractor moves with mood). */
function resting(mood: Pad): Pad {
  return { valence: clamp(REST.valence + 0.5 * (mood.valence - REST.valence), -K.edge, K.edge), arousal: REST.arousal, dominance: K.restingDominance };
}

/** The return between events: core affect toward where she rests, blame by its half-life. */
export function advanceCoreAffect(state: CoreAffectState, at: number): CoreAffectState {
  if (state.lastAt === null || !(at > state.lastAt)) return { ...state, lastAt: state.lastAt ?? at };
  const gap = at - state.lastAt;
  const decay = Math.exp(-K.theta * gap);
  const rest = resting(state.mood);
  const back = (name: keyof Pad) => rest[name] + (state.pad[name] - rest[name]) * decay;
  return { pad: { valence: back('valence'), arousal: back('arousal'), dominance: back('dominance') }, mood: state.mood,
    blame: state.blame * 0.5 ** (gap / K.blameHalfLifeMs), lastAt: at };
}

/** One event: blame builds or is relieved, then core affect steps toward its bounded target, then mood follows slowly. */
export function stepCoreAffect(state: CoreAffectState, appraisal: Appraisal, at: number): CoreAffectState {
  const advanced = advanceCoreAffect(state, at);
  const added = appraisal.violation || appraisal.provocation > 0 ? K.blameGain * appraisal.deliberate * (0.5 + appraisal.provocation) : 0;
  const built = 1 - (1 - advanced.blame) * (1 - clamp(added, 0, 1));
  const blame = clamp(built * (1 - clamp(appraisal.relief, 0, 1)), 0, 1);
  const startle = clamp(appraisal.unexpected * Math.abs(appraisal.goodness), 0, 1);
  const rest = resting(advanced.mood);
  const target: Pad = {
    valence: clamp(rest.valence + 0.6 * appraisal.goodness - 0.5 * blame, -K.edge, K.edge),
    arousal: clamp(REST.arousal + (1 - REST.arousal) * Math.max(startle, 0.7 * blame), 0, K.edge),
    // Blame with some control is anger (dominant); a hurt she cannot answer lowers dominance.
    dominance: clamp(K.restingDominance + 0.45 * blame * (0.5 + appraisal.control) - 0.35 * Math.max(0, -appraisal.goodness) * (1 - appraisal.control),
      0.05, K.edge),
  };
  const g = K.forgetting;
  const toward = (name: keyof Pad) => g * advanced.pad[name] + (1 - g) * target[name];
  const pad = { valence: toward('valence'), arousal: toward('arousal'), dominance: toward('dominance') };
  const follow = (name: keyof Pad) => advanced.mood[name] + K.moodRate * (pad[name] - advanced.mood[name]);
  return { pad, mood: { valence: follow('valence'), arousal: follow('arousal'), dominance: follow('dominance') }, blame, lastAt: at };
}

export const CORE_AFFECT_LABELS = ['calm', 'happy', 'annoyed', 'angry', 'hurt', 'startled'] as const;
export type CoreAffectLabel = typeof CORE_AFFECT_LABELS[number];

/** A closed label of the state (for the Observer and the shadow's comparison; never told to her as a rule). */
export function coreAffectLabel(state: CoreAffectState): CoreAffectLabel {
  const { valence, arousal, dominance } = state.pad;
  if (state.blame >= 0.5 && valence < -0.15) return 'angry';
  if (state.blame >= 0.15) return 'annoyed';
  if (valence < -0.25 && dominance < 0.45) return 'hurt';
  if (arousal > 0.6 && valence > -0.25 && valence < 0.25) return 'startled';
  if (valence > 0.25) return 'happy';
  return 'calm';
}

/** Settled: no blame to speak of, and core affect inside her ordinary fluctuation of where she rests. */
export function coreAffectSettled(state: CoreAffectState): boolean {
  return state.blame < 0.15 && Math.abs(state.pad.valence - resting(state.mood).valence) < stationaryBand();
}
