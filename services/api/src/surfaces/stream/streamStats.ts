import type { StreamServiceParts } from './streamServiceParts.js';
import type { StreamReceipt } from './streamContract.js';
import type { StreamLedger } from './streamLedger.js';
import type { StreamMeasure } from './streamMeasure.js';
import { percentiles } from './streamMeasure.js';

export function recordSpoken(ledger: StreamLedger, measure: StreamMeasure, counters: { answered: number },
  commentIds: readonly string[], createdMs: number, receipt: StreamReceipt | undefined): void {
    const startedAt = receipt?.startedAt ? Date.parse(receipt.startedAt) : Number.NaN;
    const endedAt = receipt?.endedAt ? Date.parse(receipt.endedAt) : Number.NaN;
    if (Number.isFinite(startedAt)) measure.note(measure.lineToSoundMs, startedAt - createdMs);
    if (Number.isFinite(startedAt) && Number.isFinite(endedAt)) measure.counts.speakingSeconds += Math.max(0, (endedAt - startedAt) / 1000);
    for (const id of commentIds) {
      const record = ledger.get(id);
      if (!record) continue;
      if (record.status === 'picked') {
        record.status = 'answered';
        counters.answered += 1;
      }
      if (!Number.isFinite(startedAt)) continue;
      record.soundAtMs = startedAt;
      measure.note(measure.publishedToSoundMs, startedAt - record.publishedMs);
      measure.note(measure.commentToSoundMs, startedAt - record.receivedMs);
    }
}

export function streamStats(input: {
  comments: number; answered: number; lines: number; notices: number; declined: number; spoken: number;
  durationSeconds: number; waiting: number; inFlight: number; modelCallsLastMinute: number;
  measure: StreamMeasure; duplicates: number; chatPosts: { posted: number; failed: number };
  gate: StreamServiceParts['gate']['stats']; commentary: Readonly<Record<string, number>> | null;
}) {
  const { measure, spoken, duplicates, chatPosts, gate, commentary, ...counts } = input;
  const sound = percentiles(measure.commentToSoundMs);
  const minutes = Math.max(1 / 60, input.durationSeconds / 60);
  return { ...counts, firstSoundMedianMs: sound.median, firstSoundP90Ms: sound.p90,
    lineMedianMs: percentiles(measure.commentToLineMs).median,
    measure: { ...measure.summary(), answeredPerMinute: Math.round(counts.answered / minutes * 100) / 100,
      spoken, duplicates, chatPosts, gate, commentary } };
}
