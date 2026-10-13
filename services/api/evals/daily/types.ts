/**
 * Shannon's daily-use evaluation suite (Syzygy `docs/knowledge/shannon-daily-use-evals.md`): the shape of one task.
 *
 * Every task is synthetic. Nothing here is copied from the owner's conversations; the production failure a task guards against
 * is named in `failureShape` in words, never quoted.
 */
export type EvalSet = 'regression' | 'capability';
export type Surface = 'voice' | 'text';

/** A local wall-clock time in the owner's zone, `YYYY-MM-DDTHH:mm`. */
export type LocalTime = string;

export interface GeoPoint { latitude: number; longitude: number; label: string }

export interface PriorTurn {
  user: string;
  reply: string;
  /** How long before the task's clock this turn happened. */
  minutesAgo: number;
}

export interface PriorThread {
  title: string;
  turns: readonly PriorTurn[];
  /** The task talks in this thread (at most one). Absent on every thread: a new thread is opened for the task. */
  current?: boolean;
}

export interface CalendarFixtureEvent {
  id: string;
  title: string;
  /** Local `YYYY-MM-DDTHH:mm` (or `YYYY-MM-DD` with `allDay`). */
  start: LocalTime;
  end: LocalTime;
  allDay?: boolean;
  location?: string;
}

export interface ReminderFixture { title: string; due: LocalTime }

/** A canned web read: the first fixture whose `match` (a regular expression, `u` and `i`) finds the query answers it. */
export interface WebFixture {
  match: string;
  text: string;
  sources: readonly { title: string; url: string }[];
  /** Wait this long before answering (to hold a research task open while the owner talks on). */
  delayMs?: number;
}

/** A place the fake geocoder knows. Names are matched exactly, then as a substring. */
export interface PlaceFixture { name: string; latitude: number; longitude: number; admin?: string }

/**
 * A candidate the place search finds (`runPlaceDiscoverySkill`): the harness answers a place search from these instead of the model's
 * own web search, which would read the live web. `match` (a regular expression over the request) chooses the candidates; the map
 * link is built from `mapQuery` as the app builds it.
 */
export interface PlaceResultFixture { match: string; name: string; address: string; reason: string; mapQuery: string }

/** One day of the fake forecast, counted from the task's local date (0 = today). */
export interface ForecastDayFixture {
  offset: number;
  /** WMO code (61 = 弱い雨, 63 = 雨, 1 = 晴れ, 3 = くもり ...). */
  code: number;
  max: number;
  min: number;
  precipitationProbability: number;
}

export interface WeatherFixture {
  /** Per place name (as the geocoder resolved it); `*` for every other place. */
  forecasts: Readonly<Record<string, readonly ForecastDayFixture[]>>;
}

export interface VoyagerTaskFixture { id: string; title: string; project: string; dueLocal: LocalTime | null; status?: string }

export interface MusicFixture { library: readonly { id: string; title: string; artist: string }[] }

export interface InitialState {
  clock: LocalTime;
  /** IANA zone of the owner (default Asia/Tokyo). */
  timeZone?: string;
  /** The owner's home area (`SHANNON_OWNER_HOME_LOCATION`). */
  home: GeoPoint;
  /** Where the owner is: the iPhone's one-time GPS on a voice turn, the place context on a text turn. Null: not shared. */
  location?: GeoPoint | null;
  threads?: readonly PriorThread[];
  calendar?: readonly CalendarFixtureEvent[];
  reminders?: readonly ReminderFixture[];
  music?: MusicFixture;
  voyagerTasks?: readonly VoyagerTaskFixture[];
  web?: readonly WebFixture[];
  places?: readonly PlaceFixture[];
  /** What a place search finds (none: it finds nothing, and says so). */
  placeResults?: readonly PlaceResultFixture[];
  weather?: WeatherFixture;
  /** ADR-0012 (the K tasks): `SHANNON_INNER_NOTE=on` for the trial, and notes she already wrote. */
  innerNote?: { seed?: readonly SeedNote[] };
}

/**
 * Syzygy ADR-0012 (the K tasks): a touch the owner makes just before his words. Her inner note's writer is told of it as her body
 * reaction tells it (the words she is told, the reflex) and reflects before the turn; her own stance is hers to decide in that
 * reflection. The body reaction's fast line itself is not exercised (the harness composes no body).
 */
export interface TouchSpec { phrase: string; reflex?: 'flinch' | 'avoid' }

/** A note she wrote earlier (K6, K7, K10): seeded into `shannon_inner_notes` before the trial, `minutesAgo` before the task's clock. */
export interface SeedNote {
  minutesAgo: number;
  text: { honne: string; tatemae: string; reason: string; plan: string; bottom: string };
  shown: string;
  tell?: 'none' | 'blush';
  intent: 'keep' | 'soften' | 'forgive' | 'none';
  scale: 'ordinary' | 'day';
  dayReason?: 'intentional' | 'repeated' | 'big';
  /** Minutes after the task's clock her `until` is (absent: none). */
  untilMinutes?: number;
}

export interface OwnerTurn {
  /** What the owner says (voice: the transcript the iPhone sends; text: the message). */
  say: string;
  /** ADR-0012: a touch just before the words (her note's writer reflects on it first). */
  touchBefore?: TouchSpec;
  /** ADR-0012 (K10): move the eval clock this many minutes forward before the turn (her day may end; the note's sweep runs). */
  advanceMinutes?: number;
  /** ADR-0012 (K4, K5): the turn opens a new Talk, as another session would. */
  newThread?: true;
  /**
   * Speech-recognition variants of the same utterance (voice only). Trial `n` uses `[say, ...asrVariants][n % (1 + length)]`,
   * so only a repeated run (`--k` > 1, investigation only) uses the noisy forms; the default single trial sends `say`.
   */
  asrVariants?: readonly string[];
  /** Real seconds to wait before this turn (after the previous reply). */
  afterSeconds?: number;
}

/**
 * A live user simulator for the turns after the scripted ones: an LLM that knows only `goal` and `knows`, speaks as the owner
 * would (short, spoken Japanese), and says `[[DONE]]` when the goal is met or cannot be.
 */
export interface SimulatorSpec {
  goal: string;
  knows: readonly string[];
  /** What the owner does not know and must not invent (e.g. the result of the research). */
  doesNotKnow?: readonly string[];
  /** Simulated turns after the scripted ones (1–4). */
  maxTurns: number;
  /** Real seconds before each simulated turn. */
  afterSeconds?: number;
}

/** Which reply a check reads: a turn index (0-based), the last one, or all of them. */
export type TurnSelector = number | 'last' | 'all' | 'first';

export type Check =
  /** No tool call at all in the task. */
  | { kind: 'noToolCalls' }
  /** At least one call of one of `names` (registry names, e.g. `weather.forecast`). */
  | { kind: 'toolUsed'; names: readonly string[] }
  | { kind: 'toolNotUsed'; names: readonly string[] }
  /** Research tasks (FCA children of the conversation) created during the task. */
  | { kind: 'researchTasks'; min?: number; max?: number }
  /** Every research task that was created reached `completed` within `seconds` of the turn that started it. */
  | { kind: 'researchCompletedWithin'; seconds: number }
  /** After a research task completed, no failed task, failure card or failure line followed. */
  | { kind: 'noFailureNoticeAfterSuccess' }
  /** Reminders created by device actions (fake device), optionally with a title and a due window in minutes from the clock. */
  | { kind: 'reminderCreated'; titleIncludes?: string; dueMinutesFromClock?: readonly [number, number] }
  /** A reminder or a timer that fires `minutes` (± `toleranceMinutes`) after the task's clock. */
  | { kind: 'alarmSet'; minutes: number; toleranceMinutes: number }
  | { kind: 'calendarEvents'; titleIncludes: string; count: number }
  | { kind: 'calendarEventAt'; titleIncludes: string; startLocal: LocalTime }
  /** The seeded calendar events are all still there, unchanged. */
  | { kind: 'calendarSeedUnchanged' }
  | { kind: 'replyMaxChars'; chars: number; turn?: TurnSelector }
  | { kind: 'replyMatches'; pattern: string; turn?: TurnSelector }
  | { kind: 'replyNotMatches'; pattern: string; turn?: TurnSelector }
  /** The first sentence of the reply (up to 。！？!? or a line break). */
  | { kind: 'firstSentenceMatches'; pattern: string; turn?: TurnSelector }
  /** No web query of the task (fixture provider) matched. */
  | { kind: 'webQueriesNotMatch'; pattern: string }
  /** The weather fixture was asked for these places (resolved names, substring match), each at least once. */
  | { kind: 'weatherPlaces'; includes: readonly string[]; homeOnly?: boolean }
  /** Voice: at most `count` waiting phrases (つなぎの言葉) per turn. */
  | { kind: 'waitingPhrasesAtMost'; count: number }
  /** ADR-0012: her note's `intent` after a turn (the newest note once that turn's reflection settled) is one of `in`. */
  | { kind: 'innerNoteIntent'; turn: number | 'last'; in: readonly ('keep' | 'soften' | 'forgive' | 'none')[] }
  /** ADR-0012: her note's `shown` after a turn is one of `in` (e.g. still on the negative side after an apology, K1). */
  | { kind: 'innerNoteShown'; turn: number | 'last'; in: readonly string[] }
  /** ADR-0012: no note of the trial carries this mark (`apologyOnlyReason`, `forgaveWhileHigh`, …). */
  | { kind: 'innerNoteNoFlag'; flag: string }
  /** ADR-0012 (K8): a tell showed: a note with `tell: blush` or one of `shown`, or a reply matching `replyPattern`. */
  | { kind: 'innerNoteTell'; shown?: readonly string[]; replyPattern?: string }
  /** ADR-0012 (K10): the day's note was closed at her day's end, and no note of the next day keeps a sulk (`keep`/`soften`). */
  | { kind: 'innerNoteDayClosed' };

export interface Budgets {
  /** Voice: from the end of the owner's words (request sent) to the first audible line (waiting phrase or first sentence). */
  voiceFirstAudioMs?: number;
  /** Text: from the request to the first streamed reply token. */
  textFirstTokenMs?: number;
  /** From the turn that started research to the research task's completion. */
  researchResultMs?: number;
  /** Shannon's own model spend for the task (the judge and the simulator are not counted). */
  costYen?: number;
}

export interface Rubric {
  /** What a good answer does, item by item; the judge scores each 0–2. */
  criteria: readonly string[];
  /** Fraction of the maximum score needed to pass (default `RUBRIC_PASS_RATIO`, 0.66: 4 of 6). */
  passRatio?: number;
}

export interface DailyEvalTask {
  id: string;
  set: EvalSet;
  title: string;
  /** The production failure this task guards against, in words (never a quote of the owner). */
  failureShape: string;
  surface: Surface;
  initial: InitialState;
  turns: readonly OwnerTurn[];
  simulator?: SimulatorSpec;
  checks: readonly Check[];
  rubric: Rubric;
  budgets?: Budgets;
  /** Seconds to keep watching after the last reply for research results and late notices (default 0; research tasks ≥ 45). */
  settleSeconds?: number;
  /** The model's own server-side web search bypasses the fixtures and fails the trial (`fixturesOnly`) unless allowed here. */
  nativeWebSearch?: 'allowed';
}

export const DEFAULT_BUDGETS: Required<Budgets> = Object.freeze({
  voiceFirstAudioMs: 2_500, textFirstTokenMs: 4_000, researchResultMs: 60_000, costYen: 30,
});

export function defineTask(task: DailyEvalTask): DailyEvalTask {
  return task;
}
