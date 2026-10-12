import type { FcaConversationTurn } from './fcaConversationPorts.js';
import type { TaskView } from '../taskRuntime/taskRuntimePorts.js';
import type { PlaceSearchContext } from '../../../integrations/places/placeDiscovery.js';
import { serverEnvironment } from '../../../infra/config/serverEnvironment.js';
import { ownerLocalClock, ownerTimeZone } from '../../../infra/time/localDate.js';

const WORK_CRITERIA = '元の依頼に答える内容を実際の読み取り結果と出典で確認し、要点と出典を親の会話へ返す。確認できない事項は未確認と伝える。'
  + '場所の依頼では実在候補と地図リンクを保持する。';
const WORK_RULES = 'Use the matching existing read tool once, retain its receipt, and synthesize from it. '
  + 'Do not repeat a successful paid search merely to format its answer. Ask the parent only for missing information; never infer an unknown location. '
  + 'Count 今日, 明日 and other relative dates from requestedAt in its time zone (never UTC) and put the explicit date in searches and the report. '
  + 'Report useful received findings to the parent with task.send; keep their sources and uncertainty. Finish only on observed results.';

/** Admission reuses the current conversation source, ancestor and existing task runner. */
export function admitConversationWork(turn: FcaConversationTurn | null | undefined, input: {
  message: string; research: boolean; places?: PlaceSearchContext;
  /** When the owner asked, and the zone of his clock (the device's in a call; the configured owner zone otherwise). */
  at?: string; timeZone?: string;
}): TaskView | null {
  if (!input.research || !turn?.delegate) return null;
  const timeZone = input.timeZone ?? ownerTimeZone(serverEnvironment());
  const requested = { originalRequest: input.message, requestedAt: ownerLocalClock(input.at ?? new Date(), timeZone), timeZone,
    ...(input.places ? { permittedPlaceContext: input.places } : {}) };
  return turn.delegate({ title: input.message.slice(0, 100), goal: input.message, completionCriteria: WORK_CRITERIA,
    context: `[Conversation work]\n${JSON.stringify(requested)}\n${WORK_RULES}` }, input.places);
}

/** What the foreground reply is told once research is admitted: a brief, natural word, nothing guessed or promised. */
export function admittedWorkContext(task: TaskView | null): string {
  return task ? `[Work admitted]\n${JSON.stringify({ id: task.id, phase: task.phase, goal: task.goal })}\n`
    + 'The requested research is admitted under this conversation\'s source and runs on its own; its result is told to the owner when it arrives. '
    + 'Reply with one short, natural acknowledgement in your own voice that you will look into it (for example 「ちょっと調べてみますね」), worded freshly. '
    + 'Do not guess or pre-answer what the research will find, do not describe the process, and do not promise how or when the result comes '
    + '(no 「受け付けました」「結果がそろったら」「少しお待ちください」). Do not run that research again in this reply or claim results exist yet. '
    + 'Answer any other part of his message that needs no research. The owner can keep talking while the task runs.' : '';
}
