import type { MinecraftLifecycleAction } from '../contracts/minecraftLifecycleContract.js';
import type { LlmUsageStore } from '../infra/models/llmUsage.js';
import { configuredLifecycleOutcomeLineWriter } from '../mind/action/respond/commitmentLineModel.js';
import {
  neutralLifecycleOutcomeLine, type LifecycleOutcomeFacts, type LifecycleOutcomeKind, type LifecycleOutcomeLineWriter,
} from '../mind/action/respond/lifecycleOutcomeLine.js';
import { SQLiteLifecycleOutcomeSpeaker } from '../surfaces/outreach/store/lifecycleOutcomeSpeaker.js';

/** How a lifecycle operation asked for in a conversation ended, as its runner reports it when it settles. */
export interface LifecycleOutcomeReport {
  scopeKey: string;
  /** The Talk it was asked in, when known. */
  threadId: string | null;
  operationId: string;
  action: MinecraftLifecycleAction;
  outcome: LifecycleOutcomeKind;
}
export type LifecycleOutcomeTeller = (report: LifecycleOutcomeReport) => Promise<void>;

export interface LifecycleOutcomeTellingParts {
  writer: LifecycleOutcomeLineWriter | null;
  speaker: Pick<SQLiteLifecycleOutcomeSpeaker, 'told' | 'say'>;
  /** Someone other than the owner may see or hear her body now (a stream included); unknown counts as yes. */
  others: (scopeKey: string, at: string) => boolean;
  now: () => string;
  signal?: AbortSignal;
}

/**
 * Tells him how a lifecycle operation he asked for ended (owner decision 2026-10-14, `lifecycleOutcomeLine.ts`): when its runner
 * settles it (`minecraftLifecycleRunner.ts`, the `settled` callback), she writes one line in her voice from the facts (cut off after
 * 20 seconds; the neutral factual line when none could be written or trusted), with the private-safe wording while anyone else may
 * see or hear her body, and it is said once into the Talk it was asked in and to her body. Nothing of her mood, her inner note or
 * her moments is read, and no cap of theirs applies: it is system delivery of something he asked for. Never throws.
 */
export function lifecycleOutcomeTeller(parts: LifecycleOutcomeTellingParts): LifecycleOutcomeTeller {
  const telling = new Set<string>();
  const others = (scopeKey: string): boolean => {
    try {
      return parts.others(scopeKey, parts.now());
    } catch {
      return true;
    }
  };
  return async report => {
    if (telling.has(report.operationId)) return;
    telling.add(report.operationId);
    try {
      if (parts.speaker.told(report.scopeKey, report.operationId)) return;
      const facts: LifecycleOutcomeFacts = { action: report.action, outcome: report.outcome, others: others(report.scopeKey) };
      let line = await parts.writer?.write(report.scopeKey, facts, parts.signal).catch(() => null) ?? null;
      // Someone came while it was written: the line for him alone is not said in front of them.
      if (!facts.others && others(report.scopeKey)) line = neutralLifecycleOutcomeLine({ ...facts, others: true });
      parts.speaker.say(report.scopeKey, report.threadId, report.operationId, line ?? neutralLifecycleOutcomeLine(facts),
        report.outcome === 'completed', parts.now());
    } catch { /* telling never fails the operation */ } finally {
      telling.delete(report.operationId);
    }
  };
}

/** The API's teller: the background model on its budget, and the speaker on the shared database. */
export function configuredLifecycleOutcomeTelling(environment: Readonly<Record<string, string | undefined>>, parts: {
  databasePath: string; usageStore: LlmUsageStore; others: (scopeKey: string, at: string) => boolean; now: () => string;
}): { tell: LifecycleOutcomeTeller; close(): void } {
  const speaker = new SQLiteLifecycleOutcomeSpeaker(parts.databasePath);
  const controller = new AbortController();
  const tell = lifecycleOutcomeTeller({
    writer: configuredLifecycleOutcomeLineWriter(environment, parts.usageStore), speaker, others: parts.others, now: parts.now, signal: controller.signal,
  });
  return {
    tell,
    close() {
      controller.abort();
      speaker.close();
    },
  };
}
