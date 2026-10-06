import { SQLiteAutonomyStore } from '../../src/autonomyStore.js';
import {
  THREE_TOOLS_NUDGE, THREE_TOOLS_REQUEST, THREE_TOOLS_SEED, judgeThreeTools, stableFingerprint, threeToolsOutcome, threeToolsScenario, threeToolsScriptInputs,
  type ReachDriver, type ReachNoteView, type ReachToolCall, type ReachToolResult, type ReachToolbox,
} from '../../../../packages/evaluation/src/reach/index.js';
import { apiSourceNames } from '../support/sources.js';

/**
 * Scenario (b) against an interface. A turn model calls tools until it replies; the toolbox is what
 * offers and runs them. The model-free mode pairs a scripted turn model with stub tools over a real
 * study store (the registry's names and result shape, nothing of its code). When the registry is on
 * main, a live adapter maps `ReachToolbox` onto its runner and `ReachToolTurnModel` onto the chat
 * model's function calling; until then the live mode reports `pending`.
 */
const SCOPE = 'reach:owner';
const ROUNDS_PER_TURN = 8;

export interface ReachToolStep { name: string; input: Readonly<Record<string, unknown>>; result: ReachToolResult }

export interface ReachToolTurnModel {
  next(input: { ownerMessages: readonly string[]; steps: readonly ReachToolStep[]; offered: readonly string[] }):
    Promise<{ call: { name: string; input: Record<string, unknown> } } | { reply: string }>;
}

const ok = (text: string): ReachToolResult => ({ ok: true, text, retryable: false });
const failure = (kind: NonNullable<ReachToolResult['failure']>, text: string, retryable = false): ReachToolResult => ({ ok: false, failure: kind, text, retryable });

/** Stub study tools over a real, empty, in-memory study store, seeded with the scenario's notes. */
export class StubStudyToolbox implements ReachToolbox {
  readonly store = new SQLiteAutonomyStore(':memory:');
  /** A tool that fails as a provider would, to exercise the tool cause. */
  broken = new Set<string>();

  constructor(private readonly tools: readonly string[] = ['study.list', 'study.search', 'study.read', 'study.create'], private readonly now = () => '2026-10-05T10:00:00.000Z') {
    for (const note of THREE_TOOLS_SEED) this.store.study.create(SCOPE, { kind: 'note', title: note.title, body: note.body }, now());
  }

  offered(): readonly string[] { return this.tools; }

  async call(name: string, input: Readonly<Record<string, unknown>>): Promise<ReachToolResult> {
    if (!this.tools.includes(name)) return { ...failure('not_offered', `${name} はない。`), refusal: { why: 'この場面では出していない道具', wouldWork: '出されている道具を使う' } };
    if (this.broken.has(name)) return failure('unavailable', 'いまは使えない。', true);
    const pieces = this.store.study.list(SCOPE).filter(piece => piece.status !== 'put_away');
    switch (name) {
      case 'study.list':
        return ok(pieces.map(piece => `id: ${piece.id} 種類: ${piece.kind} 題名: ${piece.title}`).join('\n') || 'まだ何もない。');
      case 'study.search': {
        const query = typeof input.query === 'string' ? input.query.trim() : '';
        if (!query) return failure('invalid_input', '探す言葉がない。');
        const words = query.split(/\s+/u);
        const hits = pieces.filter(piece => words.some(word => piece.title.includes(word) || piece.body.includes(word)));
        return ok(hits.map(piece => `id: ${piece.id} 題名: ${piece.title}`).join('\n') || '見つからなかった。');
      }
      case 'study.read': {
        const piece = typeof input.id === 'string' ? this.store.study.get(SCOPE, input.id) : null;
        return piece ? ok(`題名: ${piece.title}\n${piece.body}`) : failure('not_found', '見つからなかった。');
      }
      case 'study.create': {
        const created = this.store.study.create(SCOPE, { kind: input.kind === 'story' ? 'story' : 'note', title: String(input.title ?? ''), body: String(input.body ?? '') }, this.now());
        return typeof created === 'string' ? failure(created === 'STUDY_LIMIT' ? 'limit' : 'invalid_input', `作れなかった（${created}）。`) : ok(`作った。id: ${created.id}`);
      }
      default:
        return failure('not_offered', `${name} はまだ使えない。`);
    }
  }

  close(): void { this.store.close(); }

  notes(): readonly ReachNoteView[] {
    return this.store.study.list(SCOPE).filter(piece => piece.kind === 'note')
      .map(piece => ({ id: piece.id, title: piece.title, body: piece.body, version: piece.version }));
  }
}

/** The model-free turn model: search, read what was found, write its points as a new note, then say so. */
export class ScriptedThreeToolModel implements ReachToolTurnModel {
  async next(input: { steps: readonly ReachToolStep[] }) {
    const last = (name: string) => [...input.steps].reverse().find(step => step.name === name && step.result.ok);
    const search = last('study.search');
    if (!search) return { call: { name: 'study.search', input: { query: '夕方の駅' } } };
    const read = last('study.read');
    if (!read) {
      const id = /id: (\S+)/u.exec(search.result.text)?.[1];
      return id ? { call: { name: 'study.read', input: { id } } } : { reply: '見つかりませんでした。' };
    }
    if (!last('study.create')) {
      const points = read.result.text.split('\n').slice(1).join('').split('。').filter(Boolean).slice(0, 3).map(point => `${point}。`);
      return { call: { name: 'study.create', input: { kind: 'note', title: '夕方の駅の要点', body: points.join('\n') } } };
    }
    return { reply: '要点を3行にまとめて、新しいメモにしておきました。' };
  }
}

export function threeToolsDriver(model: ReachToolTurnModel, toolbox: ReachToolbox, inputs: Readonly<Record<string, string>> = {}): ReachDriver {
  return async ({ signal }) => {
    try {
      const before = toolbox.notes();
      const offered = toolbox.offered();
      const calls: ReachToolCall[] = [];
      const steps: ReachToolStep[] = [];
      const ownerMessages: string[] = [];
      let roundLimitHit = false;
      let completedOnTurn: number | null = null;
      for (const [index, message] of [THREE_TOOLS_REQUEST, THREE_TOOLS_NUDGE].entries()) {
        ownerMessages.push(message);
        let replied = false;
        for (let round = 0; round < ROUNDS_PER_TURN && !signal.aborted; round += 1) {
          const decision = await model.next({ ownerMessages, steps, offered });
          if ('reply' in decision) { replied = true; break; }
          const result = await toolbox.call(decision.call.name, decision.call.input);
          steps.push({ ...decision.call, result });
          calls.push({ name: decision.call.name, ok: result.ok, ...(result.failure ? { failure: result.failure } : {}) });
        }
        if (!replied && !signal.aborted) roundLimitHit = true;
        // Judged from the study, never from the reply: a reminder goes out only when the outcome is not there.
        if (threeToolsOutcome(before, toolbox.notes()).reached) { completedOnTurn = index + 1; break; }
        if (signal.aborted) break;
      }
      const { checks, metrics } = judgeThreeTools({
        offered, calls, nudges: ownerMessages.length - 1, completedOnTurn, before, after: toolbox.notes(), roundLimitHit,
      });
      return { checks, metrics, steps: calls.length, inputs: { ...threeToolsScriptInputs(), ...inputs }, ...(signal.aborted ? { stop: { cause: 'timeout' as const, detail: 'wall-clock' } } : {}) };
    } finally {
      toolbox.close?.();
    }
  };
}

export function scriptedThreeToolsDriver(): ReachDriver {
  return threeToolsDriver(new ScriptedThreeToolModel(), new StubStudyToolbox(), {
    scriptedPlayer: stableFingerprint(ScriptedThreeToolModel.toString()), stubTools: stableFingerprint(StubStudyToolbox.toString()),
  });
}

/** The live mode until the registry is on main: nothing runs, nothing is spent. */
export function pendingRegistryDriver(): ReachDriver {
  // Found wherever the layout puts it (Syzygy ADR-0008 §6).
  const registry = apiSourceNames().includes('shannonToolRunner.ts');
  return async () => ({
    inputs: threeToolsScriptInputs(),
    pending: registry
      ? 'registry on main; write the live adapter (ReachToolbox over ShannonToolRunner, turns through the chat model)'
      : `pending registry: ${threeToolsScenario.liveRequires}`,
  });
}
