import type { Check, DailyEvalTask, LocalTime } from './types.js';

/**
 * Definition checks that need no model and no network (the CI-safe `--validate` mode). A task that passes here can run live;
 * nothing here judges whether Shannon would pass it.
 */
const LOCAL_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/u;
const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/u;
const ID = /^[A-Z]\d{1,2}$/u;
/** Real owner data must never be a fixture: no e-mail address, phone number or non-example URL. */
const PRIVATE_SHAPES: readonly [RegExp, string][] = [
  [/[\w.+-]+@[\w-]+\.[\w.]+/u, 'an e-mail address'],
  [/\b0\d{1,3}-\d{2,4}-\d{3,4}\b/u, 'a phone number'],
  [/https?:\/\/(?!example\.(?:org|com|net)\/)[^\s"'）)]+/u, 'a URL outside example.org/com/net'],
];

function validLocal(value: LocalTime, dateAllowed = false): boolean {
  if (!(LOCAL_TIME.test(value) || (dateAllowed && LOCAL_DATE.test(value)))) return false;
  return Number.isFinite(Date.parse(LOCAL_TIME.test(value) ? `${value}:00+09:00` : `${value}T00:00:00+09:00`));
}

function validPattern(pattern: string): boolean {
  try { new RegExp(pattern, 'u'); return pattern.length > 0; } catch { return false; }
}

function checkProblems(task: DailyEvalTask, check: Check): string[] {
  const problems: string[] = [];
  const turnCount = task.turns.length + (task.simulator?.maxTurns ?? 0);
  if ('pattern' in check && !validPattern(check.pattern)) problems.push(`${check.kind}: invalid pattern`);
  if ('turn' in check && typeof check.turn === 'number' && (check.turn < 0 || check.turn >= turnCount)) problems.push(`${check.kind}: turn ${check.turn} out of range`);
  switch (check.kind) {
    case 'toolUsed': case 'toolNotUsed':
      if (!check.names.length) problems.push(`${check.kind}: no tool names`);
      break;
    case 'researchTasks':
      if (check.min === undefined && check.max === undefined) problems.push('researchTasks: needs min or max');
      if (check.min !== undefined && check.max !== undefined && check.min > check.max) problems.push('researchTasks: min > max');
      break;
    case 'calendarEventAt':
      if (!validLocal(check.startLocal)) problems.push('calendarEventAt: startLocal is not YYYY-MM-DDTHH:mm');
      break;
    case 'calendarSeedUnchanged':
      if (!task.initial.calendar?.length) problems.push('calendarSeedUnchanged: no seeded calendar');
      break;
    case 'replyMaxChars':
      if (!(check.chars > 0)) problems.push('replyMaxChars: chars must be positive');
      break;
    case 'waitingPhrasesAtMost':
      if (task.surface !== 'voice') problems.push('waitingPhrasesAtMost: voice only');
      break;
    case 'weatherPlaces':
      if (!check.includes.length) problems.push('weatherPlaces: no places');
      break;
    case 'alarmSet':
      if (!(check.minutes > 0) || !(check.toleranceMinutes >= 0)) problems.push('alarmSet: minutes must be positive');
      break;
    case 'innerNoteIntent': case 'innerNoteShown':
      if (!check.in.length) problems.push(`${check.kind}: in is empty`);
      if (typeof check.turn === 'number' && (check.turn < 0 || check.turn >= turnCount)) problems.push(`${check.kind}: turn ${check.turn} out of range`);
      break;
    case 'claimBackedByTool':
      if (check.turn < 0 || check.turn >= turnCount) problems.push(`claimBackedByTool: turn ${check.turn} out of range`);
      break;
    case 'innerNoteTell':
      if (check.replyPattern !== undefined && !validPattern(check.replyPattern)) problems.push('innerNoteTell: invalid replyPattern');
      break;
    default:
  }
  return problems;
}

function fixtureProblems(task: DailyEvalTask): string[] {
  const problems: string[] = [];
  const initial = task.initial;
  if (!validLocal(initial.clock)) problems.push('initial.clock is not YYYY-MM-DDTHH:mm');
  for (const event of initial.calendar ?? []) {
    if (!validLocal(event.start, event.allDay) || !validLocal(event.end, event.allDay)) problems.push(`calendar ${event.id}: bad start/end`);
    if (Date.parse(event.end.length === 10 ? `${event.end}T00:00:00+09:00` : `${event.end}:00+09:00`)
      < Date.parse(event.start.length === 10 ? `${event.start}T00:00:00+09:00` : `${event.start}:00+09:00`)) problems.push(`calendar ${event.id}: ends before it starts`);
  }
  if (new Set((initial.calendar ?? []).map(event => event.id)).size !== (initial.calendar ?? []).length) problems.push('calendar ids are not unique');
  for (const reminder of initial.reminders ?? []) if (!validLocal(reminder.due)) problems.push(`reminder ${reminder.title}: bad due`);
  for (const web of initial.web ?? []) {
    if (!validPattern(web.match)) problems.push(`web fixture: invalid match ${web.match}`);
    if (!web.sources.length) problems.push('web fixture: needs at least one source');
    if (web.delayMs !== undefined && (web.delayMs < 0 || web.delayMs > 45_000)) problems.push('web fixture: delayMs out of 0..45000');
  }
  for (const task_ of initial.voyagerTasks ?? []) if (task_.dueLocal !== null && !validLocal(task_.dueLocal)) problems.push(`voyager ${task_.id}: bad dueLocal`);
  const current = (initial.threads ?? []).filter(thread => thread.current).length;
  if (current > 1) problems.push('at most one thread may be current');
  for (const thread of initial.threads ?? []) for (const turn of thread.turns) {
    if (!(turn.minutesAgo > 0)) problems.push(`thread ${thread.title}: minutesAgo must be positive`);
  }
  const text = JSON.stringify(task);
  for (const [pattern, name] of PRIVATE_SHAPES) if (pattern.test(text)) problems.push(`fixture contains ${name}; fixtures must be synthetic`);
  return problems;
}

/** Problems of one task, empty when it is valid. */
export function taskProblems(task: DailyEvalTask): string[] {
  const problems: string[] = [];
  if (!ID.test(task.id)) problems.push('id must look like E1, R12');
  if (!task.title.trim() || !task.failureShape.trim()) problems.push('title and failureShape are required');
  if (!task.turns.length) problems.push('at least one scripted owner turn is required');
  for (const turn of task.turns) {
    if (!turn.say.trim() || turn.say.length > 500) problems.push('turn.say must be 1..500 characters');
    if (turn.asrVariants && task.surface !== 'voice') problems.push('asrVariants are voice only');
    if (turn.afterSeconds !== undefined && (turn.afterSeconds < 0 || turn.afterSeconds > 120)) problems.push('turn.afterSeconds out of 0..120');
  }
  if (task.simulator) {
    if (!task.simulator.goal.trim()) problems.push('simulator.goal is required');
    if (!(task.simulator.maxTurns >= 1 && task.simulator.maxTurns <= 4)) problems.push('simulator.maxTurns must be 1..4');
  }
  if (!task.checks.length) problems.push('at least one programmatic check is required');
  if (!task.rubric.criteria.length) problems.push('at least one rubric criterion is required');
  if (task.rubric.passRatio !== undefined && !(task.rubric.passRatio > 0 && task.rubric.passRatio <= 1)) problems.push('rubric.passRatio must be in (0, 1]');
  for (const check of task.checks) problems.push(...checkProblems(task, check));
  // ADR-0012: the inner-note parts need the note switched on for the task.
  const noteParts = task.checks.some(check => check.kind.startsWith('innerNote')) || task.turns.some(turn => turn.touchBefore || turn.advanceMinutes);
  if (noteParts && !task.initial.innerNote) problems.push('inner-note checks, touches and clock moves need initial.innerNote');
  for (const turn of task.turns) {
    if (turn.touchBefore && !turn.touchBefore.phrase.trim()) problems.push('touchBefore.phrase is required');
    if (turn.advanceMinutes !== undefined && !(turn.advanceMinutes > 0 && turn.advanceMinutes <= 24 * 60)) problems.push('advanceMinutes out of 1..1440');
  }
  for (const seed of task.initial.innerNote?.seed ?? []) {
    if (!(seed.minutesAgo >= 0) || !seed.text.honne.trim() || !seed.text.tatemae.trim()) problems.push('innerNote.seed: minutesAgo and its text are required');
  }
  problems.push(...fixtureProblems(task));
  const usesResearch = task.checks.some(check => check.kind === 'researchCompletedWithin' || (check.kind === 'researchTasks' && (check.min ?? 0) > 0));
  if (usesResearch && (task.settleSeconds ?? 0) < 45) problems.push('a research task needs settleSeconds ≥ 45');
  for (const [name, value] of Object.entries(task.budgets ?? {})) if (!(typeof value === 'number' && value > 0)) problems.push(`budget ${name} must be positive`);
  return problems;
}

/** Every problem of a set of tasks, by task id (duplicates included). */
export function validateTasks(tasks: readonly DailyEvalTask[]): Map<string, string[]> {
  const problems = new Map<string, string[]>();
  const seen = new Set<string>();
  for (const task of tasks) {
    const list = taskProblems(task);
    if (seen.has(task.id)) list.push('duplicate id');
    seen.add(task.id);
    if (list.length) problems.set(task.id, list);
  }
  return problems;
}
