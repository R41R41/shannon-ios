import type { SecretCheck } from './conversationSecrets.js';
import { clip } from './shannonToolTypes.js';
import type { ToolResult } from './shannonTools.js';

/**
 * What she did and saw with her tools in one conversation turn, kept with that turn so that her next turns know it.
 * (2026-10-05, the Windows body: after a `folder.list` in one turn she said in the next that no result had arrived,
 * and took back what she had seen.) It is compact and bounded: for each call the tool, the path, title or id it was
 * about, whether it worked (or the failure kind), for a list or a search the names it found (at most 12), and for a
 * read or a write a short note (a size or an id). Never the text of a file or a piece, never what she wrote, never a
 * search snippet.
 *
 * Replayed (`conversationWindow.ts`) only into the model prompt of a turn the owner alone hears or reads, inside the
 * replay budget, labelled as what she did and saw. It is never in a prompt with anyone else present, never in a
 * response field (a chat response's `systemPrompt` is the prompt before the replay), and never sent to a client.
 */
export interface ToolTraceCall {
  tool: string;
  /** The path, title, id or search words the call was about. */
  target?: string;
  ok: boolean;
  failure?: string;
  /** For a list or a search: the names it found, at most `TRACE_NAMES` (an empty list: nothing was there). */
  names?: readonly string[];
  /** Whether the list said there was more than it showed. */
  more?: true;
  /** For a read or a write: a size or an id, never content. */
  note?: string;
}

export interface ToolTraceRecord {
  /** The stored turn (experience id) whose reply the calls were made for. */
  turnId: string;
  threadId: string;
  recordedAt: string;
  /** A voice turn offered tools because the owner asked about her things; keeps the follow-up window open. */
  asked: boolean;
  calls: readonly ToolTraceCall[];
}

export const TRACE_CALLS = 6;
/** The turn id of a trace whose turn is not in the Talk (yet): linked to the Talk only (`shannonToolTurns.ts`). */
export const UNLINKED_TURN = 'unstored:';
export const TRACE_NAMES = 12;
const NAME_CHARACTERS = 60;
/** A study name is a short title, its stage and its whole id (a UUID is 36 characters). */
const STUDY_NAME_CHARACTERS = 100;
const TARGET_CHARACTERS = 80;
/** The whole replayed block is at most this long, and it is counted inside the replay budget. */
export const TRACE_PROMPT_CHARACTERS = 1_200;
const HIDDEN = '（伏せた）';

function input(argumentsJson: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(argumentsJson);
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch { return {}; }
}

const text = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value.trim() : undefined;

/** The names of a list or search result, as `shannonFolderTools.ts` and `shannonStudyTools.ts` write them; snippets are left out. */
function namesOf(tool: string, resultText: string): string[] {
  const names: string[] = [];
  for (const line of resultText.split('\n')) {
    let name: string | undefined;
    if (tool === 'folder.list') {
      const match = /^- (フォルダ|ファイル) (.+?)(?:（\d+バイト、[^）]*）)?$/u.exec(line);
      name = match ? `${match[2]}${match[1] === 'フォルダ' ? '/' : ''}` : undefined;
    } else if (tool === 'folder.search') {
      name = /^- (.+?)(?::\d+|（名前）) …/u.exec(line)?.[1];
    } else {
      // study.list / study.search: "- id: X｜メモ「題名」｜状態｜…"; the snippet lines of a search start with spaces.
      // The id is kept whole, so that she can name the piece in a later turn; the title is shortened instead.
      const match = /^- id: ([^｜]+)｜([^｜]+)｜([^｜]+)/u.exec(line);
      name = match ? `${clip(match[2]!, 30)}（${clip(match[3]!, 12)}、id: ${match[1]}）` : undefined;
    }
    if (name) names.push(name);
  }
  return names;
}

/**
 * One call as the trace keeps it. `secrets`: the conversation's check of what must reach nobody but the owner; a name
 * or target that repeats it is hidden, and when the check could not be read (`null`) no free text is kept at all.
 */
export function toolTraceCall(tool: string, argumentsJson: string, result: ToolResult, secrets: SecretCheck | null | undefined): ToolTraceCall {
  const keep = (value: string | undefined, maximum: number): string | undefined => {
    if (!value) return undefined;
    if (secrets === null) return HIDDEN;
    try { if (secrets?.carries(value)) return HIDDEN; } catch { return HIDDEN; }
    return clip(value, maximum);
  };
  const args = input(argumentsJson);
  const moved = text(args.to) ?? text(args.newName);
  const about = text(args.path) ?? text(args.title) ?? text(args.id) ?? text(args.query);
  const target = keep(about && moved ? `${about} → ${moved}` : about, TARGET_CHARACTERS);
  const call: ToolTraceCall = { tool: clip(tool, 40), ...(target ? { target } : {}), ok: result.ok, ...(result.failure ? { failure: result.failure } : {}) };
  if (!result.ok) return call;
  if (/\.(?:list|search)$/u.test(tool)) {
    const found = namesOf(tool, result.text);
    const names = found.slice(0, TRACE_NAMES).map(name => keep(name, tool.startsWith('study.') ? STUDY_NAME_CHARACTERS : NAME_CHARACTERS)!);
    // Only the lines that are not names or snippets say whether there was more (a snippet may say anything).
    const said = result.text.split('\n').filter(line => !/^(?:- |\s)/u.test(line)).join('\n');
    return { ...call, names, ...(found.length > TRACE_NAMES || /（ほかにもある）|途中で打ち切った|新しい順に/u.test(said) ? { more: true as const } : {}) };
  }
  const size = /（全(\d+)バイト/u.exec(result.text)?.[1];
  const id = /id[:：]\s*([\w-]{8,80})/u.exec(result.text)?.[1];
  const note = size ? `全${size}バイト` : id ? `id: ${id}` : undefined;
  return note ? { ...call, note } : call;
}

/**
 * The calls with every target and name that now repeats what must reach nobody but the owner hidden: a later 「内緒」, or
 * an item he asked her to forget, applies to traces already stored. A check that cannot be read hides all of them.
 */
export function maskedTraceCalls(calls: readonly ToolTraceCall[], secrets: SecretCheck | null): ToolTraceCall[] {
  const hide = (value: string): string => {
    if (value === HIDDEN) return value;
    try { return secrets && !secrets.carries(value) ? value : HIDDEN; } catch { return HIDDEN; }
  };
  return calls.map(call => ({
    ...call, ...(call.target !== undefined ? { target: hide(call.target) } : {}), ...(call.names ? { names: call.names.map(hide) } : {}),
  }));
}

/** A stored trace read back: anything that is not the shape above is dropped, and every part is bounded again. */
export function boundedTraceCalls(value: unknown): ToolTraceCall[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, TRACE_CALLS).flatMap(item => {
    const call = item && typeof item === 'object' ? item as Record<string, unknown> : null;
    if (!call || typeof call.tool !== 'string' || typeof call.ok !== 'boolean') return [];
    const names = Array.isArray(call.names) ? call.names.filter((name): name is string => typeof name === 'string').slice(0, TRACE_NAMES).map(name => clip(name, STUDY_NAME_CHARACTERS)) : undefined;
    return [{
      tool: clip(call.tool, 40), ok: call.ok,
      ...(typeof call.target === 'string' ? { target: clip(call.target, TARGET_CHARACTERS) } : {}),
      ...(typeof call.failure === 'string' ? { failure: clip(call.failure, 20) } : {}),
      ...(names ? { names } : {}), ...(call.more === true ? { more: true as const } : {}),
      ...(typeof call.note === 'string' ? { note: clip(call.note, 100) } : {}),
    }];
  });
}

function callLine(call: ToolTraceCall): string {
  const head = `${call.tool}${call.target ? `「${call.target}」` : ''}`;
  if (!call.ok) return `${head} → できなかった（${call.failure ?? 'failed'}）`;
  const found = call.names ? (call.names.length ? `。あったもの: ${call.names.join('、')}${call.more ? '、ほかにもある' : ''}` : '。何もなかった') : '';
  return `${head} → できた${found}${call.note ? `（${call.note}）` : ''}`;
}

const TRACE_HEADER = [
  '[さっきボクが道具でしたこと・見たこと]',
  '前の返事でボクが実際に道具を使った記録（その時の結果。ファイルや書斎の中身は記録していない）。ここにあることは本当にしたこと・見たことなので、取り消さない。いまの様子をもっと詳しく知りたい時は、この返事に道具があれば使い、なければそう短く伝える。',
].join('\n');

/** Which reply of hers a trace belongs to: how many replies ago (1 = her last), or a reply that is not in the Talk. */
export function traceLabel(repliesAgo: number | 'unstored'): string {
  return repliesAgo === 'unstored' ? '会話の記録に残っていない返事（途中で切れたなど）' : repliesAgo <= 1 ? '直前の返事' : `${repliesAgo}つ前の返事`;
}

/**
 * The block for the model: `turns` newest first, each with its label (`traceLabel`).
 * Older turns are left out until the block fits `maximum` characters; nothing fits, nothing is said.
 */
export function toolTracePrompt(turns: readonly { record: ToolTraceRecord; label: string }[], maximum = TRACE_PROMPT_CHARACTERS): string {
  const lines: string[] = [];
  let length = TRACE_HEADER.length;
  for (const { record, label } of turns) {
    if (!record.calls.length) continue;
    const turn = record.calls.map(call => `- ${label}: ${callLine(call)}`);
    const added = turn.reduce((sum, line) => sum + line.length + 1, 0);
    const room = Math.min(maximum, TRACE_PROMPT_CHARACTERS);
    if (length + added > room) {
      // Her last turn alone is too long: it is shortened, never dropped; an older one is left out.
      if (!lines.length) for (const line of turn) {
        const left = room - length - 1;
        if (left < 40) break;
        lines.push(clip(line, left));
        length += Math.min(line.length, left) + 1;
      }
      break;
    }
    lines.unshift(...turn);
    length += added;
  }
  return lines.length ? `${TRACE_HEADER}\n${lines.join('\n')}` : '';
}
