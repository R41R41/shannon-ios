import { prepareShowing } from './autonomyLoopShowStep.js';
import { actionPermit } from '../../../infra/context/actionExecution.js';
import { actionResource } from '../../../contracts/actionThreadContract.js';
import type { ShannonAutonomyDomainId } from '@shannon/cognition';
import type { AutonomyConfig } from '../../inhibition/inhibitionPorts.js';
import type { HostFolderDesk } from './autonomyHostFolderDesk.js';
import { callModel, paidCall } from './autonomyLoopCalls.js';
import { prepareFolderCopy } from './autonomyLoopFolderStep.js';
import type { AutonomyLoopConfig } from './autonomyLoopConfig.js';
import { ROOM_LOOK_DOMAIN, prepareRoomLook, type AutonomyRoomLooks } from './autonomyLoopLookStep.js';
import { prepareFollowUp, prepareJot } from './autonomyLoopFollowUpStep.js';
import type { AutonomyPredictionTap, ReachOutFacts } from './store/autonomyLoopObservations.js';
import type { AutonomyReachOutObserver } from './autonomyLoopObserve.js';
import type { AutonomyOwnerContext } from './autonomyLoopOwnerContext.js';
import type { SelfInterestContextPort } from '../../self/selfPorts.js';
import { prepareRest, sessionOf } from './autonomyLoopPacing.js';
import { preparePhoneCall, type AutonomyPhone } from './autonomyLoopPhoneStep.js';
import { prepareReachOut, type AutonomyReachOuts, type AutonomyUpcoming } from './autonomyLoopReachOutStep.js';
import { storyNotes, withNoteAfterReading } from './autonomyLoopPlan.js';
import { AUTONOMY_NOTE_MAXIMUM_CHARACTERS, draftPrompt, notePrompt, revisePrompt } from './autonomyLoopPrompts.js';
import type { AutonomyLoopCycle, AutonomyPlannedStep } from './store/autonomyLoopState.js';
import { prepareThinking } from './autonomyLoopThinkStep.js';
import { heldForOthers, markEarly, sessionMarked, unmarkedOnly, unmarkedPursuits } from './autonomyLoopProvenance.js';
import { prepareToolStep, type AutonomyToolResults } from './autonomyLoopToolStep.js';
import type { AutonomyModelPurpose, AutonomyModelUsage } from './autonomyModels.js';
import { AUTONOMY_CALL_DOMAIN, type AutonomousActionRequest, type AutonomyDecision } from '../../inhibition/inhibitionPorts.js';
import type { AutonomyPublicReader } from './autonomyReader.js';
import type { ShannonAutonomyService } from './autonomyService.js';
import type { StudyShowing } from './autonomyShowing.js';
import type { SQLiteAutonomyStore } from './store/autonomyStore.js';
import type { AutonomyTextModel } from './autonomyTextModel.js';
import type { DecisionTraceWriter } from '../../../contracts/decisionTraceContract.js';
import { READING_DOCUMENT_PREFIX } from '../../inhibition/autonomyReadPorts.js';
import type { ToolDocuments } from '../../tools/executionPorts.js';
import { aetherStep, studyWriteKey, type StudyAether } from './studyAether.js';
import { STUDY_LIMITS, STUDY_REACTION_LABEL } from './store/studyStore.js';
import { clip, hostOf, sharesLongPassage, story, text } from './autonomyLoopStepText.js';

export { sharesLongPassage } from './autonomyLoopStepText.js';

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
  actionSteps?: import('../../../contracts/actionThreadContract.js').ActionStepPort;
  /** Only true after the scheduler owns this loop's execution rights; outreach still uses its existing gate. */
  concurrentActions?: boolean;
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
  /** Speaking up to the owner on her own; absent, a reach-out is never planned. */
  reachOuts?: AutonomyReachOuts;
  /** Phoning the owner's iPhone; absent, a call is never planned and no prompt speaks of one. */
  phone?: AutonomyPhone;
  /** The owner's upcoming items, for a reach-out; absent, there are none. */
  upcoming?: AutonomyUpcoming;
  /** What her body reported about a message of hers and what the server knows of the body; absent, both are unknown. */
  observer?: AutonomyReachOutObserver;
  /** The owner's context for her thinking, her writing and her messages (owner decisions 2026-10-02, ADR-0003); absent, or switched off in `loop`, no prompt carries it. */
  ownerContext?: AutonomyOwnerContext;
  /** Stage5's read-only self index is independent of the legacy owner's-context switch. */
  selfInterests?: SelfInterestContextPort;
  /** Her registry tools in her own time, with what they returned until her next thought; absent, no tool is offered. */
  toolResults?: AutonomyToolResults;
  /** A line for the service log. Only closed codes are ever passed: never a word of a prompt or a reply. */
  log?: (line: string) => void;
  /** The loop's clock, read while a step waits. */
  now?: () => string;
  /** Renews the runner's lease and heartbeat while a step waits; false once the lease is lost. */
  renew?: () => boolean;
  /** The pause between two looks at whether the owner answered; absent, a real timer. */
  wait?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  /** Syzygy ADR-0006 stage 1: a write-only tap handed what followed a message of hers; it returns nothing to the loop. */
  prediction?: AutonomyPredictionTap;
  /** Syzygy ADR-0008 stage 1: writes one content-free trace of a thought of hers; returns nothing. Absent (switched off), nothing is written. */
  trace?: DecisionTraceWriter;
  /**
   * Syzygy ADR-0008 stage 1, step 7a: the 「これまでの手応え」 section for the choices offered in a thought (closed choice names in,
   * one finished section of facts out), or null (no facts, or anyone else may be present). Absent (`SHANNON_VALUE_FACTS=off`):
   * every prompt is what it was.
   */
  valueFacts?: (scopeKey: string, offered: readonly string[], at: string) => string | null;
  /**
   * Syzygy ADR-0008 §14: the 「止められたこと」 section (what a rule stopped lately, as closed facts, apart from a rest she chose), or
   * null. Absent (`SHANNON_ADR8_STAGE2=off`): every prompt is what it was.
   */
  withheldFacts?: (scopeKey: string, at: string) => string | null;
  /**
   * Syzygy ADR-0008 stage 3: the one function she is handed of the mind (`EmitMindEvent`, `contracts/mindInboxContract.ts`): a step
   * of hers that ended, as one row of closed fields in `mind_inbox`. Never a word; returns nothing. Absent (`SHANNON_WORKSPACE`
   * off), nothing is written.
   */
  emitMindEvent?: (scopeKey: string, draft: OwnTimeMindEvent, at: string) => void;
}

/** What her own time hands the mind of a step: its kind or tool, how it ended, and who could see her (closed values). */
export interface OwnTimeMindEvent {
  kind: 'own_time_step';
  code: 'done' | 'failed';
  audience: 'owner' | 'others';
  source: 'own_time';
  sourceId: string;
  tool: string;
}

/** The adapters of one domain. A step allowed for a domain can reach nothing else. */
export interface BoundAdapters {
  model?: AutonomyTextModel;
  reader?: AutonomyPublicReader;
  notion?: AutonomyNotionReader;
  showing?: StudyShowing;
  folder?: HostFolderDesk;
  looks?: AutonomyRoomLooks;
  reachOuts?: AutonomyReachOuts;
  phone?: AutonomyPhone;
  /** Her study in Aether (Syzygy ADR-0007), for a note, a draft or a revision; absent, her study is Shannon's alone. */
  aether?: StudyAether;
}

export function adaptersFor(decision: Pick<AutonomyDecision, 'decision' | 'domain'>, dependencies: StepDependencies): BoundAdapters {
  if (decision.decision !== 'allow') return {};
  switch (decision.domain as ShannonAutonomyDomainId | typeof NOTION_READ_DOMAIN) {
    case 'thinking': return { model: dependencies.model };
    case 'aether_study': return { model: dependencies.model, ...(dependencies.service.studyAether ? { aether: dependencies.service.studyAether } : {}) };
    case 'public_read': return { reader: dependencies.reader };
    // Telling him a story is ready, or one message of her own: the latter also needs the model that words it.
    case 'owner_message': return { showing: dependencies.showing, ...(dependencies.reachOuts ? { reachOuts: dependencies.reachOuts, model: dependencies.model } : {}) };
    // A call to his iPhone: the model that words her opening line, the path her line takes into the Talk, and the phone.
    case AUTONOMY_CALL_DOMAIN: return dependencies.reachOuts && dependencies.phone ? { reachOuts: dependencies.reachOuts, model: dependencies.model, phone: dependencies.phone } : {};
    case NOTION_READ_DOMAIN: return dependencies.notion ? { notion: dependencies.notion } : {};
    case 'host_folder': return { folder: dependencies.service.folder };
    case ROOM_LOOK_DOMAIN: return dependencies.looks ? { looks: dependencies.looks } : {};
    default: return {};
  }
}

export interface StepResult {
  outcome: 'done' | 'failed';
  /** True only for a closed outside result or a known not-sent refusal; false retains uncertain execution. */
  acknowledged?:boolean;
  /** One plain Japanese sentence for the activity record. */
  summary: string;
  usage?: AutonomyModelUsage;
  link?: string;
  /** Replaces the tool name of the request in the record, when the step ended as something narrower. */
  tool?: string;
  /** Why a failed step failed, as a code from a closed set. */
  reasonCode?: string;
  /** What followed a message she sent in this step, as closed facts; kept as the step's observation. */
  observed?: ReachOutFacts;
  /** What it read and wrote, by id, for the provenance mark (`autonomyLoopProvenance.ts`); a write's ids may be added by `commit`. */
  documents?: ToolDocuments;
  /** Writes of the step's product; runs inside the reporting transaction. */
  commit?: (remaining: readonly AutonomyPlannedStep[], at: string) => StepCommit | void;
  /**
   * After the reporting transaction: `true` saved; `false` not saved (the transaction failed); `unknown` another runner
   * had already closed the step, so what became of it is not known here.
   */
  settled?: (saved: boolean | 'unknown') => void;
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

const OUTPUT_TOKENS: Readonly<Record<'note' | 'draft' | 'revise', number>> = Object.freeze({ note: 1_500, draft: 6_000, revise: 6_000 });

/** Null when the step cannot be carried out at all (nothing to note, an unknown piece, no usable model); it is then skipped unasked. */
export function prepareStep(dependencies: StepDependencies, cycle: AutonomyLoopCycle, step: AutonomyPlannedStep, at: string): PreparedStep | null {
  switch (step.kind) {
    case 'think': return prepareThinking(dependencies, cycle, step, at);
    case 'read': return prepareReading(dependencies, cycle, step);
    case 'notion': return prepareNotion(dependencies, cycle, step);
    case 'note': return prepareNote(dependencies, cycle, step, at);
    case 'draft': return prepareDraft(dependencies, cycle, step, at);
    case 'revise': return prepareRevision(dependencies, cycle, step, at);
    case 'show': return prepareShowing(dependencies, cycle, step);
    case 'put_away': return preparePutAway(dependencies, cycle, step);
    // With her study in Aether there are no copies to the folder on the owner's PC (Syzygy ADR-0007 revised: stories live in Aether only).
    // Nor from a session marked by what it read of the owner's (ADR-0007): the folder is not marked.
    case 'copy': return dependencies.service.studyAether?.covers(cycle.scopeKey) || sessionMarked(dependencies, cycle) ? null : prepareFolderCopy(dependencies, cycle, step, at);
    case 'look': return prepareRoomLook(dependencies, cycle, at);
    // In a session marked by what she read of the owner's, she does not speak up while anyone else may see or hear (ADR-0007).
    case 'reach_out': return heldForOthers(dependencies, cycle, at) ? null : step.call ? preparePhoneCall(dependencies, cycle, step, at)
      : step.reason === 'follow_up' ? prepareFollowUp(dependencies, cycle, step, at) : prepareReachOut(dependencies, cycle, step, at);
    case 'jot': return prepareJot(dependencies, cycle, step, at);
    case 'rest': return prepareRest(dependencies, cycle, step);
    case 'tool': return prepareToolStep(dependencies, cycle, step);
    default: return null;
  }
}

function prepareReading(dependencies: StepDependencies, cycle: AutonomyLoopCycle, step: AutonomyPlannedStep): PreparedStep | null {
  const url = step.url;
  if (!url || dependencies.store.loop.wasRead(cycle.scopeKey, url)) return null;
  const host = hostOf(url);
  return {
    request: { domain: 'public_read', summary: `公開ページを1つ読みます（${host}）。`, tool: 'study.read', urls: [url] },
    async perform(adapters, _at, signal) {
      if (!adapters.reader) return { outcome: 'failed', summary: '読む道具が渡されなかったため、読みませんでした。', acknowledged:true };
      try {
        const page = await adapters.reader.read(url, signal);
        return {
          outcome: 'done', summary: `「${clip(page.title, 80)}」を読みました。`, acknowledged:true, ...(page.url.startsWith('https://') ? { link: page.url } : {}),
          commit: (remaining, at) => {
            const reading = dependencies.store.loop.addReading(cycle.scopeKey, {
              url: page.url, title: page.title, text: page.text, links: page.links, ...(step.pursuitId ? { pursuitId: step.pursuitId } : {}),
            }, at);
            dependencies.prediction?.read?.(cycle.scopeKey, { id: reading.id, source: 'public' }, at);
            return { plan: withNoteAfterReading(remaining, reading.id) };
          },
        };
      } catch (error) {
        const code = error instanceof Error ? error.message : '';
        return {
          outcome: 'failed', acknowledged:knownReadRefusal(code),
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
      if (!adapters.notion) return { outcome: 'failed', summary: 'Notionを読む道具が渡されなかったため、読みませんでした。', acknowledged:true };
      try {
        const page = await adapters.notion.read({ query, signal });
        if (!page) return { outcome: 'failed', summary: '共有されたNotionに、探しているページは見つかりませんでした。', acknowledged:true };
        // A shared Notion page is the owner's (owner decision 5, ADR-0007): the session is marked, and so is the reading her note comes from.
        const wrote: string[] = [];
        return {
          outcome: 'done', summary: `Notionの「${clip(page.title, 80)}」を読みました。`, acknowledged:true, documents: { informs: true, wrote },
          commit: (remaining, at) => {
            const reading = dependencies.store.loop.addReading(cycle.scopeKey, {
              url: page.url, title: page.title, text: page.text.slice(0, 6_000), links: [], ...(step.pursuitId ? { pursuitId: step.pursuitId } : {}),
            }, at);
            wrote.push(`${READING_DOCUMENT_PREFIX}${reading.id}`);
            dependencies.prediction?.read?.(cycle.scopeKey, { id: reading.id, source: 'notion' }, at);
            return { plan: withNoteAfterReading(remaining, reading.id) };
          },
        };
      } catch {
        return { outcome: 'failed', summary: 'Notionのページを読めませんでした。', acknowledged:false };
      }
    },
  };
}

function knownReadRefusal(code:string):boolean {
  return /^AUTONOMY_READ_HTTP_[1-5][0-9]{2}$/u.test(code) || ['AUTONOMY_READ_URL_INVALID','AUTONOMY_READ_NOT_PUBLIC',
    'AUTONOMY_READ_ROBOTS_DISALLOWED','AUTONOMY_READ_REDIRECT_LIMIT','AUTONOMY_READ_NOT_TEXT','AUTONOMY_READ_TOO_LARGE','AUTONOMY_READ_EMPTY'].includes(code);
}

function prepareNote(dependencies: StepDependencies, cycle: AutonomyLoopCycle, step: AutonomyPlannedStep, at: string): PreparedStep | null {
  const { store, service } = dependencies;
  const reading = (step.readingId ? store.loop.reading(cycle.scopeKey, step.readingId) : null) ?? store.loop.unnotedReadings(cycle.scopeKey)[0] ?? null;
  if (!reading || reading.notedAt || !reading.text) return null;
  const pursuit = reading.pursuitId ? shownPursuit(dependencies, cycle, store.pursuits.get(cycle.scopeKey, reading.pursuitId)) : null;
  const call = paidCall(dependencies, cycle.scopeKey, 'research_reading', notePrompt({ pursuit, reading, ...ownerWriting(dependencies, cycle.scopeKey, at, `${pursuit?.title ?? ''} ${reading.title}`) }), OUTPUT_TOKENS.note);
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
      // With Aether her note goes to 「シャノン用フォルダ」 first; what Aether refused is not kept here either.
      if(adapters.aether?.covers(cycle.scopeKey))await actionPermit([actionResource(cycle.scopeKey,'study')]);
      const pushed = adapters.aether?.covers(cycle.scopeKey) ? await aetherStep(() => adapters.aether!.create(cycle.scopeKey, { kind: 'note', title: clip(title, 80), body: body.slice(0, STUDY_LIMITS.noteBody).trim() }, studyWriteKey(cycle.scopeKey, `loop:${cycle.id}`, 'note', reading.id), signal)) : null;
      if (pushed && 'reasonCode' in pushed) return { outcome: 'failed', usage, summary: 'メモを書きましたが、Aetherのシャノン用フォルダに置けませんでした。', reasonCode: pushed.reasonCode };
      // A note of a marked page (a shared Notion page) marks its session and itself the moment Aether has it (ADR-0007).
      if (pushed) { if (informedReading(dependencies, cycle, reading.id)) dependencies.store.informed.markSession(cycle.id, at); markEarly(dependencies, cycle, [pushed.value.documentId], at); }
      return {
        outcome: 'done', usage, summary: `メモ「${clip(title, 60)}」を書斎に書きました。`, documents: { read: [`${READING_DOCUMENT_PREFIX}${reading.id}`] },
        commit: (_remaining, commitAt) => {
          const piece = store.study.create(cycle.scopeKey, {
            kind: 'note', title, body: body.slice(0, STUDY_LIMITS.noteBody), sources: [{ title: clip(reading.title, 160) || reading.url, url: reading.url }],
            ...(reading.pursuitId ? { pursuitId: reading.pursuitId } : {}), model: call.model,
          }, commitAt);
          if (typeof piece === 'string') throw new Error(piece);
          if (pushed) adapters.aether!.commit(cycle.scopeKey, piece, pushed.value);
          store.loop.markReadingNoted(cycle.scopeKey, reading.id, commitAt);
          dependencies.prediction?.noted?.(cycle.scopeKey, reading.id, commitAt);
          if (question && questionWhy) service.addPursuit(cycle.scopeKey, { kind: 'question', title: question, why: questionWhy, origin: 'self' });
          return { link: `shannon-study://${piece.id}` };
        },
      };
    },
  };
}

function prepareDraft(dependencies: StepDependencies, cycle: AutonomyLoopCycle, step: AutonomyPlannedStep, at: string): PreparedStep | null {
  const { store } = dependencies;
  // In a session she is told when her study has no room for another story, and a draft that could not be kept is not paid for.
  if (sessionOf(dependencies, cycle) && openStories(dependencies, cycle.scopeKey) >= STUDY_LIMITS.openStories) return null;
  const pursuit = step.pursuitId ? shownPursuit(dependencies, cycle, store.pursuits.get(cycle.scopeKey, step.pursuitId)) : null;
  const call = paidCall(dependencies, cycle.scopeKey, 'prose', draftPrompt({
    idea: step.intent ?? '', pursuit, notes: storyNotes(store, cycle.scopeKey, step.pursuitId, 5, false, unmarkedOnly(dependencies, cycle)), ...ownerWriting(dependencies, cycle.scopeKey, at, `${step.intent ?? ''} ${pursuit?.title ?? ''}`),
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
      // With Aether the story goes to 「シャノンの書斎」 first (`inStudy: true`), the canonical copy.
      if(adapters.aether?.covers(cycle.scopeKey))await actionPermit([actionResource(cycle.scopeKey,'study')]);
      const pushed = adapters.aether?.covers(cycle.scopeKey) ? await aetherStep(() => adapters.aether!.create(cycle.scopeKey, { kind: 'story', title: clip(title, 80), body, changeNote: text(reply?.note, STUDY_LIMITS.changeNote) ?? '最初の稿です。' }, studyWriteKey(cycle.scopeKey, `loop:${cycle.id}`, 'draft', title), signal)) : null;
      if (pushed && 'reasonCode' in pushed) return { outcome: 'failed', usage, summary: '物語の下書きを書きましたが、Aetherの書斎に置けませんでした。', reasonCode: pushed.reasonCode };
      if (pushed) markEarly(dependencies, cycle, [pushed.value.documentId], at);
      return {
        // The title stays hers until she calls the piece 「見せてもいい」.
        outcome: 'done', usage, summary: '書斎に、短い物語の下書きを1つ書きました。まだ見せていません。',
        commit: (_remaining, commitAt) => {
          const piece = store.study.create(cycle.scopeKey, {
            kind: 'story', title, body, changeNote: text(reply?.note, STUDY_LIMITS.changeNote) ?? '最初の稿です。',
            ...(pursuit ? { pursuitId: pursuit.id } : {}), model: call.model,
          }, commitAt);
          if (typeof piece === 'string') throw new Error(piece);
          if (pushed) adapters.aether!.commit(cycle.scopeKey, piece, pushed.value);
          return { link: `shannon-study://${piece.id}` };
        },
      };
    },
  };
}

function prepareRevision(dependencies: StepDependencies, cycle: AutonomyLoopCycle, step: AutonomyPlannedStep, at: string): PreparedStep | null {
  const { store } = dependencies;
  const piece = step.pieceId ? store.study.get(cycle.scopeKey, step.pieceId) : null;
  if (!piece || piece.kind !== 'story' || piece.status === 'put_away') return null;
  // Its Aether document is longer than she reads whole: no paid revision that could not be written anyway.
  if (store.study.aether.tooLongPiece(cycle.scopeKey, piece.id)) return null;
  // Reader feedback goes to this revising step, and is marked used only when the revision is saved.
  const feedback = store.study.pendingFeedback(cycle.scopeKey, piece.id);
  const call = paidCall(dependencies, cycle.scopeKey, 'prose', revisePrompt({
    aim: step.intent ?? '', piece: { title: piece.title, body: piece.body, version: piece.version },
    feedback: feedback.map(item => ({ reactionLabel: STUDY_REACTION_LABEL[item.reaction], comment: item.comment, version: item.version })),
    notes: storyNotes(store, cycle.scopeKey, piece.pursuitId, 3, false, unmarkedOnly(dependencies, cycle)), ...ownerWriting(dependencies, cycle.scopeKey, at, `${step.intent ?? ''} ${piece.title}`),
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
      const title = text(reply?.title, 60) ?? piece.title;
      // A story that lives in Aether is revised there first, from the version she read (`baseVersion`); a stale one brings the newer text in.
      if(adapters.aether?.covers(cycle.scopeKey))await actionPermit([actionResource(cycle.scopeKey,'study')]);
      const pushed = adapters.aether?.covers(cycle.scopeKey) ? await aetherStep(() => adapters.aether!.update(cycle.scopeKey, piece, { title: clip(title, 80), body, changeNote: change }, studyWriteKey(cycle.scopeKey, `loop:${cycle.id}`, 'revise', piece.id, String(piece.version)), signal)) : null;
      if (pushed && 'reasonCode' in pushed) return { outcome: 'failed', usage, summary: '物語を直しましたが、Aetherの書斎に書けませんでした。', reasonCode: pushed.reasonCode };
      if (pushed?.value) markEarly(dependencies, cycle, [pushed.value.documentId], at);
      return {
        // Revising a marked piece is opening it on purpose: the session is marked (ADR-0007).
        outcome: 'done', usage, link: `shannon-study://${piece.id}`, documents: { read: [`shannon-study://${piece.id}`] },
        summary: seen ? `物語「${clip(piece.title, 60)}」を直しました（第${piece.version + 1}稿）。` : `物語の下書きを直しました（第${piece.version + 1}稿）。まだ見せていません。`,
        commit: (_remaining, commitAt) => {
          const revised = store.study.revise(cycle.scopeKey, piece.id, { title, body, changeNote: change, model: call.model }, commitAt);
          if (typeof revised === 'string') throw new Error(revised);
          if (pushed?.value) adapters.aether!.commit(cycle.scopeKey, revised, pushed.value);
          store.study.markFeedbackUsed(cycle.scopeKey, feedback.map(item => item.id), commitAt);
        },
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

/**
 * While the owner's context is switched on, what she writes in her study may draw on it (owner decision 2026-10-02): the prompt
 * carries the rule that says so and the block built for her writing, without anything that must reach nobody but the owner.
 */
function ownerWriting(dependencies: StepDependencies, scopeKey: string, at: string, topic: string): { ownerInformed?: true; ownerContext?: string } {
  if (!dependencies.loop.ownerContext || !dependencies.ownerContext) return {};
  let block: string | null = null;
  try { block = dependencies.ownerContext.forWriting(scopeKey, at, topic)?.section ?? null; } catch { block = null; }
  return { ownerInformed: true, ...(block ? { ownerContext: block } : {}) };
}

/** Whether a page she read is marked (a shared Notion page); one that cannot be read counts as marked. */
function informedReading(dependencies: StepDependencies, cycle: AutonomyLoopCycle, readingId: string): boolean {
  try { return dependencies.store.informed.marked(cycle.scopeKey, `${READING_DOCUMENT_PREFIX}${readingId}`); } catch { return true; }
}

/** A pursuit as a prompt of this session may name it: not one marked, in a session that is not (ADR-0007). */
function shownPursuit<T extends { id: string }>(dependencies: StepDependencies, cycle: AutonomyLoopCycle, pursuit: T | null): T | null {
  return pursuit && unmarkedPursuits(dependencies, cycle)(pursuit) ? pursuit : null;
}

/**
 * Why a planned step could not be carried out when its turn came, as `<action>.<why>` from closed sets: for her next
 * thought (`unplannedSection`) and the log. Never a word of the step.
 */
export function unpreparedCode(dependencies: Pick<StepDependencies, 'store'>, cycle: Pick<AutonomyLoopCycle, 'scopeKey'>, step: AutonomyPlannedStep): string {
  if (step.kind === 'draft' && openStories(dependencies, cycle.scopeKey) >= STUDY_LIMITS.openStories) return 'draft.study_full';
  if (step.kind === 'read' && step.url && dependencies.store.loop.wasRead(cycle.scopeKey, step.url)) return 'read.already_read';
  if (step.kind === 'note' && !dependencies.store.loop.unnotedReadings(cycle.scopeKey).some(reading => reading.text)) return 'note.nothing_read';
  return `${step.kind === 'reach_out' && step.call ? 'call' : step.kind === 'reach_out' && step.reason === 'follow_up' ? 'follow_up' : step.kind}.unavailable`;
}

/** Stories that are open in her study: drafts and those she called 「見せてもいい」. */
export function openStories(dependencies: Pick<StepDependencies, 'store'>, scopeKey: string): number {
  return dependencies.store.study.list(scopeKey).filter(piece => piece.kind === 'story' && (piece.status === 'draft' || piece.status === 'ready')).length;
}
