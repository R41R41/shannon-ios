import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { configuredAutonomy } from '../../src/mind/inhibition/autonomyBudget.js';
import { ShannonAutonomyLoop } from '../../src/mind/action/ownTime/autonomyLoop.js';
import { configuredAutonomyLoop } from '../../src/mind/action/ownTime/autonomyLoopConfig.js';
import { ShannonAutonomyService } from '../../src/mind/action/ownTime/autonomyService.js';
import { SQLiteAutonomyStore } from '../../src/mind/action/ownTime/store/autonomyStore.js';
import type { AutonomyTextModel, AutonomyTextRequest, AutonomyTextResult } from '../../src/mind/action/ownTime/autonomyTextModel.js';
import { FakeModel, FakeReader, FakeShowing, STORY_BODY, callKind } from '../autonomyLoopHarness.js';
import {
  AUTONOMY_DAY_BUDGET_YEN, autonomyDayScenario, judgeAutonomyDay, stableFingerprint, type AutonomyDayEvidence, type ReachDriver,
} from '../../../../packages/evaluation/src/reach/index.js';

/**
 * Scenario (c) in a sandbox: her real loop, service and gate over a temporary database, a clock this
 * driver moves, one local day (07:00 to 24:00 in Tokyo), a small budget, canned public pages (nothing is
 * fetched), and a stand-in inbox that records what she tells the owner. No owner context, no messages of
 * her own, no calls, no looks: the day is about reading, writing and showing.
 */
const SCOPE = 'owner';
const DAY_START = '2026-10-05T22:00:00.000Z';
const DAY_END = Date.parse('2026-10-06T15:00:00.000Z');
const STEP_MILLISECONDS = 60_000;
const WAIT_MILLISECONDS = 5 * 60_000;

export interface AutonomyDayOptions {
  budgetYen?: number;
  /** Prices of her models (`SHANNON_AUTONOMY_MODEL_PRICES_JSON`) and other loop settings of the sandbox. */
  environment?: Readonly<Record<string, string>>;
  /** Live: her model ids and the price table she ran with, by id and fingerprint (never a credential). */
  inputs?: Readonly<Record<string, string>>;
  /** The model-free player: its source is fingerprinted with the sandbox, so a changed script is not compared. */
  scripted?: true;
}

/**
 * Sees each thinking prompt on its way to the model and checks it against her study at that moment: a story
 * that was open but not listed is context the build lost, whatever she then decides.
 */
export class ThinkingWatch implements AutonomyTextModel {
  prompts = 0;
  missingStories = 0;

  constructor(private readonly inner: AutonomyTextModel, private readonly store: SQLiteAutonomyStore) {}

  canUse(modelId: string): boolean { return this.inner.canUse(modelId); }

  async generate(request: AutonomyTextRequest): Promise<AutonomyTextResult> {
    if (callKind(request) === 'think') {
      this.prompts += 1;
      const text = `${request.system}\n${request.prompt}`;
      const open = this.store.study.list(SCOPE).filter(piece => piece.kind === 'story' && piece.status !== 'put_away');
      if (open.some(piece => !text.includes(`(${piece.id})`))) this.missingStories += 1;
    }
    return this.inner.generate(request);
  }
}

/** The sandbox as fingerprint inputs: its settings, its day, its canned pages, and (model-free) the scripted player. */
function sandboxInputs(environment: Readonly<Record<string, string>>, scripted: boolean): Record<string, string> {
  return {
    sandbox: stableFingerprint({ environment, DAY_START, DAY_END, STEP_MILLISECONDS, WAIT_MILLISECONDS }),
    cannedPages: stableFingerprint([FakeReader.toString(), FakeShowing.toString()]),
    ...(scripted ? { scriptedPlayer: stableFingerprint([scriptedAutonomyModel.toString(), FakeModel.toString(), callKind.toString(), STORY_BODY]) } : {}),
  };
}

export function autonomyDayDriver(model: AutonomyTextModel, options: AutonomyDayOptions = {}): ReachDriver {
  return async ({ signal, mode }) => {
    const directory = mkdtempSync(join(tmpdir(), 'shannon-reach-c-'));
    const path = join(directory, 'autonomy.sqlite');
    const budget = options.budgetYen ?? AUTONOMY_DAY_BUDGET_YEN;
    try {
      let at = DAY_START;
      const now = () => at;
      const environment = {
        SHANNON_AUTONOMY_ENABLED: 'true', SHANNON_AUTONOMY_DAILY_BUDGET_YEN: String(budget), SHANNON_AUTONOMY_MAX_EXTRA_YEN: '0',
        SHANNON_AUTONOMY_MAX_FOLLOW_UPS: '0', SHANNON_AUTONOMY_MAX_REACH_OUTS: '0', SHANNON_AUTONOMY_OWNER_CONTEXT: 'off',
        SHANNON_AUTONOMY_PACING: 'sessions', SHANNON_OWNER_SCOPE_KEY: SCOPE, ...options.environment,
      };
      const store = new SQLiteAutonomyStore(path);
      const watch = new ThinkingWatch(model, store);
      const config = configuredAutonomy(environment);
      const service = new ShannonAutonomyService({ store, config, now });
      const showing = new FakeShowing();
      const loop = new ShannonAutonomyLoop({
        store, service, config, loop: configuredAutonomyLoop(environment), model: watch, reader: new FakeReader(), showing, now, workerId: 'reach-sandbox',
        wait: async (milliseconds: number) => { at = new Date(Date.parse(at) + milliseconds).toISOString(); },
      });
      const ticks: Record<string, number> = {};
      let ended: AutonomyDayEvidence['ended'] = 'day_end';
      try {
        for (let count = 0; Date.parse(at) < DAY_END; count += 1) {
          if (signal.aborted) { ended = 'wall_clock'; break; }
          if (count >= autonomyDayScenario.limits.maximumSteps) { ended = 'tick_limit'; break; }
          const tick = await loop.tick(signal);
          ticks[tick] = (ticks[tick] ?? 0) + 1;
          if (tick === 'not-configured' || tick === 'disabled' || tick === 'budget') break;
          if (tick === 'stepped' || tick === 'cycle-ended') {
            at = new Date(Date.parse(at) + STEP_MILLISECONDS).toISOString();
            continue;
          }
          // Nothing to do now: on to her next session, or a little later.
          const next = Date.parse(store.loop.nextCycleAt(SCOPE) ?? '') || 0;
          at = new Date(Math.max(Date.parse(at) + WAIT_MILLISECONDS, next)).toISOString();
        }
      } finally {
        loop.release();
        store.close();
      }
      const evidence = dayEvidence(path, {
        budgetCapYen: budget, toldOwner: showing.told.length, ticks, ended, thinkPrompts: watch.prompts, thinkPromptsMissingStories: watch.missingStories,
      });
      const { checks, metrics } = judgeAutonomyDay(evidence.day);
      return {
        checks, metrics, steps: Object.values(ticks).reduce((sum, count) => sum + count, 0),
        inputs: { ...sandboxInputs(environment, options.scripted === true), ...options.inputs },
        ...(ended === 'wall_clock' ? { stop: { cause: 'timeout' as const, detail: 'wall-clock' } } : {}),
        cost: { ...evidence.cost, measured: mode === 'live' },
      };
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  };
}

/** Read from outside, from the closed database file: the record, the spend, the sessions, the study. */
function dayEvidence(path: string, input: Pick<AutonomyDayEvidence, 'budgetCapYen' | 'toldOwner' | 'ticks' | 'ended' | 'thinkPrompts' | 'thinkPromptsMissingStories'>) {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const count = (sql: string) => Number((database.prepare(sql).get() as { count: number }).count);
    const spend = database.prepare(`
      SELECT COUNT(*) AS calls, COALESCE(SUM(input_tokens), 0) AS input, COALESCE(SUM(output_tokens), 0) AS output, COALESCE(SUM(cost_yen), 0) AS yen
      FROM autonomy_spend
    `).get() as { calls: number; input: number; output: number; yen: number };
    const sessionEnds = Object.fromEntries((database.prepare(`
      SELECT end_code AS code, COUNT(*) AS count FROM autonomy_loop_sessions WHERE ended_at IS NOT NULL GROUP BY end_code
    `).all() as Array<{ code: string; count: number }>).map(row => [row.code, Number(row.count)]));
    const yen = Math.round(Number(spend.yen) * 100) / 100;
    const day: AutonomyDayEvidence = {
      ...input, spentYen: yen, sessionEnds,
      storiesShown: count(`SELECT COUNT(*) AS count FROM autonomy_activity WHERE kind = 'action' AND tool = 'study.show' AND outcome = 'done'`),
      storiesReady: count(`SELECT COUNT(*) AS count FROM study_pieces WHERE kind = 'story' AND readable_version IS NOT NULL AND status IN ('ready', 'shown')`),
      storyDrafts: count(`SELECT COUNT(*) AS count FROM study_pieces WHERE kind = 'story' AND status = 'draft'`),
      notes: count(`SELECT COUNT(*) AS count FROM study_pieces WHERE kind = 'note'`),
      failedActions: count(`SELECT COUNT(*) AS count FROM autonomy_activity WHERE kind = 'action' AND outcome = 'failed'`),
      failedModelCalls: count(`SELECT COUNT(*) AS count FROM autonomy_activity WHERE kind = 'action' AND outcome = 'failed' AND reason_code = 'model_failed'`),
    };
    return { day, cost: { calls: Number(spend.calls), inputTokens: Number(spend.input), outputTokens: Number(spend.output), yen, promptCharacters: 0 } };
  } finally {
    database.close();
  }
}

/**
 * The model-free player of her day: read and note, draft, call the draft 「見せてもいい」 and rest; once a
 * story is out, rest. It decides from the prompt alone (the story lines of her study), like a model would.
 */
export function scriptedAutonomyModel(): FakeModel {
  const model = new FakeModel();
  model.during = (kind, request) => {
    if (kind !== 'think') return;
    const text = `${request.system}\n${request.prompt}`;
    const stories = [...text.matchAll(/- \(([^)\s]+)\) 「[^」]*」 (下書き|見せてもいい|見せた)・第/gu)].map(match => ({ id: match[1]!, status: match[2]! }));
    const rest = (minutes: number, reason: string) => ({ action: 'rest', resumeInMinutes: minutes, reason });
    if (stories.some(story => story.status !== '下書き')) {
      model.plans = [{ thought: '物語は見せました。今日はゆっくりします。', steps: [rest(300, '見せた物語の感想を待ちます。')] }];
    } else if (stories.length) {
      model.plans = [{ thought: '書いた物語を見せます。', steps: [{ action: 'ready', pieceId: stories[0]!.id }, rest(240, '物語を見せたので、少し休みます。')] }];
    } else {
      const url = /https?:\/\/[^\s)」"…]+/u.exec(text)?.[0] ?? 'https://www.aozora.gr.jp/';
      model.plans = [{ thought: '読んで、メモにして、短い物語を書いてみます。', steps: [{ action: 'read', url }, { action: 'note' }, { action: 'draft', idea: '誰もいない駅に残された傘の話' }] }];
    }
  };
  return model;
}

export function scriptedAutonomyDayDriver(options: AutonomyDayOptions = {}): ReachDriver {
  return autonomyDayDriver(scriptedAutonomyModel(), { ...options, scripted: true });
}
