import type { ShannonPursuit, ShannonPursuitStatus } from '@shannon/cognition';
import { copyableStudyPiece } from './autonomyHostFolderPath.js';
import { AUTONOMY_JOT_MAXIMUM_CHARACTERS } from './autonomyLoopObservePrompts.js';
import { carriesSecret } from './autonomyLoopOwnerContext.js';
import { AUTONOMY_REST_REASON_MAXIMUM_CHARACTERS } from './autonomyLoopSessions.js';
import type { AutonomyPlannedStep } from './autonomyLoopState.js';
import { plannedToolStep } from './autonomyLoopToolStep.js';
import { REACH_OUT_REASONS, type PromptNote, type PromptUpcoming, type ReachOutReason, type ThinkingMaterials } from './autonomyLoopPrompts.js';
import type { SQLiteAutonomyStore } from './autonomyStore.js';
import { STUDY_REACTION_LABEL, STUDY_STATUS_LABEL, type StudyPiece } from './studyStore.js';

/**
 * What the thinking step is given and what it may ask for.
 *
 * `thinkingMaterials` reads only the autonomy store: her pursuits, her study, the pages
 * she read, and reader feedback. `planFromThought` turns the model's reply into steps
 * the loop knows; anything else in the reply is dropped, so a reply can never name an
 * action the loop has no bounded executor for.
 */
export interface ThoughtPursuitChange {
  op: 'add' | 'update';
  kind?: 'question' | 'work';
  id?: string;
  title?: string;
  why?: string;
  status?: Exclude<ShannonPursuitStatus, 'dropped'>;
}

export interface Thought {
  text: string;
  pursuits: readonly ThoughtPursuitChange[];
  steps: readonly AutonomyPlannedStep[];
}

/** A thought with what became of the steps it named. */
export interface ReasonedThought extends Thought {
  /** Steps of the reply that were not taken, each as `<action>.<why>` from closed sets: never a word of the reply. */
  dropped: readonly string[];
  /** How many steps the reply named. */
  asked: number;
}

/** The actions a thinking reply may name. */
export const PLANNABLE_ACTIONS = ['read', 'notion', 'note', 'draft', 'revise', 'ready', 'put_away', 'copy', 'look', 'follow_up', 'jot', 'reach_out', 'call', 'tool'] as const;

export function storyNotes(store: SQLiteAutonomyStore, scopeKey: string, pursuitId?: string, limit = 6, own = false, keep: (piece: StudyPiece) => boolean = () => true): PromptNote[] {
  // What she wrote down after an unanswered message is for her own thinking (`own`), never material for a story or a message.
  const notes = store.study.list(scopeKey).filter(piece => piece.kind === 'note' && piece.status !== 'put_away' && (own || piece.origin !== 'reach_out') && keep(piece));
  // Notes written for the same pursuit come first; the rest follow by recency.
  const ordered = pursuitId ? [...notes.filter(note => note.pursuitId === pursuitId), ...notes.filter(note => note.pursuitId !== pursuitId)] : notes;
  return ordered.slice(0, limit).map(note => ({
    title: note.title, excerpt: note.body, ...(note.sources[0] ? { sourceUrl: note.sources[0].url } : {}),
    // What she saw of the owner's room: the prompt that receives it adds the rule that it is not written into a story as it is.
    ...(note.origin === 'room_look' ? { seen: true as const } : {}),
  }));
}

export function thinkingMaterials(
  store: SQLiteAutonomyStore,
  scopeKey: string,
  input: {
    at: string; localTime: string; remainingYen: number; remainingReads: number; maximumSteps: number;
    readingSeeds: readonly { title: string; url: string }[]; notionAvailable: boolean; folderAvailable?: boolean; lookAvailable?: boolean;
    /** How many more times she may speak up today, while she may at all; the owner's upcoming items come only with it. */
    reachOut?: { remaining: number; upcoming: readonly PromptUpcoming[] } | null;
    /** What she wrote down after an unanswered message is among her notes; only while that mechanism is on. */
    ownNotes?: boolean;
  },
): ThinkingMaterials {
  const pieces = store.study.list(scopeKey);
  const stories = pieces.filter(piece => piece.kind === 'story' && piece.status !== 'put_away');
  return {
    localTime: input.localTime,
    remainingYen: input.remainingYen,
    remainingReads: input.remainingReads,
    maximumSteps: input.maximumSteps,
    pursuits: store.pursuits.list(scopeKey, input.at),
    stories: stories.map(piece => ({
      id: piece.id, title: piece.title, statusLabel: STUDY_STATUS_LABEL[piece.status], version: piece.version,
      characters: piece.body.length, lastChange: store.study.versions(scopeKey, piece.id).at(-1)?.changeNote ?? '',
    })),
    notes: storyNotes(store, scopeKey, undefined, 6, input.ownNotes === true),
    unnotedReadings: store.loop.unnotedReadings(scopeKey).map(reading => ({ id: reading.id, title: reading.title, url: reading.url })),
    feedback: stories.flatMap(piece => store.study.pendingFeedback(scopeKey, piece.id).map(feedback => ({
      pieceId: piece.id, pieceTitle: piece.title, version: feedback.version,
      reactionLabel: STUDY_REACTION_LABEL[feedback.reaction], comment: feedback.comment,
    }))),
    places: [...store.loop.readingLeads(scopeKey), ...input.readingSeeds.filter(seed => !store.loop.wasRead(scopeKey, seed.url))],
    notionAvailable: input.notionAvailable,
    ...(input.folderAvailable ? { folderAvailable: true } : {}),
    ...(input.lookAvailable ? { lookAvailable: true } : {}),
    ...(input.reachOut && input.reachOut.remaining > 0 ? { reachOut: { remaining: input.reachOut.remaining }, upcoming: input.reachOut.upcoming } : {}),
  };
}

/** The reply of the thinking model as bounded, known steps. Unknown actions and unknown ids are dropped. */
export function planFromThought(reply: Record<string, unknown>, known: Parameters<typeof reasonedPlan>[1], bounds: Parameters<typeof reasonedPlan>[2]): Thought {
  const { text, pursuits, steps } = reasonedPlan(reply, known, bounds);
  return { text, pursuits, steps };
}

/** The same, with a closed code for each step of the reply that was not taken. */
export function reasonedPlan(
  reply: Record<string, unknown>,
  known: { pursuits: readonly ShannonPursuit[]; pieces: readonly StudyPiece[]; unnotedReadingIds: readonly string[]; placeUrls?: readonly string[] },
  bounds: {
    maximumSteps: number; maximumReads: number; notionAvailable: boolean; folderAvailable?: boolean; lookAvailable?: boolean; reachOut?: { upcoming: boolean } | null;
    /** She may phone his iPhone now (`autonomyLoopPhoneStep.ts`); `upcoming`: there is an upcoming item a call could be about. */
    call?: { upcoming: boolean } | null;
    /** Thinking again after a message of hers got no answer: the message a second call would follow, while she may make one. */
    followUp?: { originId: string } | null;
    /** A look planned now is taken to find out whether he is there; she thinks again after it. */
    chainLook?: boolean;
    /** She may write down what she thinks about it. */
    jot?: boolean;
    /** In a session `rest` is a step of its own: it closes the session and says when she comes back. */
    session?: boolean;
    /** The registry tools she may call as steps (`autonomyLoopToolStep.ts`); absent or empty, `tool` is not taken. */
    tools?: readonly string[];
    /**
     * Words that must reach nobody but the owner, when her thinking was given his context. Free text of hers that repeats
     * a run of them is dropped: an idea, an aim, a note, a search, a pursuit, her reason for resting. Present (also when
     * empty) it means the thought was made with his context in front of her: then she reads only pages she was shown
     * (a seed, a link she found), because an address she makes up is text sent to a stranger's server.
     */
    secrets?: readonly string[];
  },
): ReasonedThought {
  const own = (value: string | null): string | null => (value && carriesSecret(value, bounds.secrets) ? null : value);
  const pursuitIds = new Set(known.pursuits.map(item => item.id));
  const stories = new Map(known.pieces.filter(piece => piece.kind === 'story' && piece.status !== 'put_away').map(piece => [piece.id, piece]));
  const steps: AutonomyPlannedStep[] = [];
  let reads = 0;
  let pendingReading = known.unnotedReadingIds.length;
  const dropped: string[] = [];
  const stepsAsked = array(reply.steps);
  /** Takes one step of the reply into the plan, or says by a closed code why it cannot be done now. */
  const take = (item: Record<string, unknown> | null, action: string | null): string | null => {
    const pursuitId = string(item?.pursuitId, 80);
    const pursuit = pursuitId && pursuitIds.has(pursuitId) ? { pursuitId } : {};
    const named = string(item?.pieceId, 80);
    // In a session, revising "the story" needs no id while her study holds exactly one draft: she means that one.
    // An id she did write is never replaced, also when it is wrong or not a string: only a missing `pieceId` is filled in,
    // only for `revise`, and only while her one story is a draft.
    const only = stories.size === 1 ? [...stories.values()][0]! : null;
    const pieceId = named ?? (bounds.session && action === 'revise' && only?.status === 'draft' && item !== null && !('pieceId' in item) ? only.id : null);
    if (action === 'read' || (action === 'notion' && bounds.notionAvailable)) {
      if (reads >= bounds.maximumReads) return 'limit';
      if (action === 'read') {
        const url = publicUrl(string(item?.url, 2_000), known.placeUrls ?? [], bounds.secrets !== undefined);
        if (!url) return bounds.secrets !== undefined ? 'not_listed' : 'bad_address';
        if (carriesSecret(readable(url), bounds.secrets)) return 'secret';
        steps.push({ kind: 'read', url, ...pursuit });
      } else {
        const asked = string(item?.query, 200);
        const query = own(asked);
        if (!query) return asked ? 'secret' : 'incomplete';
        steps.push({ kind: 'notion', query, ...pursuit });
      }
      reads += 1;
      pendingReading += 1;
    } else if (action === 'note') {
      if (pendingReading < 1) return 'nothing_read';
      const readingId = string(item?.readingId, 80);
      steps.push({ kind: 'note', ...(readingId && known.unnotedReadingIds.includes(readingId) ? { readingId } : {}) });
      pendingReading -= 1;
    } else if (action === 'draft') {
      steps.push({ kind: 'draft', intent: own(string(item?.idea, 300)) ?? '', ...pursuit });
    } else if (action === 'revise' && pieceId && stories.has(pieceId)) {
      steps.push({ kind: 'revise', pieceId, intent: own(string(item?.aim, 300)) ?? '' });
    } else if (action === 'ready' && pieceId && stories.get(pieceId)?.status === 'draft') {
      steps.push({ kind: 'show', pieceId });
    } else if (action === 'put_away' && pieceId && stories.has(pieceId)) {
      steps.push({ kind: 'put_away', pieceId });
    } else if (action === 'copy' && bounds.folderAvailable) {
      // A named piece must be one she may show; without a name the step takes her newest such piece when it runs.
      if (named && !known.pieces.some(piece => piece.id === named && copyableStudyPiece(piece))) return 'not_copyable';
      steps.push({ kind: 'copy', ...(named ? { pieceId: named } : {}) });
    } else if (action === 'look' && bounds.lookAvailable && !steps.some(step => step.kind === 'look')) {
      // One look in a plan at most; the step checks again that the body is there when it runs.
      steps.push({ kind: 'look', ...(bounds.chainLook ? { chain: true as const } : {}) });
    } else if (action === 'follow_up' && bounds.followUp && !steps.some(step => step.kind === 'reach_out')) {
      // The one second call after the message that got no answer: nothing of the reply but the action survives.
      steps.push({ kind: 'reach_out', reason: 'follow_up', originId: bounds.followUp.originId });
    } else if (action === 'jot' && bounds.jot && !steps.some(step => step.kind === 'jot')) {
      const asked = string(item?.text, AUTONOMY_JOT_MAXIMUM_CHARACTERS);
      const text = own(asked);
      if (!text) return asked ? 'secret' : 'incomplete';
      steps.push({ kind: 'jot', intent: text });
    } else if (action === 'call' && bounds.call && !steps.some(step => step.kind === 'reach_out')) {
      // One in a plan, never beside a message of hers, with a reason from the same closed set. Nothing else of the reply survives.
      const reason = REACH_OUT_REASONS.find(value => value === item?.reason) as ReachOutReason | undefined;
      if (!reason || (reason === 'saw' && !steps.some(step => step.kind === 'look')) || (reason === 'upcoming' && !bounds.call.upcoming)) return 'incomplete';
      steps.push({ kind: 'reach_out', reason, call: true });
    } else if (action === 'tool' && bounds.tools?.length) {
      const planned = plannedToolStep(item, bounds.tools, value => !carriesSecret(value, bounds.secrets));
      if (typeof planned === 'string') return planned;
      steps.push(planned);
    } else if (action === 'reach_out' && bounds.reachOut && !steps.some(step => step.kind === 'reach_out')) {
      // One in a plan, with a reason from the closed set. `saw` needs the look of this plan before it; `upcoming` needs an item to be about.
      const reason = REACH_OUT_REASONS.find(value => value === item?.reason) as ReachOutReason | undefined;
      if (!reason || (reason === 'saw' && !steps.some(step => step.kind === 'look')) || (reason === 'upcoming' && !bounds.reachOut.upcoming)) return 'incomplete';
      steps.push({ kind: 'reach_out', reason });
    } else {
      if (action === 'ready' && pieceId && stories.has(pieceId)) return 'not_draft';
      return action === 'revise' || action === 'ready' || action === 'put_away' ? 'unknown_piece' : 'unavailable';
    }
    return null;
  };
  for (const raw of stepsAsked) {
    const full = steps.length >= bounds.maximumSteps;
    if (full && !bounds.session) break;
    const item = object(raw);
    const action = string(item?.action, 20);
    if (action === 'rest') {
      // In a session her rest is the last step of the plan; whatever she wrote after it is dropped.
      if (bounds.session) {
        const minutes = Number(item?.resumeInMinutes);
        const reason = own(string(item?.reason, AUTONOMY_REST_REASON_MAXIMUM_CHARACTERS));
        steps.push({ kind: 'rest', ...(item?.resumeInMinutes != null && Number.isFinite(minutes) ? { minutes: Math.round(minutes) } : {}), ...(reason ? { intent: reason } : {}) });
      }
      break;
    }
    if (full) continue;
    const why = take(item, action);
    // The action is named only when it is one of hers: anything else the model wrote is not kept.
    if (why && dropped.length < 8) dropped.push(`${PLANNABLE_ACTIONS.find(name => name === action) ?? 'other'}.${why}`);
  }
  const pursuits: ThoughtPursuitChange[] = [];
  for (const raw of array(reply.pursuits)) {
    if (pursuits.length >= 2) break;
    const item = object(raw);
    const why = own(string(item?.why, 400));
    if (item?.op === 'add' && (item.kind === 'question' || item.kind === 'work')) {
      const title = own(string(item.title, 120));
      if (title && why) pursuits.push({ op: 'add', kind: item.kind, title, why });
    } else if (item?.op === 'update') {
      const id = string(item.id, 80);
      const status = item.status === 'active' || item.status === 'resting' || item.status === 'done' ? item.status : undefined;
      if (id && pursuitIds.has(id) && (status || why)) pursuits.push({ op: 'update', id, ...(status ? { status } : {}), ...(why ? { why } : {}) });
    }
  }
  // What she thought goes into her record: with a secret in it, the record says only that she thought.
  return { text: own(string(reply.thought, 240)) ?? '', pursuits, steps, dropped, asked: stepsAsked.length };
}

/** A read is always followed by its note, whatever the plan said. */
export function withNoteAfterReading(remaining: readonly AutonomyPlannedStep[], readingId: string): AutonomyPlannedStep[] {
  const [next, ...rest] = remaining;
  if (next?.kind === 'note') return [{ ...next, readingId }, ...rest];
  return [{ kind: 'note', readingId }, ...remaining];
}

/**
 * A page address the model asked for. One it was shown (a link she found, a seed) is taken as it is.
 * Any other loses its query string and must be short, so an address she makes up cannot carry text out;
 * `shownOnly`: no address she makes up is taken at all.
 */
function publicUrl(value: string | null, shown: readonly string[], shownOnly = false): string | null {
  if (!value) return null;
  if (shown.includes(value)) return value;
  try {
    const url = new URL(value);
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) return null;
    if (shown.includes(url.href)) return url.href;
    if (shownOnly) return null;
    url.search = '';
    url.hash = '';
    return url.href.length <= 300 ? url.href : null;
  } catch {
    return null;
  }
}

/** An address as words, so text hidden in its path is seen. */
function readable(url: string): string {
  try { return decodeURIComponent(url); } catch { return url; }
}

function array(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value.slice(0, 24) : [];
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function string(value: unknown, maximum: number): string | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\s+/gu, ' ').trim();
  return text ? text.slice(0, maximum) : null;
}
