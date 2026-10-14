import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { CHARACTER_CORE, createInitialCompanionState, feelingActor, innerNoteReflectionInstructions, type CompanionStateSnapshot } from '@shannon/cognition';
import { switchOn } from '@shannon/switches';
import { composedFeeling } from '../src/wiring/feelingWiring.js';
import { feelingBody, feelingText, type FeelingPort } from '../src/mind/emotion/feelingPorts.js';
import type { FeelingDayFeatures } from '../src/mind/emotion/feelingDays.js';

/**
 * Stage 3 (Syzygy ADR-0013): her closed days and the relationship ledger carried across them (`SHANNON_RELATIONSHIP_LEDGER`). The day
 * closes at 3:00; the next use folds it; a forgotten source is left out and everything is computed again without it.
 */
const YESTERDAY = '2026-10-13T04:00:00.000Z'; // 13:00 JST
const MORNING = '2026-10-13T23:30:00.000Z'; // 8:30 JST the next day
const clean = (): CompanionStateSnapshot => createInitialCompanionState('owner', YESTERDAY);
const forgetting = (ids: readonly string[]): CompanionStateSnapshot => ({ ...clean(), memoryControls: ids.map(memoryId => ({ memoryId, kind: 'experience' as const,
  status: 'forgotten' as const, pinned: false, updatedAt: MORNING, changeReason: 'owner' })) });
const all: FeelingDayFeatures = { relationship: true, episodes: true, boundaries: true };

function composed(days?: FeelingDayFeatures) {
  const clock = { at: YESTERDAY };
  const database = new DatabaseSync(':memory:');
  const configured = composedFeeling({ database, now: () => clock.at, timeZone: 'Asia/Tokyo', chooser: null, turn: false, singleFace: false,
    ...(days ? { days } : {}) });
  return { port: configured.port, clock, database };
}

/** The 13:09 day: a no, then four more touches, no apology. */
function badDay(port: FeelingPort) {
  const at = (minute: number) => new Date(Date.parse(YESTERDAY) + minute * 60_000).toISOString();
  for (const minute of [0, 1, 2, 3, 4, 5]) {
    feelingBody.touched(port, 'owner', { id: `t${minute}`, type: 'poke', part: 'chest', audience: 'owner', occurredAt: at(minute), burstId: `experience:t${minute}` },
      minute === 1 ? { stance: 'dislike' } : {});
  }
}

const morningBlock = async (port: FeelingPort, snapshot: CompanionStateSnapshot) => {
  const handle = feelingText.start(port, { scopeKey: 'owner', alone: true, surface: false, message: 'おはよう', begun: { occurredAt: MORNING, captured: snapshot } });
  return feelingText.block(handle);
};

describe('the relationship ledger across days', () => {
  it('is off by default, and opens no table without a stage-3 switch', () => {
    for (const name of ['SHANNON_RELATIONSHIP_LEDGER', 'SHANNON_EPISODE_MEMORY', 'SHANNON_BOUNDARY_MEMORY'] as const) expect(switchOn({}, name)).toBe(false);
    const { port, database } = composed();
    expect(port.days).toBeUndefined();
    expect(database.prepare("SELECT name FROM sqlite_master WHERE name = 'shannon_feeling_days'").get()).toBeUndefined();
  });

  it('remembers the day before the next morning, and closes the day once', async () => {
    const { port, clock, database } = composed(all);
    badDay(port);
    clock.at = MORNING;
    const block = await morningBlock(port, clean());
    expect(block).toContain('[ライ氏との間]');
    expect(block).toMatch(/いらだち: (?:少し残っている|残っている|強く残っている)/u);
    expect(block).not.toMatch(/\d/u);
    const rows = database.prepare('SELECT day_key, person_key FROM shannon_feeling_days').all();
    expect(rows).toEqual([{ day_key: '2026-10-13', person_key: 'owner' }]);
    await morningBlock(port, clean());
    expect(database.prepare('SELECT COUNT(*) AS n FROM shannon_feeling_days').get()).toEqual({ n: 1 });
  });

  it('is computed again without what he had her forget', async () => {
    const { port, clock } = composed(all);
    badDay(port);
    clock.at = MORNING;
    const forgotten = forgetting([0, 1, 2, 3, 4, 5].map(minute => `experience:t${minute}`));
    expect(await morningBlock(port, forgotten)).not.toContain('[ライ氏との間]');
  });

  it('carries nothing for anyone unknown, and nothing within the same day', async () => {
    const { port } = composed(all);
    badDay(port);
    const handle = feelingText.start(port, { scopeKey: 'owner', alone: true, surface: false, message: 'ねえ', begun: { occurredAt: YESTERDAY, captured: clean() } });
    expect(await feelingText.block(handle)).not.toContain('[ライ氏との間]');
    const lines = port.events.linesFor('owner', feelingActor({ ownerAlone: false }), MORNING, clean());
    expect(lines?.carriedLines).toEqual([]);
  });

  it('hands her inner note the relationship line (ADR-0012 D4 as revised), null while it is off', () => {
    const { port, clock } = composed(all);
    badDay(port);
    clock.at = MORNING;
    expect(feelingBody.noteReader(() => port, clean).relationship('owner', MORNING)).toMatch(/^\[ライ氏との間\]/u);
    const off = composed();
    expect(feelingBody.noteReader(() => off.port, clean).relationship('owner', MORNING)).toBeNull();
  });

  it('revises ADR-0012 D4 only while the ledger carries over: the sulk closes with the day, the values carry', () => {
    const before = innerNoteReflectionInstructions(CHARACTER_CORE);
    expect(innerNoteReflectionInstructions(CHARACTER_CORE, { carryOver: false })).toBe(before);
    const carried = innerNoteReflectionInstructions(CHARACTER_CORE, { carryOver: true });
    expect(carried).not.toBe(before);
    expect(carried).toContain('すねた態度や一日の気持ちは、次の日には持ち越されない');
    expect(carried).toContain('関係の帳簿（信頼・好意・尊敬・いらだち）は日をまたいで持ち越され');
  });

  it('recalls yesterday\'s incident with episode memory on, and forgets it with its source', async () => {
    const episodes = composed({ relationship: false, episodes: true, boundaries: false });
    badDay(episodes.port);
    episodes.clock.at = MORNING;
    const block = await morningBlock(episodes.port, clean());
    expect(block).toContain('[前の日の件]');
    expect(block).toContain('昨日の胸の件（ライ氏）');
    expect(block).not.toContain('[ライ氏との間]');
    expect(await morningBlock(episodes.port, forgetting([0, 1, 2, 3, 4, 5].map(minute => `experience:t${minute}`)))).not.toContain('[前の日の件]');
  });
});
