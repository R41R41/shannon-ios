import { autonomyDayKey, yenFromUsd } from './mind/inhibition/autonomyBudget.js';
import { roomLookNotePrompt } from './autonomyLoopPrompts.js';
import type { AutonomyLoopCycle } from './autonomyLoopState.js';
import type { PreparedStep, StepDependencies } from './autonomyLoopSteps.js';
import { AUTONOMY_ROOM_LOOK_MODEL, AUTONOMY_ROOM_LOOK_TOKENS, autonomyModelCostUsd } from './autonomyModels.js';

/**
 * The step 「部屋を一度見る」 (owner decision, Syzygy ADR-0002 addendum 2026-10-02, stage 2):
 * in her own time she may take one look at the room through her body's camera.
 *
 * The loop only asks for the look and waits. The frame goes from the body to the API
 * process, which shows it to the model once and drops it; this process receives her
 * short text about it and the token counts, never the frame. The text becomes a note in
 * her study that the owner can read. It is not a message and nothing is sent. The note is
 * hers to use: a prompt of the loop that is given it also gets the rule that what she saw
 * is not written into a story as it is (`autonomyLoopPrompts.ts`).
 */
export interface AutonomyRoomLooks {
  /** A body with its camera on is showing her window, no look is open, and the overall hour and day limits have room. */
  available(scopeKey: string, at: string): boolean;
  look(scopeKey: string, input: { model: string; signal?: AbortSignal }): Promise<
    | { outcome: 'seen'; text: string; usage?: { inputTokens: number; outputTokens: number } }
    | { outcome: 'not_seen'; code: string; summary: string; usage?: { inputTokens: number; outputTokens: number }; modelCalled: boolean }>;
}

export const ROOM_LOOK_DOMAIN = 'room_look';
export const ROOM_LOOK_STEP_TOOL = 'study.look';
/** She does not look while the owner wrote or spoke this recently, even when the cycle began before. */
export const ROOM_LOOK_OWNER_QUIET_MILLISECONDS = 10 * 60_000;

/** The only time a look is planned or asked for. Every condition is read again when the step runs. */
export function roomLookAvailable(dependencies: StepDependencies, scopeKey: string, at: string): boolean {
  const { looks, config, loop, model, showing, store } = dependencies;
  if (!looks || config.maximumRoomLooksPerDay < 1 || !model.canUse(AUTONOMY_ROOM_LOOK_MODEL)) return false;
  if (store.activity.countForDay(scopeKey, autonomyDayKey(at, config), ROOM_LOOK_DOMAIN, 'allowed') >= config.maximumRoomLooksPerDay) return false;
  const quiet = Math.max(loop.ownerActiveMilliseconds, ROOM_LOOK_OWNER_QUIET_MILLISECONDS);
  if (showing.ownerActiveSince(scopeKey, new Date(Date.parse(at) - quiet).toISOString())) return false;
  return looks.available(scopeKey, at);
}

export function prepareRoomLook(dependencies: StepDependencies, cycle: AutonomyLoopCycle, at: string): PreparedStep | null {
  if (!roomLookAvailable(dependencies, cycle.scopeKey, at)) return null;
  const { store, config } = dependencies;
  const prompt = roomLookNotePrompt();
  const estimate = {
    inputTokens: Math.ceil((prompt.system.length + prompt.prompt.length) * 1.5) + 64 + AUTONOMY_ROOM_LOOK_TOKENS.frame,
    outputTokens: AUTONOMY_ROOM_LOOK_TOKENS.output,
  };
  const costUsd = autonomyModelCostUsd(AUTONOMY_ROOM_LOOK_MODEL, estimate, config.modelPrices);
  if (costUsd === null) return null;
  return {
    request: {
      domain: ROOM_LOOK_DOMAIN, summary: '体のカメラで、部屋を一度見ます。', tool: ROOM_LOOK_STEP_TOOL,
      paid: { model: AUTONOMY_ROOM_LOOK_MODEL, estimatedCostYen: yenFromUsd(costUsd, config) },
    },
    purpose: 'room_look', estimate,
    async perform(adapters, _at, signal) {
      if (!adapters.looks) return { outcome: 'failed', summary: '見る道具が渡されなかったため、見ませんでした。' };
      const result = await adapters.looks.look(cycle.scopeKey, { model: AUTONOMY_ROOM_LOOK_MODEL, signal });
      if (result.outcome !== 'seen') {
        // No frame reached the model: nothing was spent. A call whose cost the provider did not report is charged the estimate.
        const usage = result.usage ?? (result.modelCalled ? estimate : undefined);
        return { outcome: 'failed', summary: result.summary, reasonCode: result.code, ...(usage ? { usage } : {}) };
      }
      const text = result.text;
      return {
        // What she saw stays out of the record; it is in the note.
        outcome: 'done', usage: result.usage ?? estimate, summary: '体のカメラで部屋を一度見て、見たことを書斎のメモにしました。',
        commit: (_remaining, commitAt) => {
          const piece = store.study.create(cycle.scopeKey, {
            kind: 'note', title: `見たこと（${localHour(commitAt, config.timeZone)}）`, body: text, origin: 'room_look', model: AUTONOMY_ROOM_LOOK_MODEL,
          }, commitAt);
          if (typeof piece === 'string') throw new Error(piece);
          return { link: `shannon-study://${piece.id}` };
        },
      };
    },
  };
}

function localHour(at: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('ja-JP', { timeZone, month: 'long', day: 'numeric', hour: 'numeric', hourCycle: 'h23' }).format(new Date(at));
  } catch {
    return at.slice(0, 13);
  }
}
