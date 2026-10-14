import {
  FEELING_SENTENCE_LIMITS, feelingSentenceReason, foldFeelingDynamics, utteranceKind, utteranceTags, type CompanionStateSnapshot,
} from '@shannon/cognition';
import { observeAsync } from '../../infra/observer/observerContext.js';
import type { FeelingSentenceWriter } from '../../infra/models/feelingSentenceModel.js';
import type { FeelingEvents, FeelingKey, FeelingLines } from './feelingEvents.js';

/**
 * Her feeling sentence on a text turn (Syzygy ADR-0013 D7, stage 2 item 3; `SHANNON_FEELING_SENTENCE`, which needs the fast layer and
 * the feeling turn). Started with the turn, beside the feeling turn's Jev call, for the owner alone only (the lines are her own layer),
 * and only in a strong scene (`feelingSentenceReason`). The reply waits for it at most `FEELING_SENTENCE_LIMITS.waitMilliseconds`
 * beyond the moment its prompt is otherwise ready; late or failed, the reply goes on without it. The Observer is told the reason, the
 * outcome and the time, never the lines. Core: emotion.
 */
export interface FeelingSentenceTurn {
  scopeKey: string;
  key: FeelingKey;
  at: string;
  snapshot: CompanionStateSnapshot;
  lines: FeelingLines | null;
  words: string;
}

export function startFeelingSentence(events: FeelingEvents, writer: FeelingSentenceWriter, turn: FeelingSentenceTurn)
  : Promise<readonly string[] | null> | null {
  if (turn.key.audience !== 'owner_alone') return null;
  const core = foldFeelingDynamics(events.today(turn.scopeKey, turn.at, turn.snapshot), turn.key).core;
  const reason = feelingSentenceReason(core, Date.parse(turn.at));
  if (!reason) return null;
  const facts = { core, ledgerLine: turn.lines?.ledgerLine ?? '', turn: { kind: utteranceKind(turn.words), tags: utteranceTags(turn.words) } };
  const started = Date.now();
  return observeAsync('emotion', { phase: 'feeling.sentence', audience: turn.key.audience, reason }, () =>
    writer.write({ scopeKey: turn.scopeKey, facts }).catch(() => null),
  lines => ({ written: lines !== null, lines: lines?.length ?? 0, latencyMs: Date.now() - started }));
}

/** The lines, if they come within the wait; else null (the request goes on and its answer is dropped). */
export async function feelingSentenceWithin(pending: Promise<readonly string[] | null>,
  milliseconds: number = FEELING_SENTENCE_LIMITS.waitMilliseconds): Promise<readonly string[] | null> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), milliseconds); });
  try {
    return await Promise.race([pending.catch(() => null), late]);
  } finally { clearTimeout(timer); }
}
