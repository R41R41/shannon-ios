import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installFullrunBodyAdapter } from '../scripts/minecraftFullrunBodyAdapter.js';
function fixture() {
    const bot: any = new EventEmitter();
    const protocol = new EventEmitter();
    const query = {
        skillName: 'get-state', interval: 1000, status: true
    };
    const swim = {
        skillName: 'auto-swim', interval: 100, status: true
    };
    bot.constantSkills = {
        skills: [
            query, swim, {
                skillName: 'auto-pick-up-item', interval: 1000
            }, {
                skillName: 'legacy-planner', interval: 100
            }
        ],
        getSkills() { return this.skills; }
    };
    bot.game = {
        dimension: 'overworld'
    };
    bot.floorReflexes = {
        alreadyInstalled: true
    };
    const ticks = new Map<number, () => void>();
    const handlers = new Map<string, () => void>();
    const runs: string[] = [];
    const ports = {
        floor: vi.fn((body: any) => { body.combatStats = () => ({}); body.shootsAtBody = () => true; body.hostileThreatRadius = () => 16; }),
        dimension: vi.fn((body: any) => { protocol.on('respawn', (packet: any) => { body.game.dimension = packet.worldState.name.replace('minecraft:', ''); }); }),
        category: (name: string) => name === 'get-state' ? 'query' : 'movement',
        register: vi.fn((body: any, skill: any) => {
            const event = `taskPer${skill.interval}ms`;
            const callback = () => { if (skill.status)
                runs.push(skill.skillName); };
            handlers.set(skill.skillName, callback);
            body.on(event, callback);
        }),
        detach: vi.fn((body: any, name: string) => {
            const skill = [
                query, swim
            ].find(s => s.skillName === name)!;
            body.removeListener(`taskPer${skill.interval}ms`, handlers.get(name)!);
        }),
        every: vi.fn((ms: number, tick: () => void) => { ticks.set(ms, tick); return () => { ticks.delete(ms); }; }),
        leaseHeld: () => true,
    };
    return {
        bot, protocol, ports, ticks, runs
    };
}
afterEach(() => { vi.unstubAllGlobals(); });
describe('fullrun-only production installer wiring', () => {
    it(("adds knowledge/dimension and schedules only the production query/auto-swim set, without a provi" + "der or pickup"), () => {
        vi.stubGlobal('fetch', vi.fn(() => { throw new Error('NO_PROVIDER'); }));
        const f = fixture();
        const existingFloor = f.bot.floorReflexes;
        installFullrunBodyAdapter(f.bot, f.ports);
        expect(f.bot.floorReflexes).toBe(existingFloor);
        expect(f.bot.combatStats).toBeTypeOf('function');
        expect(f.bot.shootsAtBody()).toBe(true);
        f.protocol.emit('respawn', {
            worldState: {
                name: 'minecraft:the_nether'
            }
        });
        expect(f.bot.game.dimension).toBe('the_nether');
        f.ticks.get(100)!();
        f.ticks.get(1000)!();
        f.ticks.get(5000)!();
        expect(f.runs).toEqual([
            'auto-swim', 'get-state'
        ]);
        expect(f.bot.constantSkills.getSkills().map((s: any) => s.skillName)).toEqual([
            'get-state', 'auto-swim'
        ]);
        expect(f.bot.fcaLeaseHeld()).toBe(true);
        expect(fetch).not.toHaveBeenCalled();
    });
    it('deduplicates installs, stops timers/registrations on end and never revives the closed bot', () => {
        const f = fixture();
        const stop = installFullrunBodyAdapter(f.bot, f.ports);
        expect(installFullrunBodyAdapter(f.bot, f.ports)).toBe(stop);
        expect(f.ports.floor).toHaveBeenCalledTimes(1);
        expect(f.ports.dimension).toHaveBeenCalledTimes(1);
        expect(f.ports.every).toHaveBeenCalledTimes(3);
        f.bot.emit('end');
        stop();
        expect(f.ticks.size).toBe(0);
        expect(f.bot.listenerCount('taskPer100ms')).toBe(0);
        expect(f.ports.detach).toHaveBeenCalledTimes(2);
        expect(installFullrunBodyAdapter(f.bot, f.ports)).toBe(stop);
        expect(f.ports.every).toHaveBeenCalledTimes(3);
        const next = fixture();
        installFullrunBodyAdapter(next.bot, next.ports);
        expect(next.ports.floor).toHaveBeenCalledTimes(1);
        expect(next.ticks.size).toBe(3);
    });
    it('fails before adding installers for a missing auto-swim cadence or existing constant scheduler', () => {
        const f = fixture();
        f.bot.on('taskPer100ms', () => { });
        expect(() => installFullrunBodyAdapter(f.bot, f.ports)).toThrow('ALREADY_SCHEDULED');
        expect(f.ports.floor).not.toHaveBeenCalled();
        const g = fixture();
        g.bot.constantSkills.skills[1].interval = 500;
        expect(() => installFullrunBodyAdapter(g.bot, g.ports)).toThrow('AUTO_SWIM_CADENCE');
    });
});
