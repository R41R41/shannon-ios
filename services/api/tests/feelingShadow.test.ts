import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { switchOn } from '@shannon/switches';
import { reactionHarness, scope, SECOND } from './bodyReactionHarness.js';
import { composedFeeling } from '../src/wiring/feelingWiring.js';
import { SQLiteFeelingShadowStore } from '../src/mind/emotion/store/feelingShadowStore.js';
import { installObserverSink, withObserverRun } from '../src/infra/observer/observerContext.js';

/**
 * The stage-2 shadow (Syzygy ADR-0013, `SHANNON_CORE_AFFECT`): her fast layer folded from her events is written beside the current
 * state, and shown to the Observer, and nothing of hers changes: the same replies, prompts and faces as without it.
 */
const DAY = '2026-10-14T04:00:00.000Z';

async function play(shadow: boolean) {
  const database = new DatabaseSync(':memory:');
  const clock = { at: DAY };
  let harness: Awaited<ReturnType<typeof reactionHarness>> | null = null;
  const configured = composedFeeling({ database, now: () => clock.at, timeZone: 'Asia/Tokyo', chooser: null, turn: false, singleFace: false,
    ...(shadow ? { shadow: { database, snapshot: (scopeKey: string) => harness!.stateStore.snapshot(scopeKey) } } : {}) });
  harness = await reactionHarness({ feeling: configured.port, stage2: false });
  const at = (instant: string) => { harness!.clock.at = instant; clock.at = instant; };
  at(DAY);
  harness.speaker.decision = { say: true, text: 'いやです', feeling: 'annoyed', stance: 'dislike' };
  await harness.react({ type: 'poke', part: 'chest' });
  for (const [index, offset] of [40, 80, 120].entries()) {
    at(new Date(Date.parse(DAY) + offset * SECOND).toISOString());
    await harness.react({ type: 'poke', part: 'chest' }, { id: `again-${index}`, reply: 'none' });
  }
  at(new Date(Date.parse(DAY) + 200 * SECOND).toISOString());
  await harness.send('POST', '/v1/chat', { message: 'お前ポンコツだな' }, 'iphone');
  return { database, harness };
}

describe('the stage-2 shadow (SHANNON_CORE_AFFECT)', () => {
  it('is off by default', () => {
    expect(switchOn({}, 'SHANNON_CORE_AFFECT')).toBe(false);
  });

  it('writes each event\'s fast-layer point beside the current state, with blame building after her no', async () => {
    const events: { input?: unknown; output?: unknown }[] = [];
    const stop = installObserverSink(event => { if ((event.input as { phase?: string } | undefined)?.phase === 'feeling.core_affect') events.push(event); });
    const { database } = await withObserverRun({ scopeKey: scope, surface: 'test' }, () => play(true));
    stop();
    const series = new SQLiteFeelingShadowStore(database).series(scope, 'owner', 'owner_alone', '2026-10-13T00:00:00.000Z');
    const touches = series.filter(point => point.kind === 'touched');
    expect(touches).toHaveLength(4);
    expect(touches.slice(1).map(point => point.blame)).toEqual([...touches.slice(1).map(point => point.blame)].sort((a, b) => a - b));
    expect(touches.at(-1)!.label).toMatch(/annoyed|angry/u);
    expect(series.some(point => point.kind === 'spoke')).toBe(true);
    const row = database.prepare('SELECT current_valence FROM shannon_feeling_shadow WHERE scope_key = ? LIMIT 1').get(scope) as { current_valence: number | null };
    expect(typeof row.current_valence).toBe('number');
    expect(events.length).toBeGreaterThan(0);
  });

  it('changes nothing of hers: the same prompts and faces with and without the shadow, and no table without it', async () => {
    const off = await play(false);
    const on = await play(true);
    const strip = (text: string | undefined) => (text ?? '').replace(/[0-9a-f]{8}-[0-9a-f-]{27}/gu, 'id');
    expect(strip(on.harness.chatModel.requests.at(-1)!.turnContext)).toBe(strip(off.harness.chatModel.requests.at(-1)!.turnContext));
    expect(on.harness.speaker.prompts).toEqual(off.harness.speaker.prompts);
    expect(off.database.prepare("SELECT name FROM sqlite_master WHERE name = 'shannon_feeling_shadow'").get()).toBeUndefined();
  });
});
