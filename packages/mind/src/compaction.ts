/**
 * Structured compaction (Syzygy ADR-0008 stage 3, coordinator decision 5 of 2026-10-07, `docs/mind-workspace-contract.md`): the
 * replay summary as a JSON template that luna fills and code renders. Each of the eight sections holds at most 5 items of at most
 * 80 characters. Text gets at most 900 characters; voice gets 目的・途中・次・重要な文脈 in at most 400.
 *
 * What goes to the summarizer is cut here too: a tool call and its result are never split, and the oldest tool outputs are trimmed
 * first. `coversFromId`/`coversToId` name the raw range the summary stands for, so recall can open it.
 */
export const COMPACTION_SECTIONS = Object.freeze(['目的', '制約', '済み', '途中', '詰まり', '決めたこと', '次', '重要な文脈'] as const);
export type CompactionSection = typeof COMPACTION_SECTIONS[number];

export const COMPACTION_V1 = Object.freeze({
  version: 'compaction.v1',
  maximumItems: 5,
  maximumItemCharacters: 80,
  textCharacters: 900,
  voiceCharacters: 400,
  voiceSections: Object.freeze(['目的', '途中', '次', '重要な文脈'] as const satisfies readonly CompactionSection[]),
  /** When a render is too long, items leave in this order of sections, the oldest item of a section first. */
  trimOrder: Object.freeze(['済み', '制約', '詰まり', '決めたこと', '重要な文脈', '途中', '次', '目的'] as const satisfies readonly CompactionSection[]),
  header: '[ここまでの要約]',
  trimmedToolOutput: '（道具の結果は省略）',
});

export type CompactionTemplate = Readonly<Record<CompactionSection, readonly string[]>> & {
  readonly coversFromId: string | null;
  readonly coversToId: string | null;
};

const ellipsis = (text: string, limit: number) => {
  const characters = [...text];
  return characters.length <= limit ? text : `${characters.slice(0, limit - 1).join('')}…`;
};

/** One item as kept: one line, trimmed, at most 80 characters. */
export function compactionItem(text: string): string {
  return ellipsis(text.replace(/\s+/gu, ' ').trim(), COMPACTION_V1.maximumItemCharacters);
}

/** The newest five distinct, non-empty items of a list, in order. */
function keptItems(items: readonly string[]): readonly string[] {
  const kept = [...new Set(items.map(compactionItem).filter(Boolean))];
  return Object.freeze(kept.slice(Math.max(0, kept.length - COMPACTION_V1.maximumItems)));
}

export function emptyTemplate(): CompactionTemplate {
  return Object.freeze({ ...Object.fromEntries(COMPACTION_SECTIONS.map(section => [section, Object.freeze([])])), coversFromId: null, coversToId: null }) as CompactionTemplate;
}

/**
 * Reads the summarizer's answer: an object with the eight sections as arrays of strings (a section may be missing; a string alone
 * is one item). Other keys are dropped, and so is anything that is not text. Answers null when it is not an object at all.
 */
export function checkedTemplate(value: unknown, covers: { fromId: string | null; toId: string | null } = { fromId: null, toId: null }): CompactionTemplate | null {
  let row = value;
  if (typeof row === 'string') {
    try { row = JSON.parse(row) as unknown; } catch { return null; }
  }
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  const record = row as Record<string, unknown>;
  const sections = Object.fromEntries(COMPACTION_SECTIONS.map(section => {
    const raw = record[section];
    const items = typeof raw === 'string' ? [raw] : Array.isArray(raw) ? raw.filter((item): item is string => typeof item === 'string') : [];
    return [section, keptItems(items)];
  }));
  return Object.freeze({ ...sections, coversFromId: covers.fromId, coversToId: covers.toId }) as CompactionTemplate;
}

/**
 * The incremental update: a section the update names replaces the previous one (the summarizer was shown it and rewrote it); a
 * section it leaves out is kept. The covered range grows: from the earlier start to the update's end.
 */
export function mergedTemplate(previous: CompactionTemplate | null, update: CompactionTemplate, named: readonly CompactionSection[] = COMPACTION_SECTIONS): CompactionTemplate {
  const base = previous ?? emptyTemplate();
  const sections = Object.fromEntries(COMPACTION_SECTIONS.map(section => [section, named.includes(section) ? keptItems(update[section]) : base[section]]));
  return Object.freeze({ ...sections, coversFromId: base.coversFromId ?? update.coversFromId, coversToId: update.coversToId ?? base.coversToId }) as CompactionTemplate;
}

function renderLines(template: CompactionTemplate, sections: readonly CompactionSection[]): string {
  const lines = sections.filter(section => template[section].length).map(section => `${section}: ${template[section].join('／')}`);
  return lines.length ? [COMPACTION_V1.header, ...lines].join('\n') : '';
}

/**
 * The summary as the prompt shows it: one line per section that has items, under the header. Text: every section, at most 900
 * characters; voice: 目的・途中・次・重要な文脈, at most 400. When it is too long, items leave in `trimOrder`, oldest first; a
 * last line that still does not fit is cut with 「…」. Empty when there is nothing.
 */
export function renderedCompaction(template: CompactionTemplate, surface: 'text' | 'voice'): string {
  const sections: readonly CompactionSection[] = surface === 'voice' ? COMPACTION_V1.voiceSections : COMPACTION_SECTIONS;
  const limit = surface === 'voice' ? COMPACTION_V1.voiceCharacters : COMPACTION_V1.textCharacters;
  const working = Object.fromEntries(COMPACTION_SECTIONS.map(section => [section, [...template[section]]])) as Record<CompactionSection, string[]>;
  const shown = () => ({ ...working, coversFromId: null, coversToId: null }) as CompactionTemplate;
  let text = renderLines(shown(), sections);
  for (const section of COMPACTION_V1.trimOrder) {
    if (!sections.includes(section)) continue;
    while ([...text].length > limit && working[section].length) {
      working[section].shift();
      text = renderLines(shown(), sections);
    }
  }
  return ellipsis(text, limit);
}

/** One message of the range to summarize. A tool call names its call id; its result names the same id. */
export interface CompactionMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool_call' | 'tool_result';
  content: string;
  callId?: string;
}

const size = (messages: readonly CompactionMessage[]) => messages.reduce((total, message) => total + [...message.content].length, 0);

/**
 * What the summarizer is given of a range, within `budget` characters of content: first the oldest tool outputs are replaced by
 * a fixed line, one by one; then whole units leave from the oldest, where a tool call and its result are one unit and are never
 * split. Answers the messages kept and the range they come from (`coversFromId`/`coversToId` of the whole range handed in).
 */
export function summaryInput(messages: readonly CompactionMessage[], budget: number): { messages: readonly CompactionMessage[]; coversFromId: string | null; coversToId: string | null } {
  const coversFromId = messages[0]?.id ?? null;
  const coversToId = messages.at(-1)?.id ?? null;
  let kept = messages.map(message => ({ ...message }));
  for (const message of kept) {
    if (size(kept) <= budget) break;
    if (message.role === 'tool_result' && message.content !== COMPACTION_V1.trimmedToolOutput) message.content = COMPACTION_V1.trimmedToolOutput;
  }
  // Units: a tool call with the result of the same id; every other message alone.
  const units: CompactionMessage[][] = [];
  const open = new Map<string, CompactionMessage[]>();
  for (const message of kept) {
    if (message.role === 'tool_result' && message.callId && open.has(message.callId)) {
      open.get(message.callId)!.push(message);
      open.delete(message.callId);
      continue;
    }
    const unit = [message];
    units.push(unit);
    if (message.role === 'tool_call' && message.callId) open.set(message.callId, unit);
  }
  while (units.length > 1 && size(units.flat()) > budget) units.shift();
  kept = units.flat();
  return { messages: Object.freeze(kept.map(message => Object.freeze(message))), coversFromId, coversToId };
}
