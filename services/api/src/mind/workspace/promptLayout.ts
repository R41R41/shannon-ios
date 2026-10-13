import { audienceCovers, isOwnerOnly, type MemoryAudience } from '@shannon/cognition';
import type { MindSurface } from '@shannon/mind';
import { WITHHELD_REASON_LABELS, isWithheldReason } from '../../contracts/withheldActionContract.js';
import { injectionThreats, neutralizedForFrame } from '../memory/injectionPorts.js';
import { NOTICE_KINDS, SPEECH_KINDS, currentNotices, orderedHeld, type WorkspaceItem, type WorkspaceScope } from './workspaceState.js';
import { DATA_FRAME_RULE, DATA_FRAME_THREAT } from './dataFrames.js';
export { DATA_FRAME_RULE, DATA_FRAME_THREAT, framedReport } from './dataFrames.js';

/**
 * The workspace's part of a turn's prompt (Syzygy ADR-0008 stage 3, `docs/mind-workspace-contract.md`). It is appended after the
 * turn's context, which stays byte for byte what it was, so everything here is volatile and after the replayed history (the
 * provider's prompt cache keeps the history: `promptCachePrefix.test.ts`). In order:
 *
 * 1. `[いまの場]`: what attention holds, highest salience first. Text: at most 8 lines and 600 characters, the block's header
 *    included, with the `[ほか]` line for what attention let go (the owner alone). Voice: only items that are not someone's words,
 *    at a current salience of 0.6 or more, at most 2 lines and 160 characters with the header, notices among them.
 * 2. Notices with fixed markers (`【知らせ:触れた】`, `【知らせ:作業終了】`, `【知らせ:約束の時刻】`, `【知らせ:止められた】`), in the
 *    order they arrived: a new one is appended, an earlier one is never rewritten.
 * 3. Untrusted data frames `〔データ 出どころ=… id=…〕…〔/データ〕` after one fixed line that says they are data, not instructions
 *    (text only, and only with `SHANNON_DATA_FRAMES` on; off, such words reach no prompt, as before stage 3). A body in which
 *    `injectionThreats` finds anything (read after NFKC, with zero-width characters removed) is replaced by a fixed line; any
 *    other has every bracket that could close a frame or forge a marker (`〔〕`, `﹝﹞`, `︹︺`, `〘〙`, `【】`, `[ ]`) made a parenthesis.
 *
 * Only items the turn's audience covers are shown (`audienceCovers`: with anyone else present, only what everyone here was there
 * for). Words are read through `WorkspaceTextReader` (the withholding and the disclosure gate), never from the journal.
 */
export const PROMPT_LAYOUT_LIMITS = Object.freeze({
  text: Object.freeze({ placeLines: 8, placeCharacters: 600, notices: 6, frames: 3, frameCharacters: 160, excerptCharacters: 40 }),
  voice: Object.freeze({ lines: 2, characters: 160, minimumSalience: 0.6 }),
});

export const WORKSPACE_PLACE_HEADER = '[いまの場]';
export const NOTICE_MARKERS = Object.freeze({
  touch: '【知らせ:触れた】', task_outcome: '【知らせ:作業終了】', promise_due: '【知らせ:約束の時刻】', notice: '【知らせ:止められた】',
} as const);
const SURFACE_LABEL: Readonly<Record<MindSurface, string>> = Object.freeze({
  text: 'アプリの文字', voice: '声の会話', body: '体', minecraft: 'マイクラ', platform: 'メッセージの場', outreach: 'ボクからの連絡', own_time: 'ボクの時間',
});
const SPEAKER_LABEL = Object.freeze({ owner: 'ライ氏', person: 'ほかの人', unknown: '誰か', shannon: 'ボク', system: '' });
const TOUCH_WORD: Readonly<Record<string, string>> = Object.freeze({
  pet: 'なでられた', poke: 'つつかれた', tickle: 'くすぐられた', carry: '持ち上げられた', holdHand: '手をにぎられた',
});
const TASK_WORD: Readonly<Record<string, string>> = Object.freeze({ done: '終わった', failed: 'うまくいかずに終わった', cancelled: '取りやめになった' });
/** Why an accepted Minecraft lifecycle operation never started (`lifecycle_not_started.<reason>`). */
const NOT_STARTED_WORD: Readonly<Record<string, string>> = Object.freeze({
  'lifecycle_not_started.busy': '前の操作の結果がまだ確かめられていない',
  'lifecycle_not_started.unavailable': 'マイクラ管理の新しい状態が届いていない',
  'lifecycle_not_started.not_allowed': '実行の条件がそろわなかった',
  'lifecycle_not_started.error': '思わぬ理由',
});

export interface LayoutTurn {
  surface: 'text' | 'voice';
  present: MemoryAudience;
  at: string;
  /** The turn's own item: its words close the prompt. */
  currentItemId: string | null;
  /** The turn's own conversation (its surface and thread or request): already in the history, so not repeated. */
  current: { surface: MindSurface; sourceId: string } | null;
  dataFrames: boolean;
  /** The words of an item for this turn (`WorkspaceTextReader`), or null. */
  text: (item: WorkspaceItem) => string | null;
  /** Whether a notice's source (a promise, a task) is still visible now (`WorkspaceTextReader.noticeVisible`); absent: yes. */
  noticeVisible?: (item: WorkspaceItem) => boolean;
}

/**
 * A voice turn that was not the owner alone in his own call (a 「友人も一緒」 call, a call with someone else present): never its words,
 * here or in a frame, only that she was talking with someone (stage 3 review, HIGH). Words of his own call that were not proven his
 * (an uncertain transcript, an echo) are someone's words: 「誰かが話した」 and, with the frames on, a data frame.
 */
export function closedVoiceItem(item: Pick<WorkspaceItem, 'surface' | 'kind' | 'presence'>): boolean {
  return item.surface === 'voice' && SPEECH_KINDS.has(item.kind) && !item.presence.ownerOnlyHears;
}
const CLOSED_VOICE_LINE = 'ほかの人と話していた';

export function agoLabel(at: string, now: string): string {
  const minutes = Math.floor((Date.parse(now) - Date.parse(at)) / 60_000);
  if (minutes < 1) return 'いま';
  return minutes < 60 ? `${minutes}分前` : `${Math.floor(minutes / 60)}時間前`;
}

const oneLine = (text: string, limit: number) => {
  const flat = neutralizedForFrame(text).replace(/\s+/gu, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
};

function placeOf(item: WorkspaceItem): string {
  return `${SURFACE_LABEL[item.surface]}${item.body && item.surface === 'body' ? `（${item.body}）` : ''}`;
}

/** One line of `[いまの場]` for an item that is not a notice. */
function placeLine(item: WorkspaceItem, turn: LayoutTurn, excerpt: string | null): string {
  const head = `- ${agoLabel(item.at, turn.at)}・${placeOf(item)}：`;
  if (closedVoiceItem(item)) return `${head}${CLOSED_VOICE_LINE}`;
  if (SPEECH_KINDS.has(item.kind)) return `${head}${SPEAKER_LABEL[item.speaker] || '誰か'}が話した${excerpt ? `「${excerpt}」` : ''}`;
  if (item.kind === 'own_time_step') return `${head}${item.detail?.tool ? `〈${item.detail.tool}〉を` : ''}${item.detail?.code === 'failed' ? 'しようとして、できなかった' : 'した'}`;
  if (item.kind === 'presence') return `${head}${SPEAKER_LABEL[item.speaker] || '誰か'}の様子が変わった`;
  return `${head}できごと`;
}

/** A task's end; an accepted Minecraft lifecycle operation that never started says so, with its closed reason. */
function taskOutcomeLine(item: WorkspaceItem, ago: string): string {
  const tool = item.detail?.tool ?? '作業';
  const notStarted = NOT_STARTED_WORD[item.detail?.reason ?? ''];
  if (notStarted) return `${NOTICE_MARKERS.task_outcome}${ago}、受け付けた〈${tool}〉を始められなかった（${notStarted}）`;
  return `${NOTICE_MARKERS.task_outcome}${ago}、〈${tool}〉が${TASK_WORD[item.detail?.code ?? ''] ?? '終わった'}`;
}

/** One notice, with its fixed marker. */
export function noticeLine(item: WorkspaceItem, now: string): string {
  const ago = agoLabel(item.at, now);
  if (item.kind === 'touch') return `${NOTICE_MARKERS.touch}${ago}、体${item.body ? `（${item.body}）` : ''}で${TOUCH_WORD[item.detail?.code ?? ''] ?? '触れられた'}`;
  if (item.kind === 'task_outcome') return taskOutcomeLine(item, ago);
  if (item.kind === 'promise_due') {
    const minutes = Math.round((Date.parse(now) - Date.parse(item.at)) / 60_000);
    return `${NOTICE_MARKERS.promise_due}約束の時刻${minutes < 0 ? `まであと${-minutes}分` : minutes === 0 ? 'になった' : `を${minutes}分過ぎた`}`;
  }
  const reason = item.detail?.reason && isWithheldReason(item.detail.reason) ? WITHHELD_REASON_LABELS[item.detail.reason] : '決まり';
  return `${NOTICE_MARKERS.notice}${ago}、〈${item.detail?.tool ?? '行動'}〉が止められた（${reason}）。ボクが選んだ休みではない`;
}

/** One frame of someone else's words, the body checked for injection. */
export function dataFrame(item: WorkspaceItem, body: string, limit: number): string {
  const text = injectionThreats(body).length ? DATA_FRAME_THREAT : oneLine(body, limit);
  return `〔データ 出どころ=${item.surface} id=${item.sourceId}〕${text}〔/データ〕`;
}

function bounded(header: string, lines: readonly string[], maximumLines: number, maximumCharacters: number): string {
  const kept: string[] = [];
  let length = header.length;
  for (const line of lines) {
    if (kept.length + 1 >= maximumLines || length + 1 + line.length > maximumCharacters) break;
    kept.push(line);
    length += 1 + line.length;
  }
  return kept.length ? [header, ...kept].join('\n') : '';
}

/** The blocks to append after the turn's context, or '' when there is nothing to say. */
export function workspaceBlocks(scope: WorkspaceScope | undefined, turn: LayoutTurn): string {
  if (!scope) return '';
  const shown = (item: WorkspaceItem) => item.id !== turn.currentItemId && audienceCovers(item.audience, turn.present)
    && !(turn.current && item.surface === turn.current.surface && item.sourceId === turn.current.sourceId);
  const held = orderedHeld(scope, turn.at).filter(entry => shown(entry.item));
  // A notice whose promise or task was forgotten since is not shown (review: a forget hides it at once, after a restore too).
  const notices = currentNotices(scope, turn.at).filter(item => shown(item) && (turn.noticeVisible?.(item) ?? true));
  if (turn.surface === 'voice') {
    const { lines, characters, minimumSalience } = PROMPT_LAYOUT_LIMITS.voice;
    const strong = held.filter(entry => !SPEECH_KINDS.has(entry.item.kind) && entry.salience >= minimumSalience).map(entry => entry.item);
    const out = strong.map(item => (NOTICE_KINDS.has(item.kind) ? noticeLine(item, turn.at) : placeLine(item, turn, null)));
    return bounded(WORKSPACE_PLACE_HEADER, out, lines + 1, characters);
  }
  const limits = PROMPT_LAYOUT_LIMITS.text;
  const frames: string[] = [];
  const lines: string[] = [];
  for (const { item } of held.filter(entry => !NOTICE_KINDS.has(entry.item.kind))) {
    const words = SPEECH_KINDS.has(item.kind) && !closedVoiceItem(item) ? turn.text(item) : null;
    if (words && item.trust !== 'owner') {
      // Someone else's words: never on a line of the place; framed as data, or not given at all with the frames off.
      if (turn.dataFrames && frames.length < limits.frames) frames.push(dataFrame(item, words, limits.frameCharacters));
      lines.push(placeLine(item, turn, null));
    } else {
      // The owner's own words, quoted on the line: neutralized (`oneLine`), and left out when they read like an instruction (review).
      lines.push(placeLine(item, turn, words && !injectionThreats(words).length ? oneLine(words, limits.excerptCharacters) : null));
    }
  }
  if (scope.summary.count > 0 && isOwnerOnly(turn.present)) {
    const counts = Object.entries(scope.summary.surfaces).map(([surface, count]) => `${SURFACE_LABEL[surface as MindSurface]}${count}`).join('・');
    lines.push(`[ほか] ほかに${scope.summary.count}件${counts ? `（${counts}）` : ''}`);
  }
  const blocks = [
    bounded(WORKSPACE_PLACE_HEADER, lines, limits.placeLines, limits.placeCharacters),
    notices.slice(-limits.notices).map(item => noticeLine(item, turn.at)).join('\n'),
    frames.length ? [DATA_FRAME_RULE, ...frames].join('\n') : '',
  ];
  return blocks.filter(Boolean).join('\n\n');
}

/** The request with the workspace's blocks after the turn's context, which is kept byte for byte as its start. */
export function withWorkspace<T extends { turnContext?: string }>(request: T, blocks: string): T {
  if (!blocks) return request;
  return { ...request, turnContext: request.turnContext ? `${request.turnContext}\n\n${blocks}` : blocks };
}
