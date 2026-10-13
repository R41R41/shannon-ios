import { randomUUID } from 'node:crypto';
import { TurnTiming } from '../../../src/infra/observer/turnTiming.js';
import { SpokenSentenceSegmenter } from '../../../src/surfaces/voice/spokenSentences.js';
import type { DailyEvalTask, GeoPoint } from '../types.js';
import { FAKE_DEVICE_ID } from './device.js';
import { OWNER_SCOPE, type EvalRuntime } from './runtime.js';

/** One owner turn as the graders read it. Latencies are real milliseconds from the moment the request was handed over. */
export interface TurnRecord {
  index: number;
  surface: 'voice' | 'text';
  said: string;
  /** Who wrote the owner's words: the task's script or the user simulator. */
  by: 'script' | 'simulator';
  reply: string;
  status: number;
  error?: string;
  startedAt: number;
  /** Voice: the first audible line (waiting phrase or first sentence); text: the first streamed sentence. */
  firstAudioMs: number | null;
  firstTokenMs: number | null;
  firstSentenceMs: number | null;
  completeMs: number;
  waitingPhrases: string[];
  /** The content-free stage line of the turn (`turnTiming.ts`), when the path wrote one. */
  timing?: string;
}

function locationContext(location: GeoPoint | null | undefined) {
  return location ? { requestedLocation: true, location: { latitude: location.latitude, longitude: location.longitude, accuracyMeters: 25,
    observedAt: new Date().toISOString() } } : { requestedLocation: false, location: null };
}

/** The live voice path the iPhone uses: the streamed delegation, then the turn record the app posts after speaking. */
export async function voiceTurn(runtime: EvalRuntime, task: DailyEvalTask, said: string, index: number, by: TurnRecord['by']): Promise<TurnRecord> {
  const timeZone = task.initial.timeZone ?? 'Asia/Tokyo', utteranceId = `eval-${randomUUID()}`;
  const segmenter = new SpokenSentenceSegmenter(), waitingPhrases: string[] = [];
  let timingLine: string | undefined, firstAudio: number | null = null, firstSentence: number | null = null, receivedPlan = false;
  runtime.probe.firstTokenAt = null;
  const started = performance.now();
  const timing = new TurnTiming('voice', utteranceId.slice(0, 24), () => performance.now(), line => { timingLine = line; });
  const heard = () => { firstAudio ??= performance.now(); };
  const record: TurnRecord = { index, surface: 'voice', said, by, reply: '', status: 0, startedAt: started, firstAudioMs: null, firstTokenMs: null,
    firstSentenceMs: null, completeMs: 0, waitingPhrases };
  try {
    const response = await runtime.kernel.streamLiveVoiceDelegation({
      method: 'POST', path: '/v1/voice/gemini/cascade/delegations', deviceId: FAKE_DEVICE_ID,
      body: { scopeKey: OWNER_SCOPE, transcript: said, threadId: runtime.threadId, participantMode: 'owner',
        deviceContext: { timeZoneIdentifier: timeZone, ...locationContext(task.initial.location),
          userUtterance: { id: utteranceId, text: said, source: 'speech', historyReceipt: 'utterance-id' } } },
    }, {
      timing,
      onPlan: plan => {
        const first = !receivedPlan;
        receivedPlan = true;
        if (first && typeof plan.waitingPhrase === 'string' && plan.waitingPhrase.trim()) { waitingPhrases.push(plan.waitingPhrase.trim()); heard(); }
      },
      onTextDelta: delta => {
        for (const _segment of segmenter.append(delta)) { firstSentence ??= performance.now(); heard(); }
      },
    });
    record.status = response.status;
    const body = (response.body ?? {}) as Record<string, unknown>;
    record.reply = typeof body.reply === 'string' ? body.reply : '';
    if (record.reply && firstSentence === null) { firstSentence = performance.now(); heard(); }
    if (response.status >= 200 && response.status < 300) {
      // What the app posts once the reply was spoken: the canonical history write of the turn.
      const stored = await runtime.kernel.dispatch({ method: 'POST', path: '/v1/voice/gemini/cascade/turns', deviceId: FAKE_DEVICE_ID,
        body: { scopeKey: OWNER_SCOPE, userTranscript: said, shannonTranscript: record.reply || '…', threadId: runtime.threadId,
          utteranceId, timeZone } });
      if (stored.status >= 300) record.error = `turn record ${stored.status}`;
    } else record.error = JSON.stringify(response.body).slice(0, 300);
  } catch (error) {
    record.status = 599; record.error = error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 300) : 'unknown';
  } finally { timing.finish(record.status === 200 ? 'ok' : 'error'); }
  const at = (value: number | null) => value === null ? null : Math.round(value - started);
  return { ...record, firstAudioMs: at(firstAudio), firstSentenceMs: at(firstSentence), firstTokenMs: at(runtime.probe.firstTokenAt),
    completeMs: Math.round(performance.now() - started), ...(timingLine ? { timing: timingLine } : {}) };
}

/** `POST /v1/chat` with the sentence stream, as the apps send a text turn. */
export async function textTurn(runtime: EvalRuntime, _task: DailyEvalTask, said: string, index: number, by: TurnRecord['by']): Promise<TurnRecord> {
  let firstSentence: number | null = null;
  runtime.probe.firstTokenAt = null;
  const started = performance.now();
  const record: TurnRecord = { index, surface: 'text', said, by, reply: '', status: 0, startedAt: started, firstAudioMs: null, firstTokenMs: null,
    firstSentenceMs: null, completeMs: 0, waitingPhrases: [] };
  try {
    const response = await runtime.kernel.dispatch({ method: 'POST', path: '/v1/chat', deviceId: FAKE_DEVICE_ID,
      body: { scopeKey: OWNER_SCOPE, message: said, threadId: runtime.threadId, stream: 'sentences' },
      chatSentences: { write: line => { if (line.type === 'sentence') firstSentence ??= performance.now(); } } });
    record.status = response.status;
    const body = (response.body ?? {}) as Record<string, unknown>;
    record.reply = typeof body.reply === 'string' ? body.reply : '';
    // A reply that came back whole (no sentence was streamed) is first seen when it arrives.
    if (record.reply && firstSentence === null) firstSentence = performance.now();
    if (response.status >= 300) record.error = JSON.stringify(response.body).slice(0, 300);
  } catch (error) {
    record.status = 599; record.error = error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 300) : 'unknown';
  }
  const at = (value: number | null) => value === null ? null : Math.round(value - started);
  return { ...record, firstSentenceMs: at(firstSentence), firstAudioMs: at(firstSentence), firstTokenMs: at(runtime.probe.firstTokenAt),
    completeMs: Math.round(performance.now() - started) };
}
