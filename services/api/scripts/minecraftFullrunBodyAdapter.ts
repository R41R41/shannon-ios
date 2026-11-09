/** Fullrun-only wiring of existing production installers. No game plan, provider, packet or standalone skill executor. */
interface Skill {
    skillName: string;
    interval?: number | null;
}
interface Body {
    constantSkills: {
        skills: Skill[];
        getSkills(): Skill[];
    };
    once(event: string, listener: () => void): unknown;
    removeListener(event: string, listener: () => void): unknown;
    emit(event: string): unknown;
    listenerCount(event: string): number;
    fcaLeaseHeld?: () => boolean;
}
interface Ports {
    floor(bot: Body): unknown;
    dimension(bot: Body): void;
    category(name: string): string;
    register(bot: Body, skill: Skill): void;
    detach(bot: Body, name: string): void;
    every(milliseconds: number, tick: () => void): () => void;
    leaseHeld(): boolean;
}
const installed = new WeakMap<object, () => void>();
const CADENCES = [
    100, 1000, 5000
] as const;
export function installFullrunBodyAdapter(bot: Body, ports: Ports): () => void {
    const previous = installed.get(bot);
    if (previous)
        return previous; // A stopped connection is never revived. A reconnect is a new bot.
    const selected = bot.constantSkills.getSkills().filter(skill => ports.category(skill.skillName) === 'query' || skill.skillName === 'auto-swim');
    const swim = selected.find(skill => skill.skillName === 'auto-swim');
    if (CADENCES.some(ms => bot.listenerCount(`taskPer${ms}ms`) > 0))
        throw new Error('FULLRUN_CONSTANTS_ALREADY_SCHEDULED');
    if (!swim || swim.interval !== 100)
        throw new Error('FULLRUN_AUTO_SWIM_CADENCE_MISSING');
    if (selected.some(skill => skill.interval && !CADENCES.includes(skill.interval as 100 | 1000 | 5000)))
        throw new Error('FULLRUN_UNEXPECTED_CONSTANT_CADENCE');
    // floor's production installer is idempotent. The probe's existing floor is not duplicated, while knowledge is added.
    ports.floor(bot);
    ports.dimension(bot);
    bot.constantSkills.skills = selected;
    bot.fcaLeaseHeld = () => ports.leaseHeld();
    const registered: string[] = [];
    const timers: Array<() => void> = [];
    let stopped = false;
    const stop = () => {
        if (stopped)
            return;
        stopped = true;
        for (const cancel of timers)
            cancel();
        for (const name of registered)
            ports.detach(bot, name);
        bot.removeListener('end', stop);
    };
    installed.set(bot, stop);
    try {
        for (const skill of selected) {
            ports.register(bot, skill);
            registered.push(skill.skillName);
        }
        for (const ms of CADENCES)
            timers.push(ports.every(ms, () => { if (!stopped)
                bot.emit(`taskPer${ms}ms`); }));
        bot.once('end', stop);
    }
    catch (error) {
        stop();
        throw error;
    }
    return stop;
}
