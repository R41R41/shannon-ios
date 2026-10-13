import { DEVICE_ACTION_KINDS, type DeviceActionKind, type DeviceActionReport, type DeviceActionView } from '../../../src/contracts/deviceActionContract.js';
import type { DeviceActions } from '../../../src/surfaces/device/deviceActions.js';
import type { CalendarFixtureEvent, InitialState } from '../types.js';
import { localInstant, localOf } from './clock.js';

/**
 * The owner's iPhone as the device-action outbox sees it (`docs/device-actions-contract.md`): it polls like the app, does each
 * action on a fake EventKit/timer/music state, and reports once. The state is what the graders read: a reminder, a timer or an
 * event exists only if Shannon actually asked the device for it.
 */
export interface FakeCalendarEvent extends CalendarFixtureEvent { seeded: boolean }
export interface FakeDeviceState {
  reminders: { id: string; title: string; dueAt: string | null; dueLocal: string | null }[];
  timers: { id: string; seconds: number; fireAt: string; label: string | null }[];
  calendar: FakeCalendarEvent[];
  music: { played: { title: string; artist?: string }[]; controls: string[] };
  /** Every action the device was handed, in order, with what it reported. */
  actions: { kind: DeviceActionKind; payload: Readonly<Record<string, unknown>>; status: string; at: string }[];
}

const DEVICE_ID = 'eval-iphone';
const text = (value: unknown) => typeof value === 'string' ? value : '';

export function seededDeviceState(initial: InitialState): FakeDeviceState {
  const timeZone = initial.timeZone ?? 'Asia/Tokyo';
  return {
    reminders: (initial.reminders ?? []).map((reminder, index) => ({ id: `seed-reminder-${index}`, title: reminder.title,
      dueAt: new Date(localInstant(reminder.due, timeZone)).toISOString(), dueLocal: reminder.due })),
    timers: [],
    calendar: (initial.calendar ?? []).map(event => ({ ...event, seeded: true })),
    music: { played: [], controls: [] },
    actions: [],
  };
}

function localStart(value: string, timeZone: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/u.test(value)) return value;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/u.test(value) && !/[zZ]|[+-]\d{2}:?\d{2}$/u.test(value)) return value.slice(0, 16);
  const instant = Date.parse(value);
  return Number.isFinite(instant) ? localOf(instant, timeZone) : value;
}

function perform(state: FakeDeviceState, action: DeviceActionView, initial: InitialState): DeviceActionReport {
  const timeZone = initial.timeZone ?? 'Asia/Tokyo', payload = action.payload;
  switch (action.kind) {
    case 'reminder.create': {
      const dueAt = text(payload.dueAt) || (text(payload.due) ? new Date(localInstant(text(payload.due).slice(0, 16), timeZone)).toISOString() : '');
      const id = `reminder-${state.reminders.length + 1}`;
      state.reminders.push({ id, title: text(payload.title), dueAt: dueAt || null, dueLocal: dueAt ? localOf(dueAt, timeZone) : null });
      return { status: 'done', result: { id } };
    }
    case 'timer.start': {
      const seconds = Number(payload.seconds), fireAt = text(payload.fireAt);
      if (!Number.isFinite(seconds) || !fireAt) return { status: 'failed', code: 'invalid' };
      state.timers.push({ id: `timer-${state.timers.length + 1}`, seconds, fireAt, label: text(payload.label) || null });
      return { status: 'done', result: { fireAt } };
    }
    case 'calendar.create_event': {
      const start = localStart(text(payload.start), timeZone), allDay = payload.allDay === true;
      const minutes = Number(payload.durationMinutes) > 0 ? Number(payload.durationMinutes) : 60;
      const end = text(payload.end) ? localStart(text(payload.end), timeZone)
        : allDay ? start : localOf(localInstant(start, timeZone) + minutes * 60_000, timeZone);
      const id = `event-${state.calendar.length + 1}`;
      state.calendar.push({ id, title: text(payload.title), start, end, allDay, ...(text(payload.location) ? { location: text(payload.location) } : {}), seeded: false });
      return { status: 'done', result: { id } };
    }
    case 'music.search': case 'music.recent': {
      const library = initial.music?.library ?? [];
      const items = library.map(item => ({ id: item.id, type: 'song', title: item.title, artist: item.artist, source: 'library' }));
      return { status: 'done', result: action.kind === 'music.search' ? { items } : { recent: items, heavyRotation: [], playlists: [], recommendations: [] } };
    }
    case 'music.play': {
      const item = (initial.music?.library ?? []).find(song => song.id === payload.itemId) ?? (initial.music?.library ?? [])[0];
      if (!item) return { status: 'failed', code: 'not_found' };
      state.music.played.push({ title: item.title, artist: item.artist });
      return { status: 'done', result: { title: item.title, artist: item.artist, itemId: item.id } };
    }
    case 'music.control':
      state.music.controls.push(text(payload.action));
      return { status: 'done', result: { action: text(payload.action) } };
    default:
      return { status: 'failed', code: 'unsupported' };
  }
}

/** Starts the device's poll loop (long polls, like the app in front during a call). `stop` ends it. */
export function startFakeDevice(actions: DeviceActions, scopeKey: string, initial: InitialState, state: FakeDeviceState, options: {
  inCall: boolean; onChange?: () => void; log?: (line: string) => void;
}): { stop(): Promise<void> } {
  const controller = new AbortController();
  const loop = (async () => {
    while (!controller.signal.aborted) {
      try {
        const handed = await actions.poll(scopeKey, DEVICE_ID, { platform: 'ios', foreground: true, inCall: options.inCall,
          kinds: DEVICE_ACTION_KINDS, wait: true }, controller.signal);
        for (const action of handed) {
          const report = perform(state, action, initial);
          state.actions.push({ kind: action.kind, payload: action.payload, status: report.status, at: new Date().toISOString() });
          actions.report(scopeKey, DEVICE_ID, action.id, report);
          options.onChange?.();
        }
      } catch (error) {
        if (controller.signal.aborted) break;
        options.log?.(`fake device poll failed: ${error instanceof Error ? error.message : 'unknown'}`);
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }
  })();
  return { async stop() { controller.abort(); await loop.catch(() => {}); } };
}

export const FAKE_DEVICE_ID = DEVICE_ID;
