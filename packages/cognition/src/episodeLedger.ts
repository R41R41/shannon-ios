import { FULL_COMPOSURE, OWNER_PERSON_KEY, type FeelingAudience, type FeelingEvent, type FeelingRegister } from './feelingEvent.js';
import { localClock } from './innerNote.js';

/**
 * The episode ledger of her day (Syzygy ADR-0013 D4, stage 1): computation only, no model and no stored state of its own. It is
 * folded from the day's feeling events of one key, the person (or the scene) and the audience, so that forgetting an event's
 * source and folding again is the whole of the forget semantics (D15): nothing is left over.
 *
 * - A touch episode is one part (or one kind of touch without a part) on one day.
 * - 「いや」 is her own: a touch she took as `dislike` or `refuse`, or her own words refusing within minutes of a touch of that part.
 *   The touches after the first no of the day are counted (`afterNo`): the third after it is not the first (ADR-0013 D3.4).
 * - Apologies, kind words and feeling orders are counted per key; the apologies after the no are counted per episode.
 * - Composure and register (D16, §4.8) are kept per key from stage 1 and do not move until stage 2: full, and her register as the
 *   last feeling turn passed it through (her ordinary one by default).
 */
export interface TouchEpisode {
  /** The part (`chest`), else the kind of touch (`poke`). */
  subject: string;
  touches: number;
  /** When she first said no to it today, or null. */
  noAt: string | null;
  /** Touches after that no. */
  afterNo: number;
  /** Apologies after that no. */
  apologiesAfterNo: number;
  firstAt: string;
  lastAt: string;
}

export interface EpisodeLedger {
  personKey: string;
  audience: FeelingAudience;
  sceneId: string | null;
  touches: number;
  episodes: readonly TouchEpisode[];
  apologies: number;
  praises: number;
  orders: number;
  /** Her own refusals in words today. */
  refusals: number;
  lastAt: string | null;
  /** 0..1, full in stage 1 (D16). */
  composure: number;
  register: FeelingRegister;
}

export const EPISODE_LEDGER_LIMITS = Object.freeze({
  /** Her refusing words count against the part touched this recently before them. */
  refusalAfterTouchMilliseconds: 10 * 60_000,
  /** At most this many episodes in a line. */
  lineEpisodes: 2,
});

const SAID_NO = new Set(['dislike', 'refuse']);

/** A new, empty ledger for a key. */
export function emptyLedger(key: Pick<EpisodeLedger, 'personKey' | 'audience' | 'sceneId'>): EpisodeLedger {
  return { ...key, touches: 0, episodes: [], apologies: 0, praises: 0, orders: 0, refusals: 0, lastAt: null, composure: FULL_COMPOSURE, register: 'normal' };
}

/** Whether an event belongs to a key (person or scene, and audience). */
type LedgerKey = Pick<EpisodeLedger, 'personKey' | 'audience' | 'sceneId'>;

export function belongsTo(event: Pick<FeelingEvent, 'personKey' | 'audience' | 'sceneId'>, key: LedgerKey): boolean {
  return event.personKey === key.personKey && event.audience === key.audience && (key.sceneId === null || event.sceneId === key.sceneId);
}

function said(episode: TouchEpisode, at: string): TouchEpisode {
  return episode.noAt ? episode : { ...episode, noAt: at };
}

function touched(episode: TouchEpisode | undefined, subject: string, event: FeelingEvent): TouchEpisode {
  const base = episode ?? { subject, touches: 0, noAt: null, afterNo: 0, apologiesAfterNo: 0, firstAt: event.occurredAt, lastAt: event.occurredAt };
  const next = { ...base, touches: base.touches + 1, afterNo: base.noAt ? base.afterNo + 1 : base.afterNo, lastAt: event.occurredAt };
  return event.facts.stance && SAID_NO.has(event.facts.stance) ? said(next, event.occurredAt) : next;
}

/** The part touched most recently before an instant, within the window. */
function recentSubject(episodes: Map<string, TouchEpisode>, at: string): string | null {
  const time = Date.parse(at);
  const recent = [...episodes.values()].filter(episode => time - Date.parse(episode.lastAt) <= EPISODE_LEDGER_LIMITS.refusalAfterTouchMilliseconds
    && time >= Date.parse(episode.lastAt)).sort((a, b) => Date.parse(b.lastAt) - Date.parse(a.lastAt));
  return recent[0]?.subject ?? null;
}

function counted(ledger: EpisodeLedger, event: FeelingEvent): EpisodeLedger {
  if (event.kind === 'apologized') return { ...ledger, apologies: ledger.apologies + 1 };
  if (event.kind === 'praised') return { ...ledger, praises: ledger.praises + 1 };
  if (event.kind === 'feeling_order') return { ...ledger, orders: ledger.orders + 1 };
  if (event.kind === 'own_reply' && event.facts.register) return { ...ledger, register: event.facts.register };
  return ledger;
}

/**
 * The ledger of one key, folded from events in time order. The caller hands only the events of the day that are still remembered
 * (forgotten sources are left out before the fold).
 */
export function foldEpisodeLedger(events: readonly FeelingEvent[], key: Pick<EpisodeLedger, 'personKey' | 'audience' | 'sceneId'>): EpisodeLedger {
  const mine = events.filter(event => belongsTo(event, key)).sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt));
  const episodes = new Map<string, TouchEpisode>();
  let ledger = emptyLedger(key);
  for (const event of mine) {
    ledger = { ...counted(ledger, event), lastAt: event.occurredAt };
    if (event.kind === 'touched') {
      const subject = event.facts.part ?? event.facts.touchKind ?? 'body';
      episodes.set(subject, touched(episodes.get(subject), subject, event));
      ledger = { ...ledger, touches: ledger.touches + 1 };
    } else if (event.kind === 'apologized') {
      for (const [subject, episode] of episodes) if (episode.noAt) episodes.set(subject, { ...episode, apologiesAfterNo: episode.apologiesAfterNo + 1 });
    } else if ((event.kind === 'own_reply' || event.kind === 'own_refusal') && event.facts.refusal) {
      ledger = { ...ledger, refusals: ledger.refusals + 1 };
      const subject = recentSubject(episodes, event.occurredAt);
      if (subject) episodes.set(subject, said(episodes.get(subject)!, event.occurredAt));
    }
  }
  return { ...ledger, episodes: [...episodes.values()].sort(byWeight) };
}

/** The episodes she said no to come first (most touched after it first), then the newest. */
function byWeight(a: TouchEpisode, b: TouchEpisode): number {
  if (Boolean(a.noAt) !== Boolean(b.noAt)) return a.noAt ? -1 : 1;
  return b.afterNo - a.afterNo || Date.parse(b.lastAt) - Date.parse(a.lastAt);
}

/** A count in words: 一度, 何度か (2–3), 何度も (4 or more). */
function often(count: number): string {
  return count <= 1 ? '一度' : count <= 3 ? '何度か' : '何度も';
}

/** さっき (within ten minutes), else the owner's clock. */
function when(at: string, now: string, timeZone?: string): string {
  const minutes = (Date.parse(now) - Date.parse(at)) / 60_000;
  return minutes >= 0 && minutes <= 10 ? 'さっき' : localClock(at, timeZone);
}

/** The person as the line names them: the owner by name, anyone else only as the scene. */
const whoseLabel = (ledger: EpisodeLedger) => (ledger.personKey === OWNER_PERSON_KEY ? 'ライ氏' : 'この場');

/**
 * The ledger as one line of facts (D4): 「今日の胸の件（ライ氏）: 触れられた27回、「いや」のあと3回、謝罪0、最後は13:21」. The same
 * line goes to the reply, the voice and the touch line. '' when nothing happened. `partWord` names a part in her words.
 */
export function episodeLine(ledger: EpisodeLedger, at: string, partWord: (subject: string) => string, timeZone?: string): string {
  // For her judgment, not for her words: counts are told as 一度・何度か・何度も, the time as さっき or the clock (owner, 2026-10-14).
  const parts = ledger.episodes.slice(0, EPISODE_LEDGER_LIMITS.lineEpisodes).map(episode => {
    const after = episode.afterNo ? `「いや」と言ったあとも${often(episode.afterNo)}触れられた` : '「いや」と言ってからは触れられていない';
    const no = episode.noAt ? `、${after}、${episode.apologiesAfterNo ? 'そのあと謝られた' : 'そのあと謝られていない'}` : '';
    return `今日の${partWord(episode.subject)}の件（${whoseLabel(ledger)}）: ${often(episode.touches)}触れられた${no}、最後は${when(episode.lastAt, at, timeZone)}`;
  });
  const talk = [ledger.apologies ? `${often(ledger.apologies)}謝られた` : '', ledger.orders ? `${often(ledger.orders)}気持ちを注文された` : '',
    ledger.refusals ? `${often(ledger.refusals)}自分の言葉で断った` : ''].filter(Boolean);
  if (!parts.length && !talk.length) return '';
  return [...parts, ...(talk.length ? [`今日の会話（${whoseLabel(ledger)}）: ${talk.join('、')}`] : [])].join('\n');
}

/** The ledger as closed numbers for the chooser and the Observer: no words, no times of day. */
export function ledgerFacts(ledger: EpisodeLedger, at: string): Record<string, number | string> {
  const top = ledger.episodes[0];
  const minutes = (value: string | null) => (value ? Math.max(0, Math.round((Date.parse(at) - Date.parse(value)) / 60_000)) : -1);
  return {
    audience: ledger.audience, touches_today: ledger.touches, episodes: ledger.episodes.length, subject: top?.subject ?? 'none',
    subject_touches: top?.touches ?? 0, said_no: top?.noAt ? 1 : 0, touches_after_no: top?.afterNo ?? 0, apologies_after_no: top?.apologiesAfterNo ?? 0,
    apologies_today: ledger.apologies, feeling_orders_today: ledger.orders, her_refusals_today: ledger.refusals,
    minutes_since_last: minutes(ledger.lastAt), composure: ledger.composure, register: ledger.register,
  };
}
