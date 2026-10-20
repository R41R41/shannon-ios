import { describe, expect, it } from 'vitest';
import { WorkingEventLog } from '@shannon/mind';
import { createMinecraftWorkingArbiter, minecraftCalm, minecraftCommandId, minecraftFrameNeeds, minecraftFurnaceRemaining, minecraftNeedsLine,
  minecraftWaitingCall, minecraftWorkTopic } from '../src/surfaces/minecraft/minecraftWorkingArbiter.js';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';

const AT = '2026-10-20T10:00:00.000Z';
const NOW = Date.parse(AT);
const frame = (world: Record<string, unknown>, facts: Record<string, boolean> = {}): BodyObservation => ({ schemaVersion: 1, bodyId: 'minecraft:world', sequence: 1,
  stateAt: AT, receivedAt: AT, connected: true, state: { world } as never, facts: { danger: false, ...facts } });
const day = frame({ margin: { darkInSeconds: 300 }, nearbyThreats: [] });
const ironNeed = { id: 'iron:b:50,43,-1', need: 'iron', name: 'iron_ore', position: { x: 50, y: 43, z: -1 }, distance: 16, canReach: true };
const withNeeds = (needs: unknown[], margin: Record<string, number> = { darkInSeconds: 300 }, threats: unknown[] = []) => frame({ margin, nearbyThreats: threats, nearbyNeeds: needs });
let tasks = 0;

function fixture() {
  let clock = NOW;
  const log = new WorkingEventLog();
  const sent: Array<{ text: string; id: string }> = [], lines: string[] = [];
  const arbiter = createMinecraftWorkingArbiter({ log: () => log, now: () => clock, taskId: `task-${++tasks}`, stepId: 'step',
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
    expect(f.lines[0]).toMatch(/^Shannon Minecraft working cut task=task-\d+ rule=stalled tool=mc.move-to sinceProgressMs=21000 distance=20.5/u);
    expect(f.arbiter.check(day)).toEqual({ act: 'none' });
  });

  it('cuts a calm wait with time left when a need comes into reach after it began, and not at night or with a threat near', () => {
    const f = fixture();
    f.arbiter.begin({ name: 'mc.wait-time', input: { milliseconds: 58_000 } }, 'op-wait');
    f.tell('need.appeared', ironNeed.id, { need: 'iron', name: 'iron_ore', distance: 16, canReach: true });
    expect(f.arbiter.check(withNeeds([ironNeed], { lightInSeconds: 400 }))).toEqual({ act: 'none' });
    expect(f.arbiter.check(withNeeds([ironNeed], undefined, [{ distance: 9, canReachMe: true }]))).toEqual({ act: 'none' });
    expect(f.arbiter.check(withNeeds([{ ...ironNeed, canReach: false }]))).toEqual({ act: 'none' });
    expect(f.arbiter.check(withNeeds([{ ...ironNeed, need: 'wood', name: 'oak_log' }]))).toEqual({ act: 'none' });
    f.advance(50_000);
    expect(f.arbiter.check(withNeeds([ironNeed]))).toEqual({ act: 'none' });
    const g = fixture();
    g.arbiter.begin({ name: 'mc.withdraw-from-furnace', input: { x: 1, y: 2, z: 3, waitForCompletion: true } }, 'op-withdraw');
    g.tell('need.appeared', ironNeed.id, { need: 'iron', name: 'iron_ore', distance: 16, canReach: true });
    const furnace = (remainingEstimateMs: number) => frame({ margin: { darkInSeconds: 300 }, nearbyThreats: [], nearbyNeeds: [ironNeed],
      jobs: [{ position: { x: 1, y: 2, z: 3 }, remainingEstimateMs }] });
    expect(g.arbiter.check(furnace(40_000))).toMatchObject({ act: 'cut', rule: 'need_during_wait', need: { name: 'iron_ore' } });
    expect(JSON.parse(g.sent[0]!.text).note).toBe('mc.withdraw-from-furnace の待ちを切った: iron_ore（iron）が16mにある。取ってから、待っていた作業に戻る');
  });

  it('run 19: never cuts a furnace wait with about 3 s left, nor one whose furnace it does not know, nor the same furnace asked again', () => {
    const f = fixture();
    const withdraw = { name: 'mc.withdraw-from-furnace', input: { x: 74, y: 29, z: -14, waitForCompletion: true } };
    const furnace = (remainingEstimateMs: number | null) => frame({ margin: { darkInSeconds: 300 }, nearbyThreats: [],
      nearbyNeeds: [{ ...ironNeed, distance: 15.7 }], ...(remainingEstimateMs === null ? {} : { jobs: [{ position: { x: 74, y: 29, z: -14 }, remainingEstimateMs }] }) });
    f.arbiter.begin(withdraw, 'op-1');
    f.tell('need.appeared', ironNeed.id, { need: 'iron', name: 'iron_ore', distance: 15.7, canReach: true });
    expect(f.arbiter.check(furnace(3_000))).toEqual({ act: 'none' });
    expect(f.arbiter.check(furnace(null))).toEqual({ act: 'none' });
    expect(f.arbiter.check(furnace(40_000)).act).toBe('cut');
    // The same furnace asked again, under a new id: the same work, not cut twice.
    f.arbiter.end(withdraw.name);
    f.arbiter.begin(withdraw, 'op-2');
    f.tell('need.appeared', 'iron:b:60,40,0', { need: 'iron', name: 'iron_ore', distance: 12, canReach: true });
    expect(f.arbiter.check(frame({ margin: { darkInSeconds: 300 }, nearbyThreats: [],
      nearbyNeeds: [{ ...ironNeed, id: 'iron:b:60,40,0', distance: 12 }], jobs: [{ position: { x: 74, y: 29, z: -14 }, remainingEstimateMs: 30_000 }] }))).toEqual({ act: 'none' });
    expect(minecraftWorkTopic(withdraw)).toBe('mc.withdraw-from-furnace@74,29,-14');
  });

  it('knows a furnace only by its own job: another furnace\'s time is not taken for it', () => {
    const jobs = (position: { x: number; y: number; z: number }) => frame({ jobs: [{ position, remainingEstimateMs: 40_000 }] });
    expect(minecraftFurnaceRemaining(jobs({ x: 74, y: 29, z: -14 }), { x: 74, y: 29, z: -14 })).toBe(40_000);
    expect(minecraftFurnaceRemaining(jobs({ x: 1, y: 2, z: 3 }), { x: 74, y: 29, z: -14 })).toBeNull();
    expect(minecraftFurnaceRemaining(jobs({ x: 1, y: 2, z: 3 }), {})).toBe(40_000);
    expect(minecraftFurnaceRemaining(frame({}), { x: 74, y: 29, z: -14 })).toBeNull();
  });

  it('holds a topic for five minutes: the same dig may be cut again after that', () => {
    const f = fixture();
    const dig = { name: 'mc.mine-block', input: { blockName: 'iron_ore' } };
    f.arbiter.begin(dig, 'op-1');
    f.tell('action.stalled', minecraftCommandId('op-1'), { skill: 'mine-block', measure: 'travel', sinceProgressMs: 21_000 });
    expect(f.arbiter.check(day).act).toBe('cut');
    f.arbiter.end(dig.name);
    f.advance(60_000);
    f.arbiter.begin(dig, 'op-2');
    f.tell('action.stalled', minecraftCommandId('op-2'), { skill: 'mine-block', measure: 'travel', sinceProgressMs: 21_000 });
    expect(f.arbiter.check(day).act).toBe('none');
    f.arbiter.end(dig.name);
    f.advance(300_000);
    f.arbiter.begin(dig, 'op-3');
    f.tell('action.stalled', minecraftCommandId('op-3'), { skill: 'mine-block', measure: 'travel', sinceProgressMs: 21_000 });
    expect(f.arbiter.check(day).act).toBe('cut');
  });

  it('leaves a wait alone for a need that was already there when it began: the body judged that wait (wait_refused)', () => {
    const f = fixture();
    f.tell('need.appeared', ironNeed.id, { need: 'iron', name: 'iron_ore', distance: 16, canReach: true });
    f.arbiter.begin({ name: 'mc.wait-time', input: { milliseconds: 58_000 } }, 'op-wait');
    expect(f.arbiter.check(withNeeds([ironNeed]))).toEqual({ act: 'none' });
  });

  it('cuts a chase in water after 10 s without progress, on land only after 20 s', () => {
    const water = fixture();
    water.arbiter.begin({ name: 'mc.attack-continuously', input: { entityName: 'salmon' } }, 'op-chase');
    const subject = minecraftCommandId('op-chase');
    water.tell('action.stalled', subject, { skill: 'attack-continuously', measure: 'chase', sinceProgressMs: 10_000, hazard: 'water' });
    expect(water.arbiter.check(day)).toMatchObject({ act: 'cut', rule: 'stalled', tool: 'mc.attack-continuously' });
    const land = fixture();
    land.arbiter.begin({ name: 'mc.attack-continuously', input: { entityName: 'sheep' } }, 'op-chase');
    land.tell('action.stalled', subject, { skill: 'attack-continuously', measure: 'chase', sinceProgressMs: 15_000 });
    expect(land.arbiter.check(day)).toEqual({ act: 'none' });
  });

  it('says a standing bed with the cell to dig, and coal as fuel', () => {
    const bed = { id: 'bed:b:69,66,4', need: 'bed', name: 'red_bed', position: { x: 69, y: 66, z: 4 }, distance: 13, canReach: true };
    const coal = { id: 'fuel:b:70,66,20', need: 'fuel', name: 'coal_ore', position: { x: 70, y: 66, z: 20 }, distance: 12, canReach: true };
    expect(minecraftNeedsLine(minecraftFrameNeeds(withNeeds([bed, coal])))).toBe('近くに要る物（届く）: 置かれたベッド13m・石炭12m。今の作業の区切りで寄って取れる: '
      + 'mc.move-to（x=69、y=66、z=4、goalType=block）→ mc.dig-block-at（x=69、y=66、z=4、takeEquipment=true。掘れば持てる）、'
      + 'mc.mine-block（blockName=coal_ore、count=4）');
    // Four nearer needs never push a standing bed out of the line.
    const logs = [1, 2, 3, 4].map(i => ({ id: `wood:b:${i},64,0`, need: 'wood', name: 'oak_log', position: { x: i, y: 64, z: 0 }, distance: i, canReach: true }));
    expect(minecraftNeedsLine(minecraftFrameNeeds(withNeeds([...logs, { ...bed, distance: 72 }])))).toMatch(/^近くに要る物（届く）: 置かれたベッド72m・/u);
    expect(minecraftFrameNeeds(withNeeds([{ ...bed, position: undefined }]))).toEqual([]);
  });

  it('keeps the cuts of a task across its steps: a new step never cuts the same command again', () => {
    const log = new WorkingEventLog();
    const make = () => createMinecraftWorkingArbiter({ log: () => log, now: () => NOW, taskId: 'shared-task', stepId: 'step', send: () => {}, line: () => {} });
    const subject = minecraftCommandId('op');
    log.take('c1', [{ seq: 1, at: AT, kind: 'action.stalled', subject, data: { skill: 'move-to', measure: 'target', sinceProgressMs: 25_000 } }]);
    const first = make(); first.begin({ name: 'mc.move-to', input: {} }, 'op');
    expect(first.check(day).act).toBe('cut');
    const second = make(); second.begin({ name: 'mc.move-to', input: {} }, 'op');
    expect(second.check(day).act).toBe('none');
  });

  it('tells each decision what happened since the last, what runs and the needs in reach, then only what is new', () => {
    const f = fixture();
    expect(f.arbiter.fields(day)).toEqual({});
    f.tell('need.appeared', 'food:e:7', { need: 'food', name: 'pig', distance: 9, canReach: true });
    f.tell('need.appeared', 'iron:b:50,43,-1', { need: 'iron', name: 'iron_ore', distance: 16, canReach: true, exposed: false });
    const seen = withNeeds([{ ...ironNeed, exposed: false }, { id: 'food:e:7', need: 'food', name: 'pig', position: { x: 9, y: 64, z: 0 }, distance: 9, canReach: true }]);
    expect(f.arbiter.fields(seen)).toEqual({ working: {
      events: ['見えた: pig（food）9m', '見えた: iron_ore（iron）16m'],
      needs: '近くに要る物（届く）: 食べ物の動物9m・鉄鉱石16m（埋まっている）。今の作業の区切りで寄って取れる: mc.attack-continuously（entityName=pig、maxKills=2）、mc.mine-block（blockName=iron_ore、searchRadius=24）',
    } });
    expect(f.arbiter.fields(seen).working?.events).toBeUndefined();
    f.arbiter.begin({ name: 'mc.mine-block', input: { blockName: 'iron_ore' } }, 'op');
    f.advance(30_000);
    expect(f.arbiter.fields(day).working?.running).toBe('今の道具: mc.mine-block・経過30秒');
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
    expect(minecraftFrameNeeds(withNeeds([ironNeed, { need: 'gold', name: 'gold_ore', distance: 3 }, { need: 'iron', name: 'Bad Name', distance: 3 }])).map(need => need.id)).toEqual(['iron:b:50,43,-1']);
    expect(minecraftFrameNeeds(null)).toEqual([]);
  });
});
