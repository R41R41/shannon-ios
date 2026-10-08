import type { MemoryAudience } from '@shannon/cognition';
import type { ServerResponse } from 'node:http';
import type { ApiResponse } from '../../contracts/contracts.js';
import type { ConversationStore } from '../../mind/memory/memoryPorts.js';
import { closedId, voicePerception, type MindPerceiver, type PerceivedItem } from '../../mind/perception/perceptionPorts.js';
import type { MindTurnPorts } from '../../mind/workspace/workspacePorts.js';
import { voicePlanResponse } from '../../mind/emotion/voiceEmotionPlan.js';
import { observeAsync, observeSync, observerHandoff } from '../../infra/observer/observerContext.js';
import { ownerSaysCompanionPresent } from '../../mind/perception/voiceCompanionPresence.js';
import { writeEvent } from '../../infra/http/ndjsonStream.js';

/** Both HTTP streaming and direct delegation use the same conservative audience and explicit utterance ID. */
export function voiceObservationOptions(scopeKey: string, body: unknown) {
  const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
  const values = record(body), device = record(values.deviceContext), utterance = record(device.userUtterance);
  const audience = values.participantMode === 'guest' || device.companionPresent === true || utterance.companionPresent === true
    || ownerSaysCompanionPresent(typeof values.transcript === 'string' ? values.transcript.trim() : '') ? 'others' as const : 'owner' as const;
  const runId = typeof utterance.id === 'string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu.test(utterance.id) ? utterance.id : undefined;
  return { scopeKey, surface: 'voice', audience, ...(runId ? { runId } : {}) };
}

/** Only text actually handed to the NDJSON writer is a streamed sentence, never a provider delta. */
export function writeObservedVoiceSegment(response: ServerResponse, text: string, voicePlan: Record<string, unknown> | undefined,
  source?: 'llm' | 'plan'): Promise<void> {
  if (source) observerHandoff(source, 'sentences', { text });
  return observeAsync('sentences', { delivery: 'stream', text }, () => writeEvent(response, { type: 'segment', text, voicePlan }),
    () => ({ delivered: true }));
}

/** Stage 3, step F3: the workspace's blocks for a voice turn (`[いまの場]`, at most two lines), or ''. Never throws. */
export function voiceWorkspace(mind: MindTurnPorts | undefined, turn: { scopeKey: string; threadId: string; present: MemoryAudience; perceived: PerceivedItem | null;
  snapshot: Parameters<NonNullable<MindTurnPorts['render']>>[0]['snapshot']; snapshotNow?:()=>Parameters<NonNullable<MindTurnPorts['render']>>[0]['snapshot']; store: ConversationStore; at: string }): string {
  if (!mind?.render) return '';
  try {
    return observeSync('workspace', { surface: 'voice', hasCurrentItem: turn.perceived !== null }, () =>
      mind.render!({ scopeKey: turn.scopeKey, surface: 'voice', present: turn.present, at: turn.at, currentItemId: turn.perceived?.itemId ?? null,
        current: { surface: 'voice', sourceId: closedId(turn.threadId) }, snapshot: turn.snapshot, snapshotNow:turn.snapshotNow, store: turn.store }),
    value => ({ characterCount: value.length }));
  } catch { return ''; }
}

/** Stage 3, step F2: never throws and never changes the turn. */
export function perceiveVoiceTurn(mind: MindPerceiver | undefined, scopeKey: string, input: Parameters<typeof voicePerception>[0]): PerceivedItem | null {
  if (!mind) return null;
  try { return observeSync('perception', { surface: 'voice', unverified: input.unverified },
    () => mind.perceive(scopeKey, voicePerception(input)), value => ({ perceived: value !== null })); } catch { return null; }
}

/** Closed device-visible decisions only: no emotion causes, prompts, memories or drafts. */
export function observedVoicePlan(...args: Parameters<typeof voicePlanResponse>): Record<string, unknown> {
  return observeSync('plan', { surface: 'voice' }, () => voicePlanResponse(...args), value => ({
    shouldRespond: value.shouldRespond, conversationClass: value.conversationClass, latencyClass: value.latencyClass,
    affect: value.affect, affectIntensity: value.affectIntensity, delivery: value.delivery,
    selectedSkills: value.selectedSkills, decisionSource: value.decisionSource,
  }));
}

export function visibleVoiceResponse(work: () => ApiResponse): ApiResponse {
  return observeSync('sentences', { delivery: 'response' }, work, response => {
    const body = response.body as Record<string, unknown>;
    return { status: response.status, reply: typeof body.reply === 'string' ? body.reply : '', model: body.model };
  });
}
