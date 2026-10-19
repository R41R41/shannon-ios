import { describe, expect, it } from 'vitest';
import { WorkingEventLog } from '@shannon/mind';
import { createMinecraftWorkingArbiter, minecraftCalm, minecraftCommandId, minecraftNeedsLine, minecraftWaitingCall } from '../src/surfaces/minecraft/minecraftWorkingArbiter.js';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';

const AT = '2026-10-20T10:00:00.000Z';
const NOW = Date.parse(AT);
const frame = (world: Record<string, unknown>, facts: Record<string, boolean> = {}): BodyObservation => ({ schemaVersion: 1, bodyId: 'minecraft:world', sequence: 1,
  stateAt: AT, receivedAt: AT, connected: true, state: { world } as never, facts: { danger: false, ...facts } });
const day = frame({ margin: { darkInSeconds: 300 }, nearbyThreats: [] });

function fixture() {
  let clock = NOW;
  const log = new WorkingEventLog();
  const sent: Array<{ text: string; id: string }> = [], lines: string[] = [];
  const arbiter = createMinecraftWorkingArbiter({ log: () => log, now: () => clock, taskId: 'task', stepId: 'step',
    send: (text, id) => sent.push({ text, id }), line: text => lines.push(text) });
  let seq = 0;
  const tell = (kind: string, subject: string, data: Record<string, string | number | boolean>) => log.take('c1', [{ seq: ++seq, at: AT, kind, subject, data }]);
  return { log, arbiter, sent, lines, tell, advance: (ms: number) => { clock += ms; } };
}

describe('Minecraft working arbiter (mb-arch stage 1)', () => {
  it('follows the running command under the id the body knows it by, and cuts it when it got nowhere for 20 s', () => {
    const f = fixture();
    f.arbiter.begin({ name: 'mc.move-to', input: { x: 56, y: 58, z: -2 } }, 'step:operation:1');
    const subject = minecraftCommandId('step:operation:1');
    expect(subject).toMatch(/^skill:[0-9a-f]{64}$/u);
    f.tell('action.progress', subject, { skill: 'move-to', measure: 'target', elapsedMs: 18_000, sinceProgressMs: 18_000, distance: 20.5 });
    expect(f.arbiter.check(day)).toEqual({ act: 'none' });
    f.tell('action.stalled', subject, { skill: 'move-to', measure: 'target', elapsedMs: 21_000, sinceProgressMs: 21_000, distance: 20.5 });
    expect(f.arbiter.check(day)).toMatchObject({ act: 'cut', rule: 'stalled', tool: 'mc.move-to' });
    expect(JSON.parse(f.sent[0]!.text)).toEqual({ kind: 'body.working_cut', rule: 'stalled', tool: 'mc.move-to',
      note: 'mc.move-to を切った: 21秒進んでいない（残り21m）。同じ手をそのまま繰り返さず、道か目標を変える' });
    expect(f.lines[0]).toMatch(/^Shannon Minecraft working cut task=task rule=stalled tool=mc.move-to sinceProgressMs=21000 distance=20.5/u);
    expect(f.arbiter.check(day)).toEqual({ act: 'none' });
  });

  it('cuts a calm wait with time left when a need comes into reach, and not at night or with a threat near', () => {
    const f = fixture();
    f.tell('need.appeared', 'b:50,43,-1', { need: 'iron', name: 'iron_ore', distance: 16, canReach: true });
    f.arbiter.begin({ name: 'mc.wait-time', input: { milliseconds: 58_000 } }, 'op-wait');
    expect(f.arbiter.check(frame({ margin: { lightInSeconds: 400 }, nearbyThreats: [] }))).toEqual({ act: 'none' });
    expect(f.arbiter.check(frame({ margin: { darkInSeconds: 300 }, nearbyThreats: [{ distance: 9, canReachMe: true }] }))).toEqual({ act: 'none' });
    f.advance(50_000);
    expect(f.arbiter.check(day)).toEqual({ act: 'none' });
    const g = fixture();
    g.tell('need.appeared', 'b:50,43,-1', { need: 'iron', name: 'iron_ore', distance: 16, canReach: true });
    g.arbiter.begin({ name: 'mc.withdraw-from-furnace', input: { x: 1, y: 2, z: 3, waitForCompletion: true } }, 'op-withdraw');
    expect(g.arbiter.check(day)).toMatchObject({ act: 'cut', rule: 'need_during_wait', need: { name: 'iron_ore' } });
    expect(JSON.parse(g.sent[0]!.text).note).toBe('mc.withdraw-from-furnace の待ちを切った: iron_ore（iron）が16mにある。取ってから、待っていた作業に戻る');
  });

  it('tells each decision what happened since the last, what runs and the needs in reach, then only what is new', () => {
    const f = fixture();
    expect(f.arbiter.fields()).toEqual({});
    f.tell('need.appeared', 'e:7', { need: 'food', name: 'pig', distance: 9, canReach: true });
    f.tell('need.appeared', 'b:50,43,-1', { need: 'iron', name: 'iron_ore', distance: 16, canReach: true, exposed: false });
    expect(f.arbiter.fields()).toEqual({ working: {
      events: ['見えた: pig（food）9m', '見えた: iron_ore（iron）16m'],
      needs: '近くに要る物（届く）: 食べ物の動物9m・鉄鉱石16m（埋まっている）。今の作業の区切りで寄って取れる: mc.attack-continuously（entityName=pig、maxKills=2）、mc.mine-block（blockName=iron_ore、searchRadius=24）',
    } });
    expect(f.arbiter.fields().working?.events).toBeUndefined();
    f.arbiter.begin({ name: 'mc.mine-block', input: { blockName: 'iron_ore' } }, 'op');
    f.advance(30_000);
    expect(f.arbiter.fields().working?.running).toBe('今の道具: mc.mine-block・経過30秒');
  });

  it('knows a wait, calm and the needs line from the frame alone', () => {
    expect(minecraftWaitingCall('mc.wait-time', {})).toBe(true);
    expect(minecraftWaitingCall('mc.withdraw-from-furnace', { waitForCompletion: false })).toBe(false);
    expect(minecraftWaitingCall('mc.move-to', {})).toBe(false);
    expect(minecraftCalm(day)).toBe(true);
    expect(minecraftCalm(frame({ margin: { darkInSeconds: 300 } }, { danger: true }))).toBe(false);
    expect(minecraftCalm(frame({ margin: { darkInSeconds: 300 }, nearbyThreats: [{ distance: 9, canReachMe: false }] }))).toBe(true);
    expect(minecraftCalm(null)).toBe(false);
    expect(minecraftNeedsLine([{ id: 'x', need: 'iron', name: 'iron_ore', distance: 30, canReach: false, at: AT, data: {} }])).toBeNull();
  });
});
