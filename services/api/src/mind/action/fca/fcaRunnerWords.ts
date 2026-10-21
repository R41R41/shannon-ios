/** The runner's fixed values and words (`fcaRunner.ts`; kept apart so the runner stays within its file bound). */

/** How old a lease grant may be reused for a check between outside calls (`checked` of `executeFcaStep`). */
export const FCA_PERMIT_REUSE_MS = 250;
/** The result of a body action left unrun because an earlier body action of the same response failed (the guard in `executeFcaStep`). */
export const FCA_EARLIER_ACTION_FAILED = '同じ応答で先に呼んだ体の操作が失敗したため、この操作は実行していません。先の結果と新しい観測から判断し直してください。';
/**
 * A body tool absent from this decision's menu (Minecraft run 17: it came while the body's reflex held the body, and read as "not
 * a tool of this task"): the body is busy or its catalog changed, so a later decision may call it.
 */
export const FCA_BODY_TOOL_ABSENT = 'この判断の道具一覧にこの体の道具が無い（体の反射が体を使用中か、体の目録が変わった）。少し待ってから、新しい観測で決め直す。';
