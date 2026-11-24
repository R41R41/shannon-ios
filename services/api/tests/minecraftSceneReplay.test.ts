import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiveMoment } from '@shannon/mind';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { LiveCommentary, type LiveWriteRequest } from '../src/surfaces/minecraft/minecraftLiveCommentary.js';
import { LiveSpeechOutbox } from '../src/surfaces/minecraft/minecraftLiveSpeech.js';
import { createMomentDetector } from '../src/surfaces/minecraft/minecraftMoments.js';

/**
 * A recorded fight, replayed through the detector, the commentary and the outbox (the writer is a fake: a line of a fixed length per kind; the
 * body is a fake that says a line at the pace of a voice and answers with a receipt). It shows what is said, how soon after what happened, and
 * that a minute of it stays within what the mouth takes. Times are seconds from the start of the replay.
 */
interface Beat { at: number; health: number; threats?: Array<{ distance: number; id?: number }>; alive?: boolean; creeper?: { distance: number; lit: boolean } }

const zombies = (...distances: number[]) => distances.map((distance, index) => ({ distance, id: index + 1 }));
// Health and who stands at her, as a fight of a few minutes went (a creeper first, then three zombies, a death, a return, a second death).
const BEATS: Beat[] = [
  { at: 0, health: 20 }, { at: 2, health: 20, creeper: { distance: 3, lit: true } }, { at: 8, health: 20 },
  { at: 32, health: 20, threats: zombies(5, 5, 5.5) },
  { at: 33.6, health: 17.5, threats: zombies(1.5, 3, 4) }, { at: 34.4, health: 15, threats: zombies(1.5, 3, 4) }, { at: 36.4, health: 12.5, threats: zombies(1.5, 2, 3) },
  { at: 37.3, health: 10, threats: zombies(1.5, 2, 3) }, { at: 38.8, health: 7.5, threats: zombies(1.5, 2, 3) }, { at: 39.6, health: 5, threats: zombies(1.5, 2, 3) },
  { at: 52.8, health: 4.7, threats: zombies(2, 3, 4) }, { at: 53.6, health: 2.2, threats: zombies(2, 3, 4) }, { at: 57, health: 0.2, threats: zombies(2, 3, 4) },
  { at: 59, health: 1.2, threats: zombies(3, 4, 5) }, { at: 65, health: 2.2, threats: zombies(3, 4, 5) }, { at: 70, health: 2.9, threats: zombies(3, 4, 5) },
  { at: 73.1, health: 3.9, threats: zombies(2, 4, 5) }, { at: 73.6, health: 1.4, threats: zombies(1.5, 4, 5) },
  { at: 74.8, health: 0, alive: false },
  { at: 75.7, health: 20, threats: zombies(8) }, { at: 78, health: 20, threats: zombies(4) }, { at: 81.9, health: 18, threats: zombies(1.5, 3) },
  { at: 86.9, health: 6.8, threats: zombies(1.5, 3) }, { at: 96.6, health: 5.8, threats: zombies(1.5, 3) },
  { at: 105.5, health: 0, alive: false }, { at: 106.8, health: 20 }, { at: 140, health: 20 },
];

let sequence = 0;
const frameAt = (beat: Beat, baseMs: number): BodyObservation => ({
  schemaVersion: 1, bodyId: 'minecraft:world', sequence: sequence++, stateAt: new Date(baseMs).toISOString(), receivedAt: new Date(baseMs).toISOString(), connected: true,
  state: { world: { dimension: 'overworld', health: beat.health, food: 12, time: '14000', inventory: [],
    nearbyThreats: [...(beat.threats ?? []).map(threat => ({ name: 'zombie', kind: 'hostile', distance: threat.distance, canReachMe: true, id: threat.id })),
      ...(beat.creeper ? [{ name: 'creeper', kind: 'hostile', distance: beat.creeper.distance, canReachMe: true, ignited: beat.creeper.lit }] : [])] } as never },
  facts: { alive: beat.alive !== false, dimension: 'overworld' },
});
/** The beat in force at a time: health holds between beats. */
const beatAt = (seconds: number): Beat => [...BEATS].reverse().find(beat => beat.at <= seconds) ?? BEATS[0]!;

describe('a recorded fight, replayed', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(Date.parse('2026-01-15T10:00:00.000Z')); });
  afterEach(() => { vi.useRealTimers(); });

  it('says a cry for the first hit within a few seconds, for each fall and for the near death, and keeps within what the mouth takes in a minute', async () => {
    const base = Date.now();
    const clock = () => Date.now();
    const outbox = new LiveSpeechOutbox(clock);
    const listeners: Array<(moment: LiveMoment) => void> = [];
    const written: Array<{ kind: string; at: number }> = [];
    const said: Array<{ kind: string; queuedAt: number; startedAt: number; endedAt: number }> = [];
    const engine = new LiveCommentary({
      live: { onMoment: listener => { listeners.push(listener); return () => undefined; }, inDanger: () => false, conversation: () => ({ replying: false, sinceHumanMilliseconds: null }) },
      outbox, now: clock,
      write: async (request: LiveWriteRequest) => { written.push({ kind: request.main.kind, at: (clock() - base) / 1000 }); return `${'あいうえおかきくけこ'.slice(written.length % 5, written.length % 5 + 4)}、${request.main.kind}だよお${written.length}！`; },
    });
    engine.start();
    const detector = createMomentDetector();
    const moments: Array<{ kind: string; at: number }> = [];
    // The fake body: says one line at a time, at the pace of a voice (about 0.17 s a character and a second to start), and answers with a receipt.
    let speaking: { id: string; kind: string; until: number; startedAt: number; queuedAt: number } | null = null;
    for (let tick = 0; tick <= 1450; tick += 1) {
      const seconds = tick / 10, beat = beatAt(seconds);
      if (tick % 4 === 0) {
        for (const moment of detector.observe(frameAt(beat, clock()), clock())) {
          moments.push({ kind: moment.kind, at: seconds });
          listeners.forEach(listener => listener(moment));
        }
      }
      await vi.advanceTimersByTimeAsync(100);
      const receipts: Array<{ id: string; outcome: 'spoken' }> = [];
      if (speaking && (clock() - base) / 1000 >= speaking.until) {
        said.push({ kind: speaking.kind, queuedAt: speaking.queuedAt, startedAt: speaking.startedAt, endedAt: speaking.until });
        receipts.push({ id: speaking.id, outcome: 'spoken' });
        speaking = null;
      }
      outbox.receive(receipts, { voice: true, humanSpeaking: false, sinceHumanMs: null, speechMode: 'chatty', speechRate: 'normal' });
      if (!speaking) {
        const [line] = outbox.take();
        if (line) {
          const startedAt = seconds + 1.0, queued = seconds;
          speaking = { id: line.id, kind: line.kind, until: startedAt + Array.from(line.text).length * 0.17, startedAt, queuedAt: queued };
        }
      }
    }
    const first = (kind: string) => moments.find(moment => moment.kind === kind)?.at ?? -1;
    const spoken = (kind: string) => said.filter(item => item.kind === kind);
    // What the detector saw.
    expect(moments.map(moment => moment.kind)).toEqual(expect.arrayContaining(['scared', 'attacked', 'near_death', 'died', 'respawned']));
    expect(moments.filter(moment => moment.kind === 'died')).toHaveLength(2);
    expect(first('attacked')).toBeLessThanOrEqual(33.6 + 0.6);
    // What was said: a cry for the first hit (it came before the old near-death line could have), both falls, and the near deaths.
    expect(spoken('attacked')).toHaveLength(1);
    expect(spoken('died')).toHaveLength(2);
    expect(spoken('near_death').length).toBeGreaterThanOrEqual(1);
    // Soon: from the event to the end of the voice is a few seconds, not a dozen.
    const attacked = spoken('attacked')[0]!;
    expect(attacked.endedAt - first('attacked')).toBeLessThan(6);
    for (const death of spoken('died')) expect(death.endedAt - (death === spoken('died')[0] ? 74.8 : 105.5)).toBeLessThan(9);
    // Not too much: at most the mouth's six in any minute, and none of it said over another.
    for (const start of said.map(item => item.startedAt)) expect(said.filter(item => item.startedAt >= start && item.startedAt < start + 60).length).toBeLessThanOrEqual(6);
    for (let index = 1; index < said.length; index += 1) expect(said[index]!.startedAt).toBeGreaterThanOrEqual(said[index - 1]!.endedAt);
    engine.stop();
  });
});
