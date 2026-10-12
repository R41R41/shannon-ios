import type { TaskProgress } from '../taskRuntime/taskProgressPorts.js';
import type { TaskRuntime } from '../taskRuntime/taskRuntimePorts.js';

/**
 * The short form of a task's report that a call says aloud (owner feedback 2026-10-13: a 2,900-character report read out
 * verbatim was too long to follow by ear, and then 1–3 sentences of 120 characters were still too long). The full report
 * stays the screen's; only this is spoken: 1–2 sentences, about 60 characters asked of the model, 70 the hard cap.
 */
export const SPOKEN_REPORT_TARGET_CHARACTERS = 60;
/** The hard cap, punctuation included: a model answer longer than this is not spoken, a plain cut is. */
export const SPOKEN_REPORT_CHARACTERS = 70;
const SPOKEN_REPORT_SENTENCES = 2;
const SPOKEN_REPORT_TIMEOUT_MS = 20_000;
const ATTEMPTS_KEPT = 512;

/** What the model is told: delivery only. Who she is comes from the persona, given beside it. */
export const SPOKEN_REPORT_INSTRUCTIONS = [
  '[調べた結果を声で伝える]',
  'ライ氏に頼まれて調べたことの結果が届いた。通話の切れ目に、ボクから自分で伝えるひと言を作る。',
  `- 1〜2文、全体で${SPOKEN_REPORT_TARGET_CHARACTERS}字以内（句読点込みで${SPOKEN_REPORT_CHARACTERS}字を超えない）。最初の文で答えを言い、話しかける口調にする。`,
  '- 依頼に複数の対象があれば、要点だけをひとまとめに言う。理由・経緯・補足は言わない。詳しいことは画面に残っている。',
  '- 話し言葉にする。見出し・箇条書き・記号・URL・出典の列挙・細かい数字の羅列は使わない。',
  '- 「結果がそろいました」「お待たせしました」「受け付けました」のような状況報告や、検索結果の抜粋だという断り書きは言わない。',
  '- 不確かさは、答えが変わる時だけ短く添える。報告にないことは足さない。',
  '- 日付は「いま」から見た言い方（今日・明日など）にする。報告の日付を勝手に言い換えない。',
  '- 調べられなかった時は、そのことを短く正直に言う。',
  '出力はそのひと言の文だけ。',
].join('\n');

export interface SpokenReportRequest {
  scopeKey: string;
  /** What the owner asked for (the task's goal). */
  request: string;
  /** The full report, as the screen shows it. */
  report: string;
  /** The owner's clock now, e.g. 2026年10月13日火曜日 2:40. */
  localTime: string;
  signal: AbortSignal;
}

/** One small model call. Throws when the provider gives nothing usable; the caller then speaks a plain cut of the report. */
export interface SpokenReportSpeaker { speak(request: SpokenReportRequest): Promise<string> }

export function spokenReportInput(request: Pick<SpokenReportRequest, 'request' | 'report' | 'localTime'>): string {
  return JSON.stringify({ いま: request.localTime, 依頼: request.request.slice(0, 600), 報告: request.report.slice(0, 2000) });
}

const URL_PATTERN = /https?:\/\/\S+/gu;
const SOURCE_LINE = /^(?:出典|参考|ソース|sources?)\s*[:：]?/iu;
const LINE_MARKER = /^(?:#{1,6}\s*|[-*・•●◆■□▶>]\s*|\d+[.)．、]\s*|【[^】]*】\s*)/u;

/** One line of a report as words to say: markers, emphasis, links and their addresses gone. */
function speakableLine(line: string): string {
  return line.replace(/\[([^\]]*)\]\([^)]*\)/gu, '$1').replace(URL_PATTERN, '').replace(/[*_`|]/gu, '')
    .replace(LINE_MARKER, '').replace(/[（(]\s*[)）]/gu, '').replace(/\s+/gu, ' ')
    .replace(/(?<=[^\x20-\x7e])\s+|\s+(?=[^\x20-\x7e])/gu, '').trim();
}

/** What is shown and never said: fenced blocks (a chart's JSON, code), table rows, images (rich chat, 2026-10-13). */
function withoutVisualBlocks(text: string): string {
  return text.replace(/```[\s\S]*?(?:```|$)/gu, '\n').replace(/!\[[^\]]*\]\([^)]*\)/gu, '')
    .split(/\r?\n/u).filter(line => !line.trim().startsWith('|')).join('\n');
}

/** Sentences of speakable text, a sentence end added where a line ended without one. */
function sentences(text: string): string[] {
  const lines = withoutVisualBlocks(text).split(/\r?\n/u).map(line => line.trim()).filter(line => line && !line.startsWith('#') && !SOURCE_LINE.test(line))
    .map(speakableLine).filter(Boolean).map(line => /[。！？!?]$/u.test(line) ? line : `${line}。`);
  return lines.join('').match(/[^。！？!?]+[。！？!?]+/gu)?.map(sentence => sentence.trim()).filter(Boolean) ?? [];
}

/** The longest run of whole sentences (at most two) within the limit; null when even the first is longer. */
function withinLimit(parts: readonly string[], limit = SPOKEN_REPORT_CHARACTERS): string | null {
  let spoken = '';
  for (const sentence of parts.slice(0, SPOKEN_REPORT_SENTENCES)) {
    if ([...spoken + sentence].length > limit) break;
    spoken += sentence;
  }
  return spoken || null;
}

/** An answer wrapped whole in quotation marks, unwrapped; a sentence that only starts with a quoted word is kept. */
function unwrapped(text: string): string {
  const pair = /^(["「『])([\s\S]*)(["」』])$/u.exec(text);
  return pair && !pair[2]!.includes(pair[3]!) ? pair[2]! : text;
}

/** A model's answer as it may be spoken: plain sentences within the limit, or null. */
export function spokenReportText(raw: string): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const parts = sentences(unwrapped(raw.trim()));
  const spoken = withinLimit(parts);
  return spoken && spoken.length >= 4 ? spoken : null;
}

/** A report with nothing to say aloud (only links or headings): where to find it, in her words, naming what was asked. */
export function reportOnScreenLine(title: string): string {
  const named = [...title.replace(/\s+/gu, ' ').trim()].slice(0, 30).join('');
  return named ? `「${named}」の結果は、画面に出しておきましたね。` : '調べた結果は、画面に出しておきましたね。';
}

/**
 * Without a model: the report's first sentences, plainly; a first sentence too long to say is cut at a comma. A report with
 * no sentence to say (only links or headings) is not read as a bare 「。」: it is named by the task's title instead.
 */
export function fallbackSpokenReport(report: string, title = ''): string {
  const parts = sentences(report);
  const whole = withinLimit(parts);
  if (whole && [...whole.replace(/[。！？!?\s]/gu, '')].length >= 2) return whole;
  const first = parts.find(sentence => [...sentence.replace(/[。！？!?\s]/gu, '')].length >= 2);
  if (!first) return reportOnScreenLine(title);
  const cut = [...first].slice(0, SPOKEN_REPORT_CHARACTERS - 1).join('');
  const comma = Math.max(cut.lastIndexOf('、'), cut.lastIndexOf('，'));
  return `${comma > 20 ? cut.slice(0, comma) : cut.replace(/[。！？!?]+$/u, '')}。`;
}

/** A short report needs no model: it is already what would be said. */
function alreadyShort(report: string): string | null {
  const direct = spokenReportText(report);
  return direct && !/https?:\/\//u.test(report) && !/\n\s*[-*・#]/u.test(`\n${report}`) && sentences(report).length <= SPOKEN_REPORT_SENTENCES
    && [...report.trim()].length <= SPOKEN_REPORT_CHARACTERS ? direct : null;
}

/** What of a task the spoken form needs. */
type SpokenTask = { id: string; goal: string; title: string; origin: string };

/**
 * Writes the spoken form of each report it is shown, once: a short report as it is, a longer one through the speaker (a
 * plain cut of the report when there is none or it fails). Nothing waits on it; a call speaks the report once it is written.
 */
export function createSpokenReports(parts: {
  speaker: SpokenReportSpeaker | null;
  record(scopeKey: string, taskId: string, reportId: string, spoken: string): boolean;
  localTime(): string;
  timeoutMs?: number;
}) {
  const attempted = new Set<string>();
  const running = new Set<Promise<void>>();
  const controller = new AbortController();
  const remember = (id: string) => {
    attempted.add(id);
    if (attempted.size > ATTEMPTS_KEPT) attempted.delete(attempted.values().next().value!);
  };
  const write = (scopeKey: string, taskId: string, reportId: string, spoken: string) => {
    try {
      parts.record(scopeKey, taskId, reportId, spoken);
    } catch { /* A newer report or a closed store: nothing to say for this one. */ }
  };
  const generate = async (scopeKey: string, task: SpokenTask, report: NonNullable<TaskProgress['report']>) => {
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(parts.timeoutMs ?? SPOKEN_REPORT_TIMEOUT_MS)]);
    let spoken: string | null = null;
    try { spoken = spokenReportText(await parts.speaker!.speak({ scopeKey, request: task.goal, report: report.text, localTime: parts.localTime(), signal })); }
    catch { console.warn('Shannon spoken report fallback code=spoken_report_model_failed'); }
    if (!controller.signal.aborted) write(scopeKey, task.id, report.id, spoken ?? fallbackSpokenReport(report.text, task.title));
  };
  return {
    /** Called with what the owner may see now; returns at once. */
    request(scopeKey: string, task: SpokenTask, progress: TaskProgress | null): void {
      const report = progress?.report, key = `${task.id}:${report?.id}`;
      // Only work the owner asked for: the call speaks no other report, so no other is worth a model call.
      if (!report || task.origin !== 'owner_request' || report.spoken || !report.text.trim()) return;
      if (attempted.has(key) || controller.signal.aborted) return;
      remember(key);
      const short = alreadyShort(report.text);
      if (short || !parts.speaker) return write(scopeKey, task.id, report.id, short ?? fallbackSpokenReport(report.text, task.title));
      const work = generate(scopeKey, task, report).finally(() => running.delete(work));
      running.add(work);
    },
    /** Resolves once every spoken form asked for so far is written. */
    async idle(): Promise<void> { await Promise.allSettled([...running]); },
    async close(): Promise<void> {
      controller.abort();
      await Promise.allSettled([...running]);
    },
  };
}

/** The owner's view of a task's progress, asking for the spoken form of a report it shows (the Now route's `progress`). */
export function progressWithSpokenReports(runtime: Pick<TaskRuntime, 'get'>, scopeKey: string,
  shown: (taskId: string) => TaskProgress | null, reports: Pick<ReturnType<typeof createSpokenReports>, 'request'>, ownerAlone: () => boolean) {
  return (taskId: string): TaskProgress | null => {
    const progress = shown(taskId), task = runtime.get(scopeKey, taskId);
    // Nothing is generated or written while anyone else may see or hear (asked again here, at the moment of the request).
    if (task && progress?.report && ownerAlone()) reports.request(scopeKey, task, progress);
    return progress;
  };
}
