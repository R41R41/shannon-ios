import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  advanceAffect, createAffectDynamics, createShannonMessageEmotion, impulseAffect,
  messageEmotionForOthers, type ShannonEmotion,
} from '@shannon/cognition';
import { QUALITY_AFFECT_SCENARIOS, judgedFacts, stableFingerprint, type ReachDriver, type ReachScenarioDefinition } from '../../../../packages/evaluation/src/reach/index.js';
import { AffectCoordinator, type FcaAffectEvidence } from '../../src/mind/emotion/affectCoordinator.js';
import { SQLiteShannonStore } from '../../src/infra/sqlite/sqliteStore.js';

const START = Date.parse('2026-10-09T00:00:00.000Z');
const SCOPE = 'synthetic-quality-owner';
type Point = { at: string; kind: string | null; intensity: number | null; current: ShannonEmotion; shadow: ShannonEmotion; receipts: number; causes: number; version: number };

class AffectWorld {
  readonly directory = mkdtempSync(join(tmpdir(), 'shannon-quality-affect-'));
  at = START;
  visible = true;
  store: SQLiteShannonStore;
  coordinator: AffectCoordinator;
  shadow = createAffectDynamics();
  readonly points: Point[] = [];
  constructor() { this.store = this.open(); this.coordinator = this.coordinate(); this.shadow.core = { ...this.coordinator.snapshot(SCOPE).emotion }; this.capture(); }
  open() { return new SQLiteShannonStore({ path: join(this.directory, 'state.sqlite'), now: () => new Date(this.at).toISOString(), predictionLedger: false, choiceLedger: false, predictionShadow: false }); }
  coordinate() { return new AffectCoordinator(this.store, () => this.visible); }
  evidence(id: string, value: number, expected = 0.2, taskId = 'minecraft-task'): FcaAffectEvidence {
    return { eventId: id, taskId, revision: 1, observedAt: new Date(this.at).toISOString(), value,
      expectedValue: expected, unexpected: Math.min(1, Math.abs(value - expected)),
      cause: 'Synthetic observed outcome', target: 'synthetic-task', sources: [] };
  }
  event(id: string, value: number, expected = 0.2, taskId = 'minecraft-task') {
    const evidence = this.evidence(id, value, expected, taskId);
    const result = this.coordinator.submit(SCOPE, evidence);
    if (result === 'applied') {
      this.shadow = advanceAffect(this.shadow, this.at, id);
      this.shadow = impulseAffect(this.shadow, { key: taskId, error: value - expected, expectation: expected,
        chosen: true, learningRate: 0.5, unexpected: evidence.unexpected ?? 0 }).state;
    }
    this.capture(); this.at += 60_000;
    return result;
  }
  capture() {
    const shared = this.coordinator.snapshot(SCOPE);
    this.points.push({ at: new Date(this.at).toISOString(), kind: shared.feeling?.primary ?? null, intensity: shared.feeling?.intensity ?? null, current: { ...shared.emotion }, shadow: { ...this.shadow.core }, receipts: this.store.fcaAffectReceipts(SCOPE).length,
      causes: shared.causes.length, version: shared.revision });
  }
  restart() { this.store.close(); this.store = this.open(); this.coordinator = this.coordinate(); }
  close() { this.store.close(); rmSync(this.directory, { recursive: true, force: true }); }
}

function history(definition: ReachScenarioDefinition) {
  const world = new AffectWorld(); let condition = false;
  try {
    switch (definition.id) {
      case 'quality.affect.failure-success': {
        world.event('failure-1', -0.6); world.event('failure-2', -0.6); world.event('failure-3', -0.6);
        const before = world.points.at(-1)!.current.valence; world.event('success', 0.8);
        condition = world.points.at(-1)!.current.valence > before; break;
      }
      case 'quality.affect.cross-task-comment': {
        world.event('game-failure', -0.6); const before = world.points.at(-1)!.current.valence;
        world.event('positive-comment', 0.8, 0.1, 'comment-task');
        const rows = world.store.fcaAffectReceipts(SCOPE);
        condition = new Set(rows.map(row => row.taskId)).size === 2 && world.points.at(-1)!.causes === 2
          && world.points.at(-1)!.current.valence > before; break;
      }
      case 'quality.affect.touch': {
        const before = world.points.at(-1)!.current.valence;
        for (const [id, error, expectation] of [['welcome', 0.8, 0.2], ['refusal', -1, -0.2]] as const) {
          world.store.apply(SCOPE, { type: 'touch-appraised', outcome: { error, expectation, unexpected: 0.8 } });
          world.shadow = advanceAffect(world.shadow, world.at, id);
          world.shadow = impulseAffect(world.shadow, { key: 'synthetic-touch', error, expectation, held: true, learningRate: 0.5, unexpected: 0.8 }).state;
          world.capture(); world.at += 60_000;
        }
        condition = world.points[1]!.current.valence > before && world.points[2]!.current.valence < world.points[1]!.current.valence; break;
      }
      case 'quality.affect.idle': {
        world.event('exciting-success', 0.9); const receipts = world.store.fcaAffectReceipts(SCOPE).length;
        const clock = world.store.snapshot(SCOPE).emotionClock;
        world.at += 20 * 60_000; world.store.apply(SCOPE, { type: 'awake-observed' });
        world.shadow = advanceAffect(world.shadow, world.at, 'idle'); world.capture();
        condition = world.store.fcaAffectReceipts(SCOPE).length === receipts
          && stableFingerprint(world.store.snapshot(SCOPE).emotionClock) !== stableFingerprint(clock); break;
      }
      case 'quality.affect.restart-duplicate': {
        world.event('original', 0.7); const before = world.store.snapshot(SCOPE), item = world.store.fcaAffectReceipts(SCOPE)[0]!;
        world.restart(); const restored = world.store.snapshot(SCOPE);
        const result = world.coordinator.submit(SCOPE, item); world.capture();
        condition = result === 'duplicate' && restored.version === before.version
          && stableFingerprint(restored.emotion) === stableFingerprint(before.emotion)
          && world.store.fcaAffectReceipts(SCOPE).length === 1; break;
      }
      case 'quality.affect.private-source': {
        world.event('private-original', 0.7); const before = world.store.snapshot(SCOPE);
        world.visible = false; const result = world.event('withheld', -0.8);
        const after = world.store.snapshot(SCOPE), publicFace = messageEmotionForOthers(createShannonMessageEmotion(after.emotion, after.expressiveEmotion));
        condition = result === 'withheld' && after.version === before.version
          && stableFingerprint(after.emotion) === stableFingerprint(before.emotion)
          && world.coordinator.snapshot(SCOPE).causes.length === 0 && !('kind' in publicFace) && !('cause' in publicFace); break;
      }
      default: throw new Error('UNKNOWN_QUALITY_AFFECT_SCENARIO');
    }
    return { points: world.points, condition };
  } finally { world.close(); }
}

const bounded = (state: ShannonEmotion) => Number.isFinite(state.valence) && Math.abs(state.valence) <= 1
  && Number.isFinite(state.arousal) && state.arousal >= 0 && state.arousal <= 1
  && Number.isFinite(state.openness) && state.openness >= 0 && state.openness <= 1;

/** Read-only function comparison, not the runtime PredictionShadow, stance inference or live naturalness. */
export function qualityAffectDriver(definition: ReachScenarioDefinition): ReachDriver {
  return async () => {
    const measured = history(definition), replayed = history(definition);
    const final = measured.points.at(-1)!;
    const step = measured.points.slice(1).map((point, index) => Math.abs(point.current.valence - measured.points[index]!.current.valence));
    return {
      checks: judgedFacts(definition, { 'state.bounded': measured.points.every(point => bounded(point.current) && bounded(point.shadow)),
        'state.reproducible': stableFingerprint(measured) === stableFingerprint(replayed), 'state.condition': measured.condition }),
      metrics: { samples: measured.points.length, currentFinalValence: final.current.valence, shadowFinalValence: final.shadow.valence,
        currentFinalArousal: final.current.arousal, shadowFinalArousal: final.shadow.arousal,
        currentFinalOpenness: final.current.openness, shadowFinalOpenness: final.shadow.openness,
        maxArousalDifference: Math.max(...measured.points.map(point => Math.abs(point.current.arousal - point.shadow.arousal))),
        maxOpennessDifference: Math.max(...measured.points.map(point => Math.abs(point.current.openness - point.shadow.openness))),
        maxValenceDifference: Math.max(...measured.points.map(point => Math.abs(point.current.valence - point.shadow.valence))),
        maxCurrentValenceStep: Math.max(0, ...step), finalReceipts: final.receipts, finalVisibleCauses: final.causes },
      steps: measured.points.length,
      inputs: { fixture: `quality-affect:${definition.id}:v1`, observations: JSON.stringify(measured.points), comparison: 'committed-FCA-and-touch-vs-existing-affectDynamics',
        naturalness: 'not-evaluated', voiceDelivery: 'not-evaluated',
        comparator: 'affectDynamics-functions-fixed-learning-rate-0.5-not-runtime-PredictionShadow',
        touch: 'synthetic-outcome-reducer-only', privacy: 'coordinator-visibility-boundary-only', restart: 'committed-companion-only' },
    };
  };
}

export function qualityAffectDrivers() {
  return Object.fromEntries(QUALITY_AFFECT_SCENARIOS.map(definition => [definition.id, () => qualityAffectDriver(definition)]));
}
