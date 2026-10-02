import type { ShannonAutonomyDomainId } from '@shannon/cognition';
import { yenFromUsd, type AutonomyConfig } from './autonomyBudget.js';
import type { HostFolderDesk } from './autonomyHostFolderDesk.js';
import type { AutonomyLoopConfig } from './autonomyLoopConfig.js';
import { prepareFolderCopy } from './autonomyLoopFolderStep.js';
import { ROOM_LOOK_DOMAIN, prepareRoomLook, roomLookAvailable, type AutonomyRoomLooks } from './autonomyLoopLookStep.js';
import { planFromThought, storyNotes, thinkingMaterials, withNoteAfterReading, type Thought } from './autonomyLoopPlan.js';
import {
  AUTONOMY_NOTE_MAXIMUM_CHARACTERS, draftPrompt, notePrompt, parsedModelObject, revisePrompt, thinkingPrompt, type AutonomyPrompt,
} from './autonomyLoopPrompts.js';
import type { AutonomyLoopCycle, AutonomyPlannedStep } from './autonomyLoopState.js';
import { autonomyModelCostUsd, type AutonomyModelPurpose } from './autonomyModels.js';
import type { AutonomousActionRequest, AutonomyDecision } from './autonomyPolicy.js';
import type { AutonomyPublicReader } from './autonomyReader.js';
import type { ShannonAutonomyService } from './autonomyService.js';
import type { ShowingOutcome, StudyShowing } from './autonomyShowing.js';
import type { SQLiteAutonomyStore } from './autonomyStore.js';
import { AutonomyModelError, resolveAutonomyModel, type AutonomyTextModel } from './autonomyTextModel.js';
import { STUDY_LIMITS, STUDY_REACTION_LABEL } from './studyStore.js';

/**
 * The step kinds of the first activity: thinking, reading, note-taking, drafting,
 * revising, showing. Each is one model call or one read.
 *
 * `prepareStep` builds what the gate is asked; `perform` does the one outside call and
 * returns what to write. The writes (`commit`) run inside the transaction that reports
 * the step, so a step's product, its activity-record entry and its cost appear together
 * or not at all. An executor is handed only the adapter of the domain the gate allowed.
 */
export interface AutonomyNotionReader {
  /** Reads one page the owner shared, read-only. Null when nothing matches. */
  read(input: { query: string; signal?: AbortSignal }): Promise<{ title: string; url: string; text: string } | null>;
}

/** A free read domain with its own daily count (`SHANNON_AUTONOMY_MAX_NOTION_READS`). */
export const NOTION_READ_DOMAIN = 'notion_read';

export interface StepDependencies {
  store: SQLiteAutonomyStore;
  service: ShannonAutonomyService;
  config: AutonomyConfig;
  loop: AutonomyLoopConfig;
  model: AutonomyTextModel;
  reader: AutonomyPublicReader;
  showing: StudyShowing;
  notion?: AutonomyNotionReader;
  /** Looking at the room through her body's camera; absent, a look is never planned. */
  looks?: AutonomyRoomLooks;
}

/** The adapters of one domain. A step allowed for a domain can reach nothing else. */
interface BoundAdapters {
  model?: AutonomyTextModel;
  reader?: AutonomyPublicReader;
  notion?: AutonomyNotionReader;
  showing?: StudyShowing;
  folder?: HostFolderDesk;
  looks?: AutonomyRoomLooks;
}

export function adaptersFor(decision: Pick<AutonomyDecision, 'decision' | 'domain'>, dependencies: StepDependencies): BoundAdapters {
  if (decision.decision !== 'allow') return {};
  switch (decision.domain as ShannonAutonomyDomainId | typeof NOTION_READ_DOMAIN) {
    case 'thinking': case 'aether_study': return { model: dependencies.model };
    case 'public_read': return { reader: dependencies.reader };
    case 'owner_message': return { showing: dependencies.showing };
    case NOTION_READ_DOMAIN: return dependencies.notion ? { notion: dependencies.notion } : {};
    case 'host_folder': return { folder: dependencies.service.folder };
    case ROOM_LOOK_DOMAIN: return dependencies.looks ? { looks: dependencies.looks } : {};
    default: return {};
  }
}

export interface StepResult {
  outcome: 'done' | 'failed';
  /** One plain Japanese sentence for the activity record. */
  summary: string;
  usage?: { inputTokens: number; outputTokens: number };
  link?: string;
  /** Replaces the tool name of the request in the record, when the step ended as something narrower. */
  tool?: string;
  /** Why a failed step failed, as a code from a closed set. */
  reasonCode?: string;
  /** Writes of the step's product; runs inside the reporting transaction. */
  commit?: (remaining: readonly AutonomyPlannedStep[], at: string) => StepCommit | void;
}

export interface StepCommit {
  /** The plan that remains after this step, when the step changes it. */
  plan?: readonly AutonomyPlannedStep[];
  /** What the step produced. */
  link?: string;
}

export interface PreparedStep {
  request: AutonomousActionRequest;
  purpose?: AutonomyModelPurpose | typeof ROOM_LOOK_DOMAIN;
  estimate?: { inputTokens: number; outputTokens: number };
  /** Why she would ask for more budget if the cap blocks this step. Absent for steps she would not ask for. */
  budgetReason?: string;
  perform(adapters: BoundAdapters, at: string, signal?: AbortSignal): Promise<StepResult>;
}

interface PaidCall { model: string; estimate: { inputTokens: number; outputTokens: number }; estimatedCostYen: number; prompt: AutonomyPrompt; maximumOutputTokens: number }

const OUTPUT_TOKENS: Readonly<Record<'think' | 'note' | 'draft' | 'revise', number>> = Object.freeze({ think: 1_500, note: 1_500, draft: 6_000, revise: 6_000 });

/** Null when the step cannot be carried out at all (nothing to note, an unknown piece, no usable model); it is then skipped unasked. */
export function prepareStep(dependencies: StepDependencies, cycle: AutonomyLoopCycle, step: AutonomyPlannedStep, at: string): PreparedStep | null {
  switch (step.kind) {
    case 'think': return prepareThinking(dependencies, cycle, at);
    case 'read': return prepareReading(dependencies, cycle, step);
    case 'notion': return prepareNotion(dependencies, cycle, step);
    case 'note': return prepareNote(dependencies, cycle, step);
    case 'draft': return prepareDraft(dependencies, cycle, step);
    case 'revise': return prepareRevision(dependencies, cycle, step);
    case 'show': return prepareShowing(dependencies, cycle, step);
    case 'put_away': return preparePutAway(dependencies, cycle, step);
    case 'copy': return prepareFolderCopy(dependencies, cycle, step, at);
    case 'look': return prepareRoomLook(dependencies, cycle, at);
    default: return null;
  }
}

function paidCall(dependencies: StepDependencies, scopeKey: string, purpose: AutonomyModelPurpose, prompt: AutonomyPrompt, maximumOutputTokens: number): PaidCall | null {
  const model = resolveAutonomyModel(purpose, dependencies.store.modelPreferences(scopeKey), id => dependencies.model.canUse(id));
  if (!model) return null;
  // Japanese runs near one token per character; the estimate assumes more so the gate errs high.
  const estimate = { inputTokens: Math.ceil((prompt.system.length + prompt.prompt.length) * 1.5) + 64, outputTokens: maximumOutputTokens };
  const costUsd = autonomyModelCostUsd(model, estimate, dependencies.config.modelPrices);
  if (costUsd === null) return null;
  return { model, estimate, estimatedCostYen: yenFromUsd(costUsd, dependencies.config), prompt, maximumOutputTokens };
}

async function callModel(adapters: BoundAdapters, call: PaidCall, signal?: AbortSignal):
  Promise<{ reply: Record<string, unknown> | null; usage?: { inputTokens: number; outputTokens: number }; failure?: string }> {
  if (!adapters.model) return { reply: null, failure: 'AUTONOMY_STEP_NOT_BOUND' };
  try {
    const result = await adapters.model.generate({
      model: call.model, system: call.prompt.system, prompt: call.prompt.prompt, maximumOutputTokens: call.maximumOutputTokens, signal,
    });
    return { reply: parsedModelObject(result.text), usage: result.usage };
  } catch (error) {
    // The provider answered with an error: charged only what it reported. No answer at all (a timeout, a lost
    // connection, a shutdown) leaves the cost unknown, so the estimate is charged and the count errs high.
    const usage = error instanceof AutonomyModelError ? error.usage : call.estimate;
    return { reply: null, failure: error instanceof Error ? error.message : 'AUTONOMY_MODEL_FAILED', ...(usage ? { usage } : {}) };
  }
}

function prepareThinking(dependencies: StepDependencies, cycle: AutonomyLoopCycle, at: string): PreparedStep | null {
  const { store, service, config, loop } = dependencies;
  const overview = service.overview(cycle.scopeKey);
  const readsToday = store.activity.countForDay(cycle.scopeKey, overview.budget.dayKey, 'public_read', 'allowed');
  const maximumSteps = Math.max(0, loop.maximumStepsPerCycle - cycle.stepsTaken - 1);
  const materials = thinkingMaterials(store, cycle.scopeKey, {
    at, localTime: localTime(at, config.timeZone), remainingYen: overview.budget.remainingYen,
    remainingReads: Math.max(0, config.maximumPublicReadsPerDay - readsToday), maximumSteps,
    readingSeeds: loop.readingSeeds, notionAvailable: dependencies.notion !== undefined,
    folderAvailable: service.folder.available(cycle.scopeKey, at),
    lookAvailable: roomLookAvailable(dependencies, cycle.scopeKey, at),
  });
  const call = paidCall(dependencies, cycle.scopeKey, 'planning', thinkingPrompt(materials), OUTPUT_TOKENS.think);
  if (!call) return null;
  return {
    request: { domain: 'thinking', summary: '次に何をするか、自分の台帳と書斎を見て考えます。', tool: 'study.think', paid: { model: call.model, estimatedCostYen: call.estimatedCostYen } },
    purpose: 'planning', estimate: call.estimate,
    async perform(adapters, _at, signal) {
      const { reply, usage, failure } = await callModel(adapters, call, signal);
      if (!reply) return { outcome: 'failed', summary: failure ? '考えようとしましたが、モデルから返事をもらえませんでした。' : '考えましたが、次の一歩にまとまりませんでした。', usage };
      const thought: Thought = planFromThought(reply, {
        pursuits: materials.pursuits, pieces: store.study.list(cycle.scopeKey), unnotedReadingIds: materials.unnotedReadings.map(item => item.id),
        placeUrls: materials.places.map(place => place.url),
      }, { maximumSteps, maximumReads: Math.min(loop.maximumReadsPerCycle, materials.remainingReads), notionAvailable: materials.notionAvailable, folderAvailable: materials.folderAvailable === true, lookAvailable: materials.lookAvailable === true });
      return {
        outcome: 'done', usage,
        summary: thought.text ? `次に何をするか考えました。「${thought.text}」` : '次に何をするか考えました。',
        commit: () => {
          for (const change of thought.pursuits) {
            if (change.op === 'add') service.addPursuit(cycle.scopeKey, { kind: change.kind!, title: change.title!, why: change.why!, origin: 'self' });
            else service.updatePursuit(cycle.scopeKey, change.id!, { ...(change.status ? { status: change.status } : {}), ...(change.why ? { why: change.why } : {}) });
          }
          return { plan: thought.steps };
        },
      };
    },
  };
}

function prepareReading(dependencies: StepDependencies, cycle: AutonomyLoopCycle, step: AutonomyPlannedStep): PreparedStep | null {
  const url = step.url;
  if (!url || dependencies.store.loop.wasRead(cycle.scopeKey, url)) return null;
  const host = hostOf(url);
  return {
    request: { domain: 'public_read', summary: `公開ページを1つ読みます（${host}）。`, tool: 'study.read', urls: [url] },
    async perform(adapters, _at, signal) {
      if (!adapters.reader) return { outcome: 'failed', summary: '読む道具が渡されなかったため、読みませんでした。' };
      try {
        const page = await adapters.reader.read(url, signal);
        return {
          outcome: 'done', summary: `「${clip(page.title, 80)}」を読みました。`, ...(page.url.startsWith('https://') ? { link: page.url } : {}),
          commit: (remaining, at) => {
            const reading = dependencies.store.loop.addReading(cycle.scopeKey, {
              url: page.url, title: page.title, text: page.text, links: page.links, ...(step.pursuitId ? { pursuitId: step.pursuitId } : {}),
            }, at);
            return { plan: withNoteAfterReading(remaining, reading.id) };
          },
        };
      } catch (error) {
        const code = error instanceof Error ? error.message : '';
        return {
          outcome: 'failed',
          summary: code === 'AUTONOMY_READ_ROBOTS_DISALLOWED' ? `読まないでほしいと書かれていたので、読みませんでした（${host}）。`
            : code === 'AUTONOMY_READ_NOT_PUBLIC' ? `公開されている場所ではなかったので、読みませんでした（${host}）。`
            : `ページを読めませんでした（${host}）。`,
          // A page that could not be read is not planned for a note.
          commit: remaining => ({ plan: remaining[0]?.kind === 'note' && !remaining[0].readingId ? remaining.slice(1) : remaining }),
        };
      }
    },
  };
}

function prepareNotion(dependencies: StepDependencies, cycle: AutonomyLoopCycle, step: AutonomyPlannedStep): PreparedStep | null {
  if (!dependencies.notion || !step.query) return null;
  const query = step.query;
  return {
    request: { domain: NOTION_READ_DOMAIN, summary: '持ち主が共有したNotionのページを1つ読みます。', tool: 'study.notion' },
    async perform(adapters, _at, signal) {
      if (!adapters.notion) return { outcome: 'failed', summary: 'Notionを読む道具が渡されなかったため、読みませんでした。' };
      try {
        const page = await adapters.notion.read({ query, signal });
        if (!page) return { outcome: 'failed', summary: '共有されたNotionに、探しているページは見つかりませんでした。' };
        return {
          outcome: 'done', summary: `Notionの「${clip(page.title, 80)}」を読みました。`,
          commit: (remaining, at) => ({ plan: withNoteAfterReading(remaining, dependencies.store.loop.addReading(cycle.scopeKey, {
            url: page.url, title: page.title, text: page.text.slice(0, 6_000), links: [], ...(step.pursuitId ? { pursuitId: step.pursuitId } : {}),
          }, at).id) }),
        };
      } catch {
        return { outcome: 'failed', summary: 'Notionのページを読めませんでした。' };
      }
    },
  };
}

function prepareNote(dependencies: StepDependencies, cycle: AutonomyLoopCycle, step: AutonomyPlannedStep): PreparedStep | null {
  const { store, service } = dependencies;
  const reading = (step.readingId ? store.loop.reading(cycle.scopeKey, step.readingId) : null) ?? store.loop.unnotedReadings(cycle.scopeKey)[0] ?? null;
  if (!reading || reading.notedAt || !reading.text) return null;
  const pursuit = reading.pursuitId ? store.pursuits.get(cycle.scopeKey, reading.pursuitId) : null;
  const call = paidCall(dependencies, cycle.scopeKey, 'research_reading', notePrompt({ pursuit, reading }), OUTPUT_TOKENS.note);
  if (!call) return null;
  return {
    request: { domain: 'aether_study', summary: '読んだものについて、書斎にメモを書きます。', tool: 'study.note', paid: { model: call.model, estimatedCostYen: call.estimatedCostYen } },
    purpose: 'research_reading', estimate: call.estimate, budgetReason: '読んだものを、忘れないうちにメモにまとめたい',
    async perform(adapters, _at, signal) {
      const { reply, usage } = await callModel(adapters, call, signal);
      const title = text(reply?.title, 60);
      const body = text(reply?.body, AUTONOMY_NOTE_MAXIMUM_CHARACTERS * 2);
      if (!title || !body) return { outcome: 'failed', summary: 'メモを書こうとしましたが、形になりませんでした。', usage };
      // Her notes are her own words: a note that repeats a long run of the page is not kept.
      if (sharesLongPassage(body, reading.text, 60)) return { outcome: 'failed', summary: '読んだ文をそのまま写しすぎていたので、メモにしませんでした。', usage };
      const question = text(reply?.question, 120);
      const questionWhy = text(reply?.questionWhy, 400);
      return {
        outcome: 'done', usage, summary: `メモ「${clip(title, 60)}」を書斎に書きました。`,
        commit: (_remaining, commitAt) => {
          const piece = store.study.create(cycle.scopeKey, {
            kind: 'note', title, body: body.slice(0, STUDY_LIMITS.noteBody), sources: [{ title: clip(reading.title, 160) || reading.url, url: reading.url }],
            ...(reading.pursuitId ? { pursuitId: reading.pursuitId } : {}), model: call.model,
          }, commitAt);
          if (typeof piece === 'string') throw new Error(piece);
          store.loop.markReadingNoted(cycle.scopeKey, reading.id, commitAt);
          if (question && questionWhy) service.addPursuit(cycle.scopeKey, { kind: 'question', title: question, why: questionWhy, origin: 'self' });
          return { link: `shannon-study://${piece.id}` };
        },
      };
    },
  };
}

function prepareDraft(dependencies: StepDependencies, cycle: AutonomyLoopCycle, step: AutonomyPlannedStep): PreparedStep | null {
  const { store } = dependencies;
  const pursuit = step.pursuitId ? store.pursuits.get(cycle.scopeKey, step.pursuitId) : null;
  const call = paidCall(dependencies, cycle.scopeKey, 'prose', draftPrompt({
    idea: step.intent ?? '', pursuit, notes: storyNotes(store, cycle.scopeKey, step.pursuitId, 5),
  }), OUTPUT_TOKENS.draft);
  if (!call) return null;
  return {
    request: { domain: 'aether_study', summary: '書斎に短い物語の下書きを書きます。', tool: 'study.draft', paid: { model: call.model, estimatedCostYen: call.estimatedCostYen } },
    purpose: 'prose', estimate: call.estimate, budgetReason: '短い物語の下書きを、今日のうちに書きたい',
    async perform(adapters, _at, signal) {
      const { reply, usage } = await callModel(adapters, call, signal);
      const title = text(reply?.title, 60);
      const body = story(reply?.body);
      if (!title || !body) return { outcome: 'failed', summary: '物語を書こうとしましたが、下書きになりませんでした。', usage };
      return {
        // The title stays hers until she calls the piece 「見せてもいい」.
        outcome: 'done', usage, summary: '書斎に、短い物語の下書きを1つ書きました。まだ見せていません。',
        commit: (_remaining, commitAt) => {
          const piece = store.study.create(cycle.scopeKey, {
            kind: 'story', title, body, changeNote: text(reply?.note, STUDY_LIMITS.changeNote) ?? '最初の稿です。',
            ...(pursuit ? { pursuitId: pursuit.id } : {}), model: call.model,
          }, commitAt);
          if (typeof piece === 'string') throw new Error(piece);
          return { link: `shannon-study://${piece.id}` };
        },
      };
    },
  };
}

function prepareRevision(dependencies: StepDependencies, cycle: AutonomyLoopCycle, step: AutonomyPlannedStep): PreparedStep | null {
  const { store } = dependencies;
  const piece = step.pieceId ? store.study.get(cycle.scopeKey, step.pieceId) : null;
  if (!piece || piece.kind !== 'story' || piece.status === 'put_away') return null;
  // Reader feedback goes to this revising step, and is marked used only when the revision is saved.
  const feedback = store.study.pendingFeedback(cycle.scopeKey, piece.id);
  const call = paidCall(dependencies, cycle.scopeKey, 'prose', revisePrompt({
    aim: step.intent ?? '', piece: { title: piece.title, body: piece.body, version: piece.version },
    feedback: feedback.map(item => ({ reactionLabel: STUDY_REACTION_LABEL[item.reaction], comment: item.comment, version: item.version })),
    notes: storyNotes(store, cycle.scopeKey, piece.pursuitId, 3),
  }), OUTPUT_TOKENS.revise);
  if (!call) return null;
  const seen = piece.readableVersion !== null;
  return {
    request: { domain: 'aether_study', summary: '書斎の物語を読み返して、直します。', tool: 'study.revise', paid: { model: call.model, estimatedCostYen: call.estimatedCostYen } },
    purpose: 'prose', estimate: call.estimate, budgetReason: '書いている物語を、もう一度直したい',
    async perform(adapters, _at, signal) {
      const { reply, usage } = await callModel(adapters, call, signal);
      const body = story(reply?.body);
      const change = text(reply?.change, STUDY_LIMITS.changeNote);
      if (!body || !change) return { outcome: 'failed', summary: '物語を直そうとしましたが、次の稿になりませんでした。', usage };
      return {
        outcome: 'done', usage, link: `shannon-study://${piece.id}`,
        summary: seen ? `物語「${clip(piece.title, 60)}」を直しました（第${piece.version + 1}稿）。` : `物語の下書きを直しました（第${piece.version + 1}稿）。まだ見せていません。`,
        commit: (_remaining, commitAt) => {
          const revised = store.study.revise(cycle.scopeKey, piece.id, { title: text(reply?.title, 60) ?? piece.title, body, changeNote: change, model: call.model }, commitAt);
          if (typeof revised === 'string') throw new Error(revised);
          store.study.markFeedbackUsed(cycle.scopeKey, feedback.map(item => item.id), commitAt);
        },
      };
    },
  };
}

function prepareShowing(dependencies: StepDependencies, cycle: AutonomyLoopCycle, step: AutonomyPlannedStep): PreparedStep | null {
  const { store } = dependencies;
  const piece = step.pieceId ? store.study.get(cycle.scopeKey, step.pieceId) : null;
  if (!piece || piece.kind !== 'story' || (piece.status !== 'draft' && piece.status !== 'ready')) return null;
  return {
    request: { domain: 'owner_message', summary: '物語を1つ「見せてもいい」にして、持ち主に知らせます。', tool: 'study.show' },
    async perform(adapters, at) {
      if (!adapters.showing) return { outcome: 'failed', summary: '知らせる道具が渡されなかったため、見せませんでした。' };
      // Readable first, so the piece can be opened the moment the message arrives.
      const ready = store.transaction(() => store.study.markReady(cycle.scopeKey, piece.id, at));
      if (typeof ready === 'string') return { outcome: 'failed', summary: '物語を「見せてもいい」にできませんでした。' };
      const revised = store.study.versions(cycle.scopeKey, piece.id).length > 1 && Boolean(piece.shownAt);
      let told: ShowingOutcome;
      try { told = adapters.showing.tell(cycle.scopeKey, { id: piece.id, title: ready.title, version: ready.version, revised }, at); } catch { told = 'unavailable'; }
      const sent = told === 'sent' || told === 'already-told';
      return {
        outcome: 'done', link: `shannon-study://${piece.id}`, tool: sent ? 'study.show' : 'study.ready',
        summary: sent ? `物語「${clip(ready.title, 60)}」を持ち主に見せました。`
          : `物語「${clip(ready.title, 60)}」を「見せてもいい」にしました。知らせるのは、あとにします（${waitingReason(told)}）。`,
        commit: (_remaining, commitAt) => { if (sent) store.study.markShown(cycle.scopeKey, piece.id, commitAt); },
      };
    },
  };
}

function preparePutAway(dependencies: StepDependencies, cycle: AutonomyLoopCycle, step: AutonomyPlannedStep): PreparedStep | null {
  const { store } = dependencies;
  const piece = step.pieceId ? store.study.get(cycle.scopeKey, step.pieceId) : null;
  if (!piece || piece.status === 'put_away') return null;
  return {
    request: { domain: 'aether_study', summary: '書斎の下書きを1つ、しまいます。', tool: 'study.put_away' },
    async perform() {
      return {
        outcome: 'done', link: `shannon-study://${piece.id}`,
        summary: piece.readableVersion !== null ? `「${clip(piece.title, 60)}」をしまいました。` : '下書きを1つ、しまいました。',
        commit: (_remaining, commitAt) => { store.study.putAway(cycle.scopeKey, piece.id, 'shannon', commitAt); },
      };
    },
  };
}

function waitingReason(outcome: ShowingOutcome): string {
  switch (outcome) {
    case 'quiet-hours': return '夜の静かな時間のため';
    case 'recent-conversation': return '話している最中のため';
    case 'today-is-enough': return '今日はもう一度話しかけたため';
    case 'reserved-for-commitment': return '今日は約束の声かけを先にするため';
    default: return '今は知らせる場所がないため';
  }
}

/** True when `body` repeats a run of at least `length` characters of `source`. */
export function sharesLongPassage(body: string, source: string, length: number): boolean {
  const compact = (value: string) => value.replace(/\s+/gu, '');
  const text = compact(body);
  const original = compact(source);
  if (text.length < length || original.length < length) return false;
  const step = Math.max(1, Math.floor(length / 4));
  for (let index = 0; index + length <= text.length; index += step) {
    if (original.includes(text.slice(index, index + length))) return true;
  }
  return original.includes(text.slice(-length));
}

function story(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const body = value.replace(/\r\n?/gu, '\n').trim();
  return body.length >= 100 && body.length <= STUDY_LIMITS.storyBody ? body : null;
}

function text(value: unknown, maximum: number): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/\r\n?/gu, '\n').trim();
  return normalized ? normalized.slice(0, maximum) : null;
}

function clip(value: string, maximum: number): string {
  const line = value.replace(/\s+/gu, ' ').trim();
  return line.length > maximum ? `${line.slice(0, maximum - 1)}…` : line;
}

function hostOf(url: string): string {
  try { return new URL(url).hostname; } catch { return '不明な宛先'; }
}

function localTime(at: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('ja-JP', { timeZone, year: 'numeric', month: 'long', day: 'numeric', weekday: 'short', hour: 'numeric', hourCycle: 'h23' }).format(new Date(at));
  } catch {
    return at.slice(0, 13);
  }
}
