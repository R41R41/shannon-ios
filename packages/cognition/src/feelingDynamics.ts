import { EMPTY_APPRAISAL_CONTEXT, appraise, nextAppraisalContext, type AppraisalContext, type AppraisalMeaning } from './appraisal.js';
import { createComposure, registerOfLevel, stepComposure, type ComposureState } from './composure.js';
import { coreAffectLabel, createCoreAffect, stepCoreAffect, type CoreAffectLabel, type CoreAffectState } from './coreAffect.js';
import { belongsTo } from './episodeLedger.js';
import type { FeelingAudience, FeelingEvent, FeelingRegister } from './feelingEvent.js';

/**
 * The fast layer folded from her day's feeling events (Syzygy ADR-0013 stage 2, items 1, 2 and 7). Pure, and a fold: forgetting an
 * event's source and folding again is the whole of the forget semantics, as for the ledger. Each event of the key is appraised in the
 * context of the ones before it, moves core affect, mood and blame, and moves the composure reserve and its register.
 */
export interface FeelingPoint {
  at: string;
  kind: FeelingEvent['kind'];
  valence: number;
  arousal: number;
  dominance: number;
  mood: number;
  blame: number;
  composure: number;
  level: number;
  register: FeelingRegister;
  label: CoreAffectLabel;
  slip: boolean;
  coverUp: boolean;
}

export interface FeelingDynamics {
  core: CoreAffectState;
  composure: ComposureState;
  context: AppraisalContext;
  /** One point per event, oldest first (the Observer's graph of composure and register). */
  series: readonly FeelingPoint[];
}

const round = (value: number) => Math.round(value * 1000) / 1000;

function pointOf(event: FeelingEvent, core: CoreAffectState, composure: ComposureState, step: { slip: boolean; coverUp: boolean }): FeelingPoint {
  return {
    at: event.occurredAt, kind: event.kind, valence: round(core.pad.valence), arousal: round(core.pad.arousal), dominance: round(core.pad.dominance),
    mood: round(core.mood.valence), blame: round(core.blame), composure: round(composure.composure), level: composure.level,
    register: registerOfLevel(composure.level), label: coreAffectLabel(core), slip: step.slip, coverUp: step.coverUp,
  };
}

/** Folds the events of one key (person or scene, and audience) in time order. `meaning` may add the chooser's reading per event id. */
export function foldFeelingDynamics(events: readonly FeelingEvent[], key: { personKey: string; audience: FeelingAudience; sceneId: string | null },
  meaning: Readonly<Record<string, AppraisalMeaning>> = {}): FeelingDynamics {
  // A scene (a stream, a call) holds the events of everyone in it; each person stays the source of their own provocations.
  const scene = key.sceneId !== null && key.personKey.startsWith('scene:');
  const inScene = (event: FeelingEvent) => scene && event.sceneId === key.sceneId && event.audience === key.audience;
  const mine = events.filter(event => belongsTo(event, key) || inScene(event)).sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt));
  let core = createCoreAffect();
  let composure = createComposure(key.audience);
  let context = EMPTY_APPRAISAL_CONTEXT;
  const series: FeelingPoint[] = [];
  for (const event of mine) {
    const at = Date.parse(event.occurredAt);
    const appraisal = appraise(event, context, meaning[event.id] ?? {});
    core = stepCoreAffect(core, appraisal, at);
    const step = stepComposure(composure, appraisal, event.personKey, key.audience, at);
    composure = step.state;
    context = nextAppraisalContext(context, event, appraisal);
    series.push(pointOf(event, core, composure, step));
  }
  return { core, composure, context, series };
}
