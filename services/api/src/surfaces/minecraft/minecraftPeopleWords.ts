/**
 * The words of a person that reach a Minecraft task, as the heads read them: the head that decides each hand (the task's inbox), and the strong model that
 * makes the first plan and the plans again. Before this the deciding head saw only the voice's rewrite of the words (`goal`, 120 characters: 「寝ずに」 and
 * 「次の夜」 were gone), no time and no place, and the strong model saw no words at all. Now the line says who spoke, what they said (the words as spoken),
 * when, and where they stood in the game when that is known, and the strong model is shown the last of them beside the plan.
 *
 * These are facts for the heads' judgment. Nothing here reads a phrase, and nobody's words weigh more for who said them: the words are taken or not by what
 * they say and why (`PERSON_WORDS_LINES`).
 */

/** Where the speaker stood in the game: a point, or already words. */
export type SpeakerPos = string | { x: number; y: number; z: number; dimension?: string };

/** What the voice route gives of a spoken line beside the intent's goal; every field may be missing (the form before these fields). */
export interface SpokenFields {
  /** The words as the person said them. */
  speakerWords?: string | undefined;
  /** When they said it (ISO). */
  spokenAt?: string | undefined;
  /** Where they stood in the game; absent when not known. */
  speakerPos?: SpeakerPos | undefined;
}

const clean = (text: string, limit: number): string => text.replace(/[\r\n\t]+/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, limit);
const whole = (value: number): number => Math.floor(value);

/** The speaker's place as words (`x,y,z`, with the dimension when it is not the overworld), or null when it does not read. */
export function posWords(pos: SpeakerPos | undefined): string | null {
  if (typeof pos === 'string') return clean(pos, 60) || null;
  if (!pos || typeof pos !== 'object') return null;
  const { x, y, z } = pos;
  if (![x, y, z].every(value => typeof value === 'number' && Number.isFinite(value))) return null;
  const dimension = typeof pos.dimension === 'string' ? pos.dimension.replace(/^minecraft:/u, '') : '';
  return `${whole(x)},${whole(y)},${whole(z)}${dimension && dimension !== 'overworld' ? `（${dimension}）` : ''}`;
}

/** An ISO time cut to the second (`2026-11-24T15:51:58Z`), or null when it is not a time. */
export function timeWords(at: string | undefined): string | null {
  const ms = at ? Date.parse(at) : Number.NaN;
  return Number.isFinite(ms) ? new Date(ms).toISOString().replace(/\.\d+Z$/u, 'Z') : null;
}

/**
 * The tail of a spoken line: the words as spoken (only when they say more than the goal), the time and the speaker's place, each only when known.
 * Empty when the voice gave none of them (the form before the fields, which the head reads as before).
 */
export function spokenDetail(fields: SpokenFields, goal: string): string {
  const words = fields.speakerWords ? clean(fields.speakerWords, 200) : '';
  const parts = [...words && words !== clean(goal, 200) ? [`言われた言葉: 「${words}」`] : [],
    ...(timeWords(fields.spokenAt) ? [`言った時刻 ${timeWords(fields.spokenAt)}`] : []),
    ...(posWords(fields.speakerPos) ? [`話した人のマイクラの位置 ${posWords(fields.speakerPos)}`] : [])];
  return parts.length ? `（${parts.join('・')}）` : '';
}

// ---- the detail of a request, from the voice route to the queue's start of its task (the entry keeps no words: they are read when the task is made)
const spoken = new Map<string, string>();
/** Keeps the detail of the request `requestId` until its task is made. */
export function rememberSpoken(requestId: string, detail: string): void {
  if (!detail) return;
  spoken.delete(requestId);
  spoken.set(requestId, detail);
  if (spoken.size > 64) spoken.delete(spoken.keys().next().value as string);
}
/** The detail kept for a request (empty when none: a request from the game's chat or the mod's list, or one made before the process began). */
export const spokenFor = (requestId: string | null | undefined): string => (requestId ? spoken.get(requestId) ?? '' : '');

// ---- what a task has been told by people, for the strong model's input
/** The lines a person's words come in: a request (「…の依頼: …」) and words for the request under way (「…の言葉（いまのタスクへ）: …」). */
const PERSON_LINE = /^(?:Discordの通話での.+?|ゲーム内の本人)の(?:依頼|言葉（いまのタスクへ）): /u;
/** Words for the request under way: a new one of these is a reason to look at the plan again. */
const PERSON_WORDS = /^(?:Discordの通話での.+?|ゲーム内の本人)の言葉（いまのタスクへ）: /u;
export interface HeardLine { id: string; at: string; text: string; words: boolean }
const LAST_LINES = 5;
const LINE_CHARACTERS = 420;
const heard = new Map<string, HeardLine[]>();

/**
 * Takes the person's lines out of a step's inbox into the task's ledger (each message once), and gives the new ones that are words for the request under
 * way (not the request itself): the head asks the strong model to look at the plan again for them.
 */
export function noteHeard(taskId: string, messages: ReadonlyArray<{ id: string; text: string; receivedAt: string }>): HeardLine[] {
  const known = heard.get(taskId) ?? [];
  const fresh: HeardLine[] = [];
  for (const message of messages) {
    if (known.some(line => line.id === message.id) || !PERSON_LINE.test(message.text)) continue;
    fresh.push({ id: message.id, at: message.receivedAt, text: clean(message.text, LINE_CHARACTERS), words: PERSON_WORDS.test(message.text) });
  }
  if (fresh.length) {
    // The first line (the request as it came) stays; the newest few follow it.
    const all = [...known, ...fresh];
    heard.delete(taskId);
    heard.set(taskId, all.length > LAST_LINES + 1 ? [all[0]!, ...all.slice(-LAST_LINES)] : all);
    if (heard.size > 32) heard.delete(heard.keys().next().value as string);
  }
  return fresh.filter(line => line.words);
}

/** The lines the strong model is shown (oldest first), each with the time it was received: the request and the words after it. */
export function heardLines(taskId: string): string[] {
  return (heard.get(taskId) ?? []).map(line => `- ${timeWords(line.at) ?? line.at}: ${line.text}`);
}

/** For tests: no task has heard anything. */
export function forgetHeard(): void {
  heard.clear();
  spoken.clear();
}
