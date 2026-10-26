import { randomBytes } from 'node:crypto';
import type { DeviceActionKind } from '../../contracts/deviceActionContract.js';
import type { StoredDeviceAction } from '../../surfaces/device/store/deviceActionStore.js';
import { instantLocalText, localParts, localTextInstant, upcomingWhen, type UpcomingItem } from '../memory/schedulePorts.js';
import { ownerTimeZone } from '../../infra/time/localDate.js';
import { serverEnvironment } from '../../infra/config/serverEnvironment.js';
import { numberInput, stringInput, type ToolInput } from './shannonToolInput.js';
import { clip, neutralMarkers, type ToolExecutionContext, type ToolExecutor, type ToolRun } from './shannonToolTypes.js';
import { toolFailure, toolOk, type ToolResult } from './shannonTools.js';
import type { DeviceActionToolPort } from './shannonDeviceActionTools.js';

/**
 * Her tools that change or delete an event in the owner's calendar, and undo what she did there (`docs/device-actions-contract.md`,
 * "Changing the calendar"). The owner alone, in a conversation whose words are trusted to write (the registry and the gate).
 *
 * A change happens in two calls. The first makes a proposal: the event as the snapshot has it, what would become of it, and a short
 * id, kept for 15 minutes; nothing reaches a device. The second, with `confirm`, must come in a later turn of the same Talk (the
 * owner's answer to the proposal she showed him) and writes the proposal, exactly as it was shown, to the device-action outbox. The
 * device checks that the event still has the title and times the proposal was made from, and reports what it was before, so that
 * `calendar.undo` can put it back. Undo takes her newest calendar write of the last 24 hours that is not undone yet.
 */
export const CALENDAR_EDIT_KINDS: readonly DeviceActionKind[] = Object.freeze(['calendar.update_event', 'calendar.delete_event']);
const CALENDAR_WRITES: readonly DeviceActionKind[] = Object.freeze(['calendar.create_event', ...CALENDAR_EDIT_KINDS]);
export const CALENDAR_EDIT_LIMITS = Object.freeze({ proposalMilliseconds: 15 * 60_000, proposals: 20, undoHours: 24 });

type Payload = Record<string, unknown>;
type Request = (port: DeviceActionToolPort, kind: DeviceActionKind, payload: Payload, context: ToolExecutionContext, signal?: AbortSignal) => Promise<ToolRun>;
interface Proposal { kind: DeviceActionKind; scopeKey: string; payload: Payload; turnKey?: string; threadId?: string; expiresAt: number }

const OFF = toolFailure('unavailable', '端末に頼む仕組みが、いまのサーバーでは使えない。', { retryable: false });
const OLD_APP = toolFailure('not_offered', 'ライ氏の端末のシャノンのアプリが、予定を変える・消す・戻すことにまだ対応していない。', {
  retryable: false, refusal: { why: 'アプリの更新が要る', wouldWork: 'ライ氏がiPhoneかMacのシャノンのアプリを新しくしたあと' },
});
const NO_TURN = toolFailure('refused', '予定を変える・消すのは、ライ氏との会話の返事の中でだけできる。', {
  retryable: false, refusal: { why: 'ライ氏の確かめを受ける会話の返事ではない', wouldWork: 'ライ氏と話している時に頼まれて' },
});
const words = (input: ToolInput, key: string) => stringInput(input, key)?.replace(/[\u0000-\u001f\u007f]/gu, ' ').trim() ?? '';
const invalid = (problem: string) => toolFailure('invalid_input', `入力が正しくない（${problem}）。`, { retryable: false });
const zone = () => ownerTimeZone(serverEnvironment());

/** The proposals shown to the owner and not yet answered, in this process only: a restart forgets them and she proposes again. */
class Proposals {
  private readonly open = new Map<string, Proposal>();

  add(proposal: Proposal, now: number): string {
    for (const [token, known] of this.open) if (known.expiresAt <= now) this.open.delete(token);
    while (this.open.size >= CALENDAR_EDIT_LIMITS.proposals) this.open.delete(this.open.keys().next().value!);
    const token = randomBytes(3).toString('hex');
    this.open.set(token, proposal);
    return token;
  }

  /** The proposal a confirm names, taken once; or why it cannot be confirmed now (the proposal then stays, unless it is gone). */
  take(token: string, kind: DeviceActionKind, context: ToolExecutionContext, now: number): Proposal | ToolResult {
    const proposal = this.open.get(token);
    if (!proposal || proposal.scopeKey !== context.scopeKey) {
      return toolFailure('not_found', 'その confirm の変更案はない（案は15分で消える）。もう一度案を作ってライ氏に見せる。', { retryable: false });
    }
    if (proposal.expiresAt <= now) {
      this.open.delete(token);
      return toolFailure('conflict', '変更案の期限（15分）が切れた。もう一度案を作ってライ氏に見せる。', { retryable: false });
    }
    const refusal = this.refusal(proposal, kind, context);
    if (refusal) return refusal;
    this.open.delete(token);
    return proposal;
  }

  private refusal(proposal: Proposal, kind: DeviceActionKind, context: ToolExecutionContext): ToolResult | null {
    if (proposal.kind !== kind) return invalid(`その confirm は ${proposal.kind.replace('.', '_')} の案`);
    if (!context.memory.turnKey || proposal.turnKey === context.memory.turnKey) {
      return toolFailure('refused', 'まだライ氏が案に答えていない。案を見せて、次の返事ではいと言われてから confirm で呼ぶ。', {
        retryable: false, refusal: { why: '同じ返事の中では確認にならない', wouldWork: 'ライ氏が案を見て答えた次の返事で' },
      });
    }
    if (proposal.threadId && context.threadId && proposal.threadId !== context.threadId) return invalid('その案は別の会話で作ったもの');
    return null;
  }
}

/** A repeating event's id carries its occurrence (`<id>@<start>`, the app's snapshot); the device wants both parts apart. */
function target(event: UpcomingItem): Payload {
  const suffix = `@${new Date(event.start).toISOString().replace('.000Z', 'Z')}`;
  const id = event.eventId!;
  const eventId = event.recurring && id.endsWith(suffix) ? id.slice(0, -suffix.length) : id;
  return {
    title: event.title, eventId, occurrenceStart: new Date(event.start).toISOString(), ...(event.recurring ? { recurring: true } : {}),
    expect: { title: event.title, start: event.start, end: event.end ?? event.start },
  };
}

/** 「10月28日(水) 14:00〜15:00「定例」＠会議室A（仕事）」 */
function eventLine(event: Pick<UpcomingItem, 'title' | 'start' | 'end' | 'allDay' | 'location' | 'calendar'>, now: string): string {
  const place = event.location ? ` ＠${neutralMarkers(clip(event.location, 60))}` : '';
  return `${upcomingWhen(event, now, zone())}「${neutralMarkers(clip(event.title, 80))}」${place}${event.calendar ? `（${clip(event.calendar, 30)}）` : ''}`;
}

interface Times { startAt: string; endAt: string; allDay: boolean }

const HOUR = 3_600_000;
const plusDay = (at: string) => new Date(Date.parse(at) + 24 * HOUR).toISOString();

/** The new times of an update, from the owner's local words; the event's length is kept when only its start moves. */
function newTimes(event: UpcomingItem, input: ToolInput, now: string): Times | string | null {
  const start = words(input, 'start'), end = words(input, 'end'), minutes = numberInput(input, 'durationMinutes');
  if (!start && !end && minutes === undefined) return null;
  const startAt = start ? localTextInstant(start, zone()) : event.start;
  if (!startAt) return `start は YYYY-MM-DDTHH:mm（終日なら YYYY-MM-DD）で書く。いまは ${instantLocalText(now, zone())}`;
  if (localParts(startAt, zone()).civil < localParts(now, zone()).civil) return `${start || 'その日'} はもう過ぎた日（いまは ${instantLocalText(now, zone())}）`;
  const allDay = start ? start.length === 10 : event.allDay;
  const endAt = newEnd(event, end, minutes, startAt, allDay);
  if (!endAt) return 'end は start と同じ形で書く';
  return Date.parse(endAt) > Date.parse(startAt) ? { startAt, endAt, allDay } : 'end は start より後にする';
}

/** An end the owner named (a last day of an all-day event counts whole), a length, or the event's own length. */
function newEnd(event: UpcomingItem, end: string, minutes: number | undefined, startAt: string, allDay: boolean): string | null {
  if (end) {
    const at = localTextInstant(end, zone());
    return at && allDay ? plusDay(at) : at;
  }
  if (minutes !== undefined) return new Date(Date.parse(startAt) + minutes * 60_000).toISOString();
  const length = Date.parse(event.end ?? event.start) - Date.parse(event.start);
  const kept = allDay === event.allDay && length > 0 ? length : allDay ? 24 * HOUR : HOUR;
  return new Date(Date.parse(startAt) + kept).toISOString();
}

/** The changes an update asks for, and the lines that show them; a string is the problem. */
function updateChanges(event: UpcomingItem, input: ToolInput, now: string): { changes: Payload; lines: string[] } | string {
  const times = newTimes(event, input, now);
  if (typeof times === 'string') return times;
  const changes: Payload = {}, lines: string[] = [];
  if (times) {
    Object.assign(changes, times);
    lines.push(`- 時間: ${upcomingWhen(event, now, zone())} → ${upcomingWhen({ start: times.startAt, end: times.endAt, allDay: times.allDay }, now, zone())}`);
  }
  const fields: ReadonlyArray<[string, string, string | undefined]> = [
    ['title', '題名', event.title], ['location', '場所', event.location], ['calendar', 'カレンダー', event.calendar],
  ];
  for (const [key, label, before] of fields) {
    const value = words(input, key);
    if (!value || value === before) continue;
    changes[key] = value;
    lines.push(`- ${label}: ${neutralMarkers(clip(before ?? '（なし）', 60))} → ${neutralMarkers(clip(value, 60))}`);
  }
  const notes = words(input, 'notes');
  if (notes) {
    changes.notes = notes;
    lines.push(`- メモ: 「${neutralMarkers(clip(notes, 80))}」に置きかえる`);
  }
  return lines.length ? { changes, lines } : '変えるところがない（title・start・end・durationMinutes・location・notes・calendar のどれかを書く）';
}

const ONE_OCCURRENCE = '（繰り返しの予定のうち、この回だけ）';

function proposalText(token: string, kind: DeviceActionKind, lines: readonly string[]): string {
  const tool = kind.replace('.', '_');
  return [
    `まだ何も変えていない。変更案（confirm: ${token}、15分有効）:`, ...lines,
    `ライ氏にこの内容を見せて確かめる。次の返事ではいと言われたら、${tool} を confirm: "${token}" だけで呼ぶ。違う・待ってと言われたら呼ばない。`,
  ].join('\n');
}

/** The event a ref names, or why there is none to change. */
function eventOf(port: DeviceActionToolPort, input: ToolInput, context: ToolExecutionContext, kind: DeviceActionKind): UpcomingItem | ToolResult {
  const ref = words(input, 'ref');
  if (!ref) return invalid('ref がない。schedule_upcoming で探して、結果の「ref: …」を書く');
  if (port.supports && !port.supports(context.scopeKey, kind)) return OLD_APP;
  const event = port.calendarEvent?.(context.scopeKey, ref) ?? null;
  return event ?? toolFailure('not_found', `ref ${clip(ref, 12)} の予定は、いまの予定の写しにない。schedule_upcoming でもう一度探す。`, { retryable: false });
}

function proposeUpdate(port: DeviceActionToolPort, proposals: Proposals, input: ToolInput, context: ToolExecutionContext) {
  const event = eventOf(port, input, context, 'calendar.update_event');
  if ('ok' in event) return event;
  const now = port.now();
  const built = updateChanges(event, input, now);
  if (typeof built === 'string') return invalid(built);
  const lines = [`変える予定: ${eventLine(event, now)}${event.recurring ? ONE_OCCURRENCE : ''}`, ...built.lines];
  return propose(port, proposals, context, 'calendar.update_event', { ...target(event), changes: built.changes }, lines);
}

function proposeDelete(port: DeviceActionToolPort, proposals: Proposals, input: ToolInput, context: ToolExecutionContext) {
  const event = eventOf(port, input, context, 'calendar.delete_event');
  if ('ok' in event) return event;
  const now = port.now();
  const lines = [`消す予定: ${eventLine(event, now)}${event.recurring ? ONE_OCCURRENCE : ''}`, '消したあとも calendar_undo で戻せる。'];
  return propose(port, proposals, context, 'calendar.delete_event', target(event), lines);
}

function propose(port: DeviceActionToolPort, proposals: Proposals, context: ToolExecutionContext, kind: DeviceActionKind, payload: Payload,
  lines: readonly string[]) {
  return { summary: 'ライ氏のカレンダーの変更案を作る。', run: async (): Promise<ToolRun> => {
    const now = Date.parse(port.now());
    const token = proposals.add({ kind, scopeKey: context.scopeKey, payload, expiresAt: now + CALENDAR_EDIT_LIMITS.proposalMilliseconds,
      ...(context.memory.turnKey ? { turnKey: context.memory.turnKey } : {}), ...(context.threadId ? { threadId: context.threadId } : {}) }, now);
    return { result: toolOk(proposalText(token, kind, lines)), record: { summary: '会話の中で、ライ氏のカレンダーの変更案を見せました。', outcome: 'done' } };
  } };
}

function confirmed(port: DeviceActionToolPort, proposals: Proposals, request: Request, kind: DeviceActionKind, token: string, context: ToolExecutionContext) {
  const proposal = proposals.take(token, kind, context, Date.parse(port.now()));
  if ('ok' in proposal) return proposal;
  return { summary: 'ライ氏が確かめたカレンダーの変更を端末に渡す。', run: (signal?: AbortSignal) => request(port, kind, { ...proposal.payload, proposal: token }, context, signal) };
}

const record = (value: unknown): Payload | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Payload : null;

/** What a changed or deleted event was, as the device reported it, in the shape the device takes back; null without it. */
function restoredOf(before: Payload | null, title: string): Payload | null {
  if (!before || typeof before.startAt !== 'string' || typeof before.endAt !== 'string') return null;
  return {
    title: typeof before.title === 'string' ? before.title : title, startAt: before.startAt, endAt: before.endAt, allDay: before.allDay === true,
    location: typeof before.location === 'string' ? before.location : '', notes: typeof before.notes === 'string' ? before.notes : '',
    ...(typeof before.calendar === 'string' ? { calendar: before.calendar } : {}),
  };
}

/** The opposite of one calendar write the device reported, from what it reported; a string is why it cannot be undone. */
export function undoOf(action: StoredDeviceAction): { kind: DeviceActionKind; payload: Payload } | string {
  const result = action.result ?? {};
  const title = typeof action.payload.title === 'string' ? action.payload.title : '';
  if (action.kind === 'calendar.create_event') {
    if (typeof result.id !== 'string') return '入れた予定の id が端末から届いていない';
    return { kind: 'calendar.delete_event', payload: { title, eventId: result.id, idKind: 'item', undoOf: action.id } };
  }
  const restored = restoredOf(record(result.before), title);
  if (!restored) return '元の内容が端末から届いていない';
  if (action.kind === 'calendar.delete_event') return { kind: 'calendar.create_event', payload: { ...restored, undoOf: action.id } };
  const changes = record(action.payload.changes) ?? {};
  return { kind: 'calendar.update_event', payload: {
    title: typeof changes.title === 'string' ? changes.title : title, eventId: typeof result.id === 'string' ? result.id : action.payload.eventId,
    occurrenceStart: record(result.after)?.startAt ?? action.payload.occurrenceStart, changes: restored, undoOf: action.id,
  } };
}

/** Her newest calendar write of the last day that worked and is not undone yet (an undo is never undone again). */
export function lastUndoable(actions: readonly StoredDeviceAction[]): StoredDeviceAction | null {
  const undone = new Set(actions.flatMap(action => typeof action.payload.undoOf === 'string' && action.status !== 'failed' && action.status !== 'denied'
    && action.status !== 'expired' ? [action.payload.undoOf] : []));
  return actions.find(action => CALENDAR_WRITES.includes(action.kind) && action.status === 'done' && typeof action.payload.undoOf !== 'string'
    && !undone.has(action.id)) ?? null;
}

function undo(port: DeviceActionToolPort, request: Request, context: ToolExecutionContext) {
  const since = new Date(Date.parse(port.now()) - CALENDAR_EDIT_LIMITS.undoHours * 3_600_000).toISOString();
  const last = lastUndoable(port.recent?.(context.scopeKey, since) ?? []);
  if (!last) return toolFailure('not_found', 'この24時間に、ボクがカレンダーにして戻せることはない。', { retryable: false });
  const inverse = undoOf(last);
  if (typeof inverse === 'string') return toolFailure('failed', `戻せない（${inverse}）。`, { retryable: false });
  if (port.supports && !port.supports(context.scopeKey, inverse.kind)) return OLD_APP;
  return { summary: 'ボクがカレンダーにしたことを元に戻す。', run: (signal?: AbortSignal) => request(port, inverse.kind, inverse.payload, context, signal) };
}

export function calendarEditExecutors(port: DeviceActionToolPort, request: Request): Readonly<Record<string, ToolExecutor>> {
  const proposals = new Proposals();
  const edit = (kind: DeviceActionKind, propose: typeof proposeUpdate): ToolExecutor => (input, context) => {
    if (!port.available(context.scopeKey)) return OFF;
    // A proposal and its yes are told apart by the owner's turn: without one (no conversation turn) neither can be made.
    if (!context.memory.turnKey) return NO_TURN;
    const token = words(input, 'confirm');
    return token ? confirmed(port, proposals, request, kind, token, context) : propose(port, proposals, input, context);
  };
  return Object.freeze({
    'calendar.update_event': edit('calendar.update_event', proposeUpdate),
    'calendar.delete_event': edit('calendar.delete_event', proposeDelete),
    'calendar.undo': (_input, context) => port.available(context.scopeKey) ? undo(port, request, context) : OFF,
  });
}

/** What she reads when the device reported a calendar write done; null for any other action. */
export function calendarDoneText(action: StoredDeviceAction): string | null {
  if (!CALENDAR_WRITES.includes(action.kind)) return null;
  const title = typeof action.payload.title === 'string' ? `「${neutralMarkers(clip(action.payload.title, 80))}」` : '';
  if (typeof action.payload.undoOf === 'string') return `元に戻した（端末で確認済み）: ${title}`;
  if (action.kind === 'calendar.delete_event') return `カレンダーから消した（端末で確認済み）: ${title}。calendar_undo で戻せる。`;
  if (action.kind === 'calendar.update_event') return `カレンダーの予定を変えた（端末で確認済み）: ${title}。calendar_undo で戻せる。`;
  const start = typeof action.payload.start === 'string' ? ` ${clip(action.payload.start, 16)}` : '';
  return `カレンダーに入れた（端末で確認済み）: ${title}${start}`;
}

