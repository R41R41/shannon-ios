import type { ShannonPlace } from '../integrations/places/placeDiscovery.js';
import type { StoredConversationMessage } from '../mind/memory/conversationContract.js';

/**
 * Rich chat (Syzygy ADR-0009 §10, owner decision 2026-10-13; `docs/rich-chat-contract.md`): the report card a finished piece of
 * work the owner asked for leaves in the Talk it came from, and the owner's emoji reactions on messages. Both are for the owner
 * alone: nothing of either reaches a client, a prompt or a log while anyone else may see or hear.
 */

/** The note kind (and `turn_id` prefix) of a report card's message: display history, never an experience. */
export const REPORT_CARD_NOTE_KIND = 'research-report';

export interface ReportCardFinding { text: string; sources: Array<{ title: string; url: string }> }

/** What a report card carries, persisted with its message (`metadata_json.reportCard`), so it outlives the hour in 「いま」. */
export interface ReportCard {
  version: 1;
  taskId: string;
  reportId: string;
  /** The task's title: what the owner asked for. */
  title: string;
  status: 'completed' | 'failed';
  /** The short answer: the report's spoken form, or a plain cut of it. Also the message's content. */
  answer: string;
  /** The full report, Markdown, as the screen shows it. */
  report: string;
  findings: ReportCardFinding[];
  places?: ShannonPlace[];
  reportedAt: string;
}

/** A report card's message as it is written: the card, when, and the task's sources (so the replay withholds it when one is forgotten). */
export interface ReportCardNote { card: ReportCard; observedAt: string; recalledMemoryIds: readonly string[] }

export const REPORT_CARD_LIMITS = Object.freeze({ title: 160, answer: 400, report: 2000, findings: 4, findingText: 600, sources: 4 });

const ID = /^[A-Za-z0-9_.:-]{1,320}$/u;

function webUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password;
  } catch { return false; }
}

function validPlace(place: ShannonPlace | null | undefined): place is ShannonPlace {
  return Boolean(place) && typeof place!.name === 'string' && typeof place!.address === 'string' && typeof place!.reason === 'string'
    && typeof place!.mapQuery === 'string' && webUrl(place!.mapUrl);
}

function validFinding(finding: ReportCardFinding | null | undefined): ReportCardFinding[] {
  if (!finding || typeof finding !== 'object' || typeof finding.text !== 'string' || !Array.isArray(finding.sources)) return [];
  const sources = finding.sources.filter(source => source && typeof source.title === 'string' && webUrl(source.url))
    .slice(0, REPORT_CARD_LIMITS.sources).map(source => ({ title: source.title.slice(0, 200), url: source.url }));
  return [{ text: finding.text.slice(0, REPORT_CARD_LIMITS.findingText), sources }];
}

type CardHeader = Pick<ReportCard, 'taskId' | 'reportId' | 'title' | 'answer' | 'report' | 'status' | 'reportedAt'>;
function cardHeader(row: Partial<ReportCard>): row is Partial<ReportCard> & CardHeader {
  const ids = typeof row.taskId === 'string' && ID.test(row.taskId) && typeof row.reportId === 'string' && ID.test(row.reportId);
  const texts = typeof row.title === 'string' && typeof row.answer === 'string' && typeof row.report === 'string' && Boolean(row.report.trim());
  const time = typeof row.reportedAt === 'string' && Number.isFinite(Date.parse(row.reportedAt));
  return row.version === 1 && ids && texts && time && (row.status === 'completed' || row.status === 'failed');
}

/** A stored or built card, bounded and closed; anything else is not a card. */
export function validatedReportCard(value: unknown): ReportCard | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Partial<ReportCard>;
  if (!cardHeader(row)) return null;
  const findings = Array.isArray(row.findings) ? row.findings.flatMap(validFinding).slice(0, REPORT_CARD_LIMITS.findings) : [];
  const places = Array.isArray(row.places) ? row.places.filter(validPlace).slice(0, 8) : [];
  return {
    version: 1, taskId: row.taskId, reportId: row.reportId, title: row.title.slice(0, REPORT_CARD_LIMITS.title), status: row.status,
    answer: row.answer.slice(0, REPORT_CARD_LIMITS.answer), report: row.report.slice(0, REPORT_CARD_LIMITS.report), findings,
    ...(places.length ? { places: places.map(({ name, address, reason, mapQuery, mapUrl }) => ({ name, address, reason, mapQuery, mapUrl })) } : {}),
    reportedAt: row.reportedAt,
  };
}

/** Quick reactions offered first (Discord-style); any single emoji is accepted. */
export const QUICK_REACTIONS = Object.freeze(['❤️', '😂', '👍', '😮', '🥲', '🙏'] as const);
/** Distinct emoji one message may carry. */
export const MAXIMUM_REACTIONS_PER_MESSAGE = 20;

const SEGMENTER = new Intl.Segmenter('ja', { granularity: 'grapheme' });
const PICTOGRAPH = /[\p{Extended_Pictographic}\p{Regional_Indicator}]/u;
/** Pictographs and what joins or modifies them: variation selectors, skin tones, the joiner, the keycap mark, tag characters. */
const EMOJI_PARTS = /[\p{Extended_Pictographic}\p{Regional_Indicator}\u{1F3FB}-\u{1F3FF}\u{FE0E}\u{FE0F}\u{200D}\u{20E3}\u{E0020}-\u{E007F}]/gu;
/** One emoji grapheme (with its variation selector, skin tone or joiner sequence); never text, a URL or markup. */
export function isReactionEmoji(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.length > 32) return false;
  return [...SEGMENTER.segment(value)].length === 1 && PICTOGRAPH.test(value) && value.replace(EMOJI_PARTS, '') === '';
}

/**
 * What a reaction says for learning (owner decision 2026-10-13): ❤️ 👍 😂 🙏 good, 🥲 (and the old 👎) bad, 😮 and any other
 * emoji neutral. 👍 and 👎 are the existing 「役立った・いまひとつ」 (`/v1/feedback`).
 */
export function reactionValence(emoji: string): 'good' | 'bad' | 'neutral' {
  const bare = emoji.replace(/[\u{1F3FB}-\u{1F3FF}\u{FE0F}]/gu, '');
  if (['❤', '👍', '😂', '🙏'].includes(bare)) return 'good';
  if (['🥲', '👎'].includes(bare)) return 'bad';
  return 'neutral';
}

/** The feedback a set of reactions maps to: more good than bad is good, more bad than good is bad, otherwise none. */
export function reactionFeedback(emojis: readonly string[]): 'good' | 'bad' | null {
  const values = emojis.map(reactionValence);
  const score = values.filter(value => value === 'good').length - values.filter(value => value === 'bad').length;
  return score > 0 ? 'good' : score < 0 ? 'bad' : null;
}

export interface MessageReactionView { messageId: string; emojis: string[] }

/** The read side the conversation route and a text turn use. Absent: no report card and no reaction reaches anyone. */
export interface ConversationExtrasPorts {
  /**
   * The Talk as the owner's app reads it: report-card notes only while the owner is alone and their task is still visible to him
   * (a forgotten source hides the card), and each message's reactions while he is alone. Never adds a message.
   */
  project(scopeKey: string, threadId: string, messages: readonly StoredConversationMessage[], ownerAlone: boolean): readonly StoredConversationMessage[];
  /** A short block for her next text turn: reactions the owner added to her messages lately. Empty when none or not alone. */
  turnContext(scopeKey: string, threadId: string, ownerAlone: boolean): string;
}

/** Her text turn's line about reactions: only a turn of the owner's alone in the app's own Talk (no other surface), never throws. */
export function reactionTurnLine(ports: ConversationExtrasPorts | null, turn: {
  scopeKey: string; threadId: string; alone: boolean; surface?: unknown; ownerAlone(): boolean;
}): string {
  if (!ports || turn.surface || !turn.alone) return '';
  try { return ports.turnContext(turn.scopeKey, turn.threadId, turn.ownerAlone() === true); } catch { return ''; }
}

/** Without the ports the report-card notes are left out and no message carries a card (fail closed). */
export function withoutReportCards(messages: readonly StoredConversationMessage[]): readonly StoredConversationMessage[] {
  return Object.freeze(messages.flatMap(message => {
    if (message.reportCard || message.sourceExperienceId?.startsWith(`${REPORT_CARD_NOTE_KIND}:`)) return [];
    const { reactions: _reactions, ...plain } = message;
    return [Object.freeze(plain)];
  }));
}
