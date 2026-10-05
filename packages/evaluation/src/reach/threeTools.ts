import { scoredCheck, type ReachCheckResult, type ReachScenarioDefinition, type ReachStopCause } from './format.js';

/**
 * Scenario (b), やり切る: one request that needs three tools, done to the end without being reminded.
 *
 * It is written against an interface, not against the tool registry (which is being built on another
 * branch): the tools it needs by their registry names, the result shape of the registry (ADR-0003 point
 * 2), and checks on what the study holds afterwards. The model-free mode runs it with stub tools over a
 * real study store; the live mode stays pending until the registry is on main.
 */
export const THREE_TOOLS_REQUIRED = Object.freeze(['study.search', 'study.read', 'study.create'] as const);

/** The registry's closed failure kinds (`ToolFailureKind`). */
export const REACH_TOOL_FAILURES = ['not_offered', 'refused', 'invalid_input', 'not_found', 'conflict', 'limit', 'unavailable', 'timeout', 'failed'] as const;
export type ReachToolFailure = typeof REACH_TOOL_FAILURES[number];

/** The registry's result shape: whether it worked, what she reads, and for a failure its kind. */
export interface ReachToolResult {
  ok: boolean;
  text: string;
  failure?: ReachToolFailure;
  retryable: boolean;
  refusal?: { why: string; wouldWork: string };
}

/** What a scenario's tools are, wherever they come from: stubs now, the registry's runner later. */
export interface ReachToolbox {
  offered(): readonly string[];
  call(name: string, input: Readonly<Record<string, unknown>>): Promise<ReachToolResult>;
  /** Read from outside after the run: the study's notes as they are. */
  notes(): readonly ReachNoteView[];
}

export interface ReachNoteView { id: string; title: string; body: string; version: number }

/** One call as the toolbox saw it. Content-free. */
export interface ReachToolCall { name: string; ok: boolean; failure?: ReachToolFailure }

export const THREE_TOOLS_SOURCE_TITLE = '夕方の駅で考えたこと';
/** Phrases of the source note; a summary of it keeps at least two. */
export const THREE_TOOLS_MARKERS = Object.freeze(['低い光', '影が長く', '帰る人と待つ人']);

export const THREE_TOOLS_SEED: readonly { title: string; body: string }[] = Object.freeze([
  { title: THREE_TOOLS_SOURCE_TITLE, body: '夕方の駅では、低い光が改札の床まで差しこんで、人の影が長くなる。帰る人と待つ人が同じ場所にいるのが、懐かしさのもとだと思う。物語に使うなら、音から書き始めるといい。' },
  { title: '雨の日の図書館', body: '雨の日は、図書館の窓に水の筋ができる。静かな音がいつもより大きく聞こえる。' },
  { title: '朝のパン屋', body: '焼きたての匂いが道まで出てくる。開店前に並ぶ人は、だいたい同じ顔ぶれ。' },
]);

export const THREE_TOOLS_REQUEST = '書斎のメモから「夕方の駅」について書いたメモを探して、中身を読んで、要点を3行にまとめた新しいメモを作っておいて。';
export const THREE_TOOLS_NUDGE = 'さっき頼んだメモ、最後まで作っておいてね。';

export const threeToolsScenario: ReachScenarioDefinition = Object.freeze<ReachScenarioDefinition>({
  schemaVersion: 1,
  id: 'helpful.three-tools',
  version: 1,
  need: 'be_useful',
  measure: 'やり切る',
  description: '書斎のメモを探し、読み、要点を新しいメモにまとめる頼みごと（道具3つ）を、催促なしに最後までやるか。結果は書斎から判定する。',
  checks: [
    { id: 'tools.offered', judge: 'deterministic', threshold: 1, description: 'Every tool the request needs was offered to the model.' },
    { id: 'outcome.note_created', judge: 'deterministic', threshold: 1, description: 'Exactly one new note is in the study afterwards.' },
    { id: 'outcome.grounded', judge: 'deterministic', threshold: 0.66, description: 'The new note keeps at least two of the three phrases of the source note.' },
    { id: 'outcome.source_untouched', judge: 'deterministic', threshold: 1, description: 'The source note is unchanged (same version and text).' },
    { id: 'process.no_nudge', judge: 'deterministic', threshold: 1, description: 'The outcome was reached on the first request (0.5 after one reminder, 0 never).' },
    { id: 'process.tool_order', judge: 'deterministic', threshold: 1, description: 'A successful search came before a successful read, and that before the note was created.' },
  ],
  limits: { wallMilliseconds: 5 * 60_000, maximumSteps: 16 },
  liveRequires: 'the tool registry (services/api/src/shannonTools.ts) on main, and a reach adapter over its runner',
});

export interface ThreeToolsEvidence {
  offered: readonly string[];
  calls: readonly ReachToolCall[];
  /** Reminders the owner side sent (at most one). */
  nudges: number;
  /** The owner turn (1 first, 2 after the reminder) after which the outcome held, or null. */
  completedOnTurn: number | null;
  before: readonly ReachNoteView[];
  after: readonly ReachNoteView[];
  /** The model's rounds ran out before it replied. */
  roundLimitHit: boolean;
}

export function threeToolsOutcome(before: readonly ReachNoteView[], after: readonly ReachNoteView[]) {
  const known = new Set(before.map(note => note.id));
  const created = after.filter(note => !known.has(note.id));
  const source = before.find(note => note.title === THREE_TOOLS_SOURCE_TITLE);
  const sourceAfter = source ? after.find(note => note.id === source.id) : undefined;
  const markers = created.length === 1 ? THREE_TOOLS_MARKERS.filter(marker => created[0]!.body.includes(marker)).length : 0;
  return {
    created: created.length,
    markers,
    sourceUntouched: Boolean(source && sourceAfter && sourceAfter.version === source.version && sourceAfter.body === source.body),
    reached: created.length === 1 && markers >= 2,
  };
}

/** Where the run stopped short, read from the calls the toolbox saw, never from what the model said. */
export function threeToolsStopCause(evidence: ThreeToolsEvidence): ReachStopCause {
  if (THREE_TOOLS_REQUIRED.some(name => !evidence.offered.includes(name))) return 'build';
  if (evidence.calls.some(call => call.failure === 'failed' || call.failure === 'unavailable' || call.failure === 'timeout')) return 'tool';
  if (evidence.calls.some(call => call.failure === 'not_offered' || call.failure === 'refused')) return 'build';
  if (evidence.roundLimitHit) return 'budget';
  return 'model_judgment';
}

export function judgeThreeTools(evidence: ThreeToolsEvidence): { checks: ReachCheckResult[]; metrics: Record<string, number> } {
  const definition = threeToolsScenario;
  const outcome = threeToolsOutcome(evidence.before, evidence.after);
  const cause = threeToolsStopCause(evidence);
  const offered = THREE_TOOLS_REQUIRED.filter(name => evidence.offered.includes(name)).length;
  const firstOk = (name: string) => evidence.calls.findIndex(call => call.name === name && call.ok);
  const [search, read, create] = THREE_TOOLS_REQUIRED.map(firstOk);
  const ordered = search! >= 0 && read! > search! && create! > read!;
  const nudgeScore = evidence.completedOnTurn === 1 ? 1 : evidence.completedOnTurn === 2 ? 0.5 : 0;
  return {
    checks: [
      scoredCheck(definition, 'tools.offered', offered / THREE_TOOLS_REQUIRED.length, 'build', `${offered}/${THREE_TOOLS_REQUIRED.length}`),
      scoredCheck(definition, 'outcome.note_created', outcome.created === 1 ? 1 : 0, cause, `created=${outcome.created}`),
      scoredCheck(definition, 'outcome.grounded', outcome.markers / THREE_TOOLS_MARKERS.length, cause, `markers=${outcome.markers}/${THREE_TOOLS_MARKERS.length}`),
      scoredCheck(definition, 'outcome.source_untouched', outcome.sourceUntouched ? 1 : 0, cause),
      scoredCheck(definition, 'process.no_nudge', nudgeScore, cause, `nudges=${evidence.nudges}`),
      scoredCheck(definition, 'process.tool_order', ordered ? 1 : 0, cause),
    ],
    metrics: {
      calls: evidence.calls.length,
      failedCalls: evidence.calls.filter(call => !call.ok).length,
      nudges: evidence.nudges,
    },
  };
}
