import type { FcaConversationTurn } from './fcaConversationPorts.js';
import type { TaskView } from '../taskRuntime/taskRuntimePorts.js';
import type { PlaceSearchContext } from '../../../integrations/places/placeDiscovery.js';

/** Admission reuses the current conversation source, ancestor and existing task runner. */
export function admitConversationWork(turn: FcaConversationTurn | null | undefined, input: {
  message: string; research: boolean; places?: PlaceSearchContext;
}): TaskView | null {
  if (!input.research || !turn?.delegate) return null;
  return turn.delegate({ title: input.message.slice(0, 100), goal: input.message,
    completionCriteria: '元の依頼に答える内容を実際の読み取り結果と出典で確認し、要点と出典を親の会話へ返す。確認できない事項は未確認と伝える。場所の依頼では実在候補と地図リンクを保持する。',
    context: `[Conversation work]\n${JSON.stringify({ originalRequest: input.message, ...(input.places ? { permittedPlaceContext: input.places } : {}) })}\nUse the matching existing read tool once, retain its receipt, and synthesize from it. Do not repeat a successful paid search merely to format its answer. Ask the parent only for missing information; never infer an unknown location. Report useful received findings to the parent with task.send; keep their sources and uncertainty. Finish only on observed results.` }, input.places);
}

export function admittedWorkContext(task: TaskView | null): string {
  return task ? `[Work admitted]\n${JSON.stringify({ id: task.id, phase: task.phase, goal: task.goal })}\nThe original requested research is admitted under this conversation's source. A ready task starts after this visible response is recorded; an executing task is already running. Give a short natural acknowledgement and answer anything already known. Do not run that same research again in this foreground reply or claim results exist yet. The owner can keep talking while the task runs.` : '';
}
