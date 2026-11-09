import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installRigSpawnScan } from '../scripts/minecraftRigSpawnScan.js';

afterEach(() => vi.useRealTimers());
describe('the isolated rig starts the real scan listener after createProbeBot has spawned', () => {
  it('starts only the scan, once, keeps the actual actor as state owner and reuses the existing installer on repeated attachment', () => {
    const actor = Object.assign(new EventEmitter(), { worldScan: null as unknown, game: { dimension: 'overworld' } });
    const otherPlugin = vi.fn(); actor.on('spawn', otherPlugin);
    const scan = vi.fn((body: typeof actor) => { body.worldScan = body.game.dimension; });
    const cleanup = vi.fn();
    const installer = vi.fn((body: typeof actor) => {
      const spawn = () => scan(body); body.on('spawn', spawn);
      return () => { body.removeListener('spawn', spawn); cleanup(); };
    });
    const stop = installRigSpawnScan(actor, installer, vi.fn());
    expect(otherPlugin).not.toHaveBeenCalled(); expect(scan).toHaveBeenCalledOnce(); expect(actor.worldScan).toBe('overworld');
    expect(installRigSpawnScan(actor, installer, vi.fn())).toBe(stop); expect(installer).toHaveBeenCalledOnce();
    actor.game = { dimension: 'the_nether' }; actor.emit('spawn');
    expect(scan).toHaveBeenCalledTimes(2); expect(actor.worldScan).toBe('the_nether'); expect(otherPlugin).toHaveBeenCalledOnce();
    stop(); stop(); actor.emit('spawn');
    expect(cleanup).toHaveBeenCalledOnce(); expect(scan).toHaveBeenCalledTimes(2); expect(actor.listenerCount('spawn')).toBe(1);
  });
  it('requires the real installer to register its spawn listener', () => {
    const cleanup = vi.fn();
    expect(() => installRigSpawnScan(new EventEmitter(), () => cleanup, vi.fn())).toThrow('RIG_SCAN_NO_SPAWN_LISTENER');
    expect(cleanup).toHaveBeenCalledOnce();
  });
  it('disposes a failed initial start and permits a later explicit attachment', () => {
    const actor = new EventEmitter(), cleanup = vi.fn();
    const installer = (body: EventEmitter) => {
      const listener = () => { throw new Error('read failed'); }; body.on('spawn', listener);
      return () => { body.removeListener('spawn', listener); cleanup(); };
    };
    expect(() => installRigSpawnScan(actor, installer, vi.fn())).toThrow('read failed');
    expect(cleanup).toHaveBeenCalledOnce(); expect(actor.listenerCount('spawn')).toBe(0);
    const started = vi.fn();
    const stop = installRigSpawnScan(actor, body => { body.on('spawn', started); return () => body.removeListener('spawn', started); }, vi.fn());
    expect(started).toHaveBeenCalledOnce(); stop();
  });
});

// Optional lab integration: evaluate the existing installSpawnScan function from the explicitly pinned body source, not a copy of its algorithm.
// Only its chunk readers/scan result are doubles; its wait, generation, end and disposal logic are the actual body implementation.
const nativeSource = process.env.RIG_SCAN_BODY_SOURCE;
describe.skipIf(!nativeSource)('actual pinned body installSpawnScan through the rig adapter (API/MC off)', () => {
  function setup() {
    vi.useFakeTimers();
    const file = ts.createSourceFile('worldScan.ts', fs.readFileSync(nativeSource!, 'utf8'), ts.ScriptTarget.Latest, true);
    const declaration = file.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'installSpawnScan');
    if (!declaration) throw new Error('PINNED_INSTALL_SPAWN_SCAN_MISSING');
    const code = ts.transpileModule(declaration.getText(file).replace(/^export\s+/u, ''), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText;
    const pending: Array<(value: unknown) => void> = [];
    const scan = vi.fn(() => new Promise(resolve => pending.push(resolve)));
    const nativeInstall = new Function('loadedRing', 'viewDistanceOf', 'scanWorld', 'SPAWN_SCAN_SHARE', 'MAX_ROWS', `${code}; return installSpawnScan;`)(
      () => ({ count: 441, radius: 10 }), () => 10, scan, .8, 20);
    const actor: any = Object.assign(new EventEmitter(), { entity: { position: { x: 8.5, y: 64, z: 8.5 } },
      game: { dimension: 'overworld' }, arrival: { kind: 'login', at: Date.now() } });
    const log = vi.fn(), stop = installRigSpawnScan(actor, nativeInstall, log);
    const summary = { text: 'actual scan receipt fixture', rows: ['observed row'], chunks: 441, reach: 167, ms: 5, longestSliceMs: 1 };
    return { actor, pending, scan, stop, summary, log };
  }
  it('keeps the native two-second minimum and native world.scan schema, then starts each later spawn only once', async () => {
    const { actor, pending, scan, stop, summary } = setup();
    await vi.advanceTimersByTimeAsync(1999); expect(scan).not.toHaveBeenCalled(); expect(actor.worldScan).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1001); expect(scan).toHaveBeenCalledOnce(); pending[0](summary); await Promise.resolve();
    expect(actor.worldScan).toMatchObject({ trigger: 'login', dimension: 'overworld', center: { x: 8, y: 64, z: 8 }, chunks: 441, viewDistance: 10 });
    expect(actor.worldScan.rows).toEqual([expect.stringMatching(/^範囲 読み込み /u), 'observed row']);
    expect(actor.worldScanCost).toEqual({ ms: 5, longestSliceMs: 1 });
    actor.arrival = { kind: 'respawn', at: Date.now() }; actor.emit('spawn');
    await vi.advanceTimersByTimeAsync(3000); expect(scan).toHaveBeenCalledTimes(2); pending[1](summary); await Promise.resolve();
    expect(actor.worldScan.trigger).toBe('respawn'); stop();
    expect(actor.listenerCount('spawn')).toBe(0); expect(actor.listenerCount('end')).toBe(0);
  });
  it('does not publish an old pending scan after a newer real spawn changes the life/dimension', async () => {
    const { actor, pending, scan, stop, summary } = setup();
    await vi.advanceTimersByTimeAsync(3000); expect(scan).toHaveBeenCalledOnce();
    actor.game.dimension = 'the_nether'; actor.arrival = { kind: 'portal', at: Date.now() }; actor.emit('spawn');
    pending[0](summary); await Promise.resolve(); expect(actor.worldScan).toBeUndefined();
    await vi.advanceTimersByTimeAsync(3000); expect(scan).toHaveBeenCalledTimes(2); pending[1](summary); await Promise.resolve();
    expect(actor.worldScan).toMatchObject({ trigger: 'portal', dimension: 'the_nether' }); stop();
  });
  it.each(['end', 'dispose'])('cannot write a late native scan after %s', async boundary => {
    const { actor, pending, scan, stop, summary } = setup();
    await vi.advanceTimersByTimeAsync(3000); expect(scan).toHaveBeenCalledOnce();
    if (boundary === 'end') actor.emit('end'); else stop();
    pending[0](summary); await Promise.resolve(); expect(actor.worldScan).toBeUndefined();
    stop(); await vi.advanceTimersByTimeAsync(30_000); expect(scan).toHaveBeenCalledOnce();
  });
});
