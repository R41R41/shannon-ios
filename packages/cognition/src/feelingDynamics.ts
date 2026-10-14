import { EMPTY_APPRAISAL_CONTEXT, appraise, nextAppraisalContext, type Appraisal, type AppraisalContext, type AppraisalMeaning } from './appraisal.js';
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

/**
 * The per-source influence cap (ADR-0013 §4.3, stage 4): in a scene, one source moves her fast layer with at most `events` hurtful
 * events in `windowMs`; past it, its events are still recorded but felt as nothing new (a flood or a copy-paste is one thing, and one
 * person cannot swing the whole scene). A crowd is one source. Approved by the owner as proposed (2026-10-15); the composure reserve keeps its own cap.
 */
export const SOURCE_INFLUENCE_PARAMETERS = Object.freeze({ events: 3, windowMs: 10 * 60_000 });

function capped(appraisal: Appraisal, recent: number[], at: number): Appraisal {
  const hurt = appraisal.goodness < 0 || appraisal.provocation > 0 || appraisal.violation;
  if (!hurt) return appraisal;
  const within = recent.filter(time => at - time < SOURCE_INFLUENCE_PARAMETERS.windowMs);
  recent.splice(0, recent.length, ...within, at);
  if (within.length < SOURCE_INFLUENCE_PARAMETERS.events) return appraisal;
  return { ...appraisal, goodness: 0, provocation: 0, violation: false, unexpected: 0 };
}

function pointOf(event: FeelingEvent, core: CoreAffectState, composure: ComposureState, step: { slip: boolean; coverUp: boolean }): FeelingPoint {
  return {
    at: event.occurredAt, kind: event.kind, valence: round(core.pad.valence), arousal: round(core.pad.arousal), dominance: round(core.pad.dominance),
    mood: round(core.mood.valence), blame: round(core.blame), composure: round(composure.composure), level: composure.level,
    register: registerOfLevel(composure.level), label: coreAffectLabel(core), slip: step.slip, coverUp: step.coverUp,
  };
}

/** Folds the events of one key (person or scene, and audience) in time order. `meaning` may add the chooser's reading per event id. */
export function foldFeelingDynamics(events: readonly FeelingEvent[], key: { personKey: string; audience: FeelingAudience; sceneId: string | null },
  meaning: Readonly<Record<string, AppraisalMeaning>> = {}, options: { sourceCap?: boolean } = {}): FeelingDynamics {
  // A scene (a stream, a call) holds the events of everyone in it; each person stays the source of their own provocations.
  const scene = key.sceneId !== null && key.personKey.startsWith('scene:');
  const inScene = (event: FeelingEvent) => scene && event.sceneId === key.sceneId && event.audience === key.audience;
  const mine = events.filter(event => belongsTo(event, key) || inScene(event)).sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt));
  let core = createCoreAffect();
  let composure = createComposure(key.audience);
  let context = EMPTY_APPRAISAL_CONTEXT;
  const series: FeelingPoint[] = [];
  const sources = new Map<string, number[]>();
  for (const event of mine) {
    const at = Date.parse(event.occurredAt);
    // The chooser's reading kept on the event (stage 2), else one handed in by id.
    const read = event.facts.meaning ? { deliberate: event.facts.meaning.deliberate, teasing: event.facts.meaning.teasing >= 0.5 } : meaning[event.id] ?? {};
    const raw = appraise(event, context, read);
    const recent = sources.get(event.personKey) ?? [];
    sources.set(event.personKey, recent);
    const appraisal = scene && options.sourceCap ? capped(raw, recent, at) : raw;
    core = stepCoreAffect(core, appraisal, at);
    const step = stepComposure(composure, appraisal, event.personKey, key.audience, at);
    composure = step.state;
    context = nextAppraisalContext(context, event, appraisal);
    series.push(pointOf(event, core, composure, step));
  }
  return { core, composure, context, series };
}
