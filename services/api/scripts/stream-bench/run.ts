import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BenchMouth, ScaledClock } from './benchParts.js';
import { ExternalEar, InlineEar, type Ear } from './ears.js';
import { FakeYoutube } from './fakeYoutube.js';
import { BENCH_TOKEN, startBenchHead } from './head.js';
import type { RecordedComment } from './makeChat.js';
import { buildReport, markdown, type BenchReport } from './report.js';

/**
 * The stream bench (plan item 15, `docs/stream-contract.md` §7): a recorded ten-minute chat is replayed through a fake YouTube API into the
 * ear, the head's stream place (its real HTTP routes) and a mouth that speaks each line for its length and sends the receipt. It reports how
 * long a comment takes to become a line and a sound, how many were answered, whether the API's comments all reached the head (lost must be
 * 0), whether anything of the owner's private matters showed in a prompt or a line (leaks must be 0), and what the models cost.
 *
 *   npx tsx scripts/stream-bench/run.ts --models=fake --ear=inline --speed=60
 *   npx tsx scripts/stream-bench/run.ts --models=fake --ear=external --ear-cmd="npx tsx src/services/youtube/ear/cli.ts" --ear-cwd=C:/Shannon/Shannon-vtuber/backend
 *   npx tsx scripts/stream-bench/run.ts --models=fake --ear=external --ear-cmd="…" --no-stream-list      (the fake has no streamList: the ear must poll)
 *   SHANNON_ANTHROPIC_API_KEY=… TYPESAFE_API_KEY=… npx tsx scripts/stream-bench/run.ts --models=real --speed=10 --max-calls=60
 *
 * The keys are read from the environment and never printed or written.
 */
export interface BenchOptions {
  models: 'fake' | 'real';
  ear: 'inline' | 'external';
  earCommand?: string;
  earCwd?: string;
  /** Virtual seconds per real second. */
  speed: number;
  /** Virtual milliseconds a fake model thinks. */
  fakeLatencyMilliseconds: number;
  maxModelCalls?: number;
  minecraft: boolean;
  chatWrites: boolean;
  /** false: the fake YouTube has no liveChatMessages.streamList (404), so an ear has to poll. Default true. */
  streamList?: boolean;
  outDir?: string;
  log?: (line: string) => void;
}

const here = dirname(fileURLToPath(import.meta.url));

export function loadChat(): RecordedComment[] {
  return (JSON.parse(readFileSync(join(here, 'recorded-chat.json'), 'utf8')) as { comments: RecordedComment[] }).comments;
}

async function until(done: () => boolean | Promise<boolean>, milliseconds: number, what: string): Promise<void> {
  const stopAt = Date.now() + milliseconds;
  while (!(await done())) {
    if (Date.now() > stopAt) throw new Error(`the bench waited too long for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

/** Moments of her Minecraft body for a stream that is one, every 45 s of the stream's time. */
function fakeMinecraftLive(clock: ScaledClock) {
  const listeners = new Set<(moment: unknown) => void>();
  const kinds = [['diamond_found', { carried: true, count: 1 }], ['night_fell', {}], ['tool_made', { item: 'iron_pickaxe' }], ['near_death', { health: 3, from: 'ゾンビ' }]] as const;
  let serial = 0;
  const timer = setInterval(() => {
    const [kind, facts] = kinds[serial % kinds.length]!;
    serial += 1;
    for (const listener of listeners) listener({ kind, key: `bench-moment-${serial}`, at: clock.now(), facts });
  }, clock.real(45_000));
  timer.unref?.();
  return {
    live: { onMoment: (listener: (moment: unknown) => void) => { listeners.add(listener); return () => listeners.delete(listener); }, inDanger: () => false,
      block: () => '[マイクラの体の今] いま洞窟で鉄を掘っている' },
    stop: () => clearInterval(timer),
  };
}

export async function runBench(options: BenchOptions): Promise<BenchReport> {
  const chat = loadChat();
  const epochMs = Date.parse('2026-10-29T20:00:00.000Z');
  const clock = new ScaledClock(epochMs, options.speed, options.models === 'real');
  const wallStart = Date.now();
  const game = options.minecraft ? fakeMinecraftLive(clock) : null;
  const head = await startBenchHead({ clock, models: options.models, fakeLatencyMilliseconds: options.fakeLatencyMilliseconds,
    ...(options.maxModelCalls ? { maxModelCalls: options.maxModelCalls } : {}), ...(options.log ? { log: options.log } : {}),
    ...(game ? { live: () => game.live as never } : {}) });
  const youtube = new FakeYoutube({ chat, speed: options.speed, now: () => clock.now(), epochMs, ...(options.streamList === false ? { streamList: false } : {}) });
  const youtubeBase = await youtube.start();
  const mouth = new BenchMouth({ base: head.url, clock });
  const ear: Ear = options.ear === 'external' && options.earCommand
    ? new ExternalEar({ command: options.earCommand, youtube: youtubeBase, head: head.url, token: BENCH_TOKEN, clock, ...(options.earCwd ? { cwd: options.earCwd } : {}) })
    : new InlineEar({ youtube: youtubeBase, head: head.url, token: BENCH_TOKEN, clock });
  let finalSummary: Record<string, unknown> | null = null;
  try {
    mouth.start();
    const started = await fetch(`${head.url}/v1/stream/start`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: '雑談とマイクラ（台）', minecraft: options.minecraft, chatWrites: options.chatWrites }) });
    const streamId = ((await started.json()) as { stream: { streamId: string } }).stream.streamId;
    await ear.start();
    const budget = ((chat.at(-1)?.at ?? 600) + 60) / options.speed * 1000 * (options.models === 'real' ? 6 : 3) + 60_000;
    await until(async () => ((await (await fetch(`${head.url}/v1/stream`)).json()) as { stream: { phase: string } }).stream.phase === 'ended', budget, 'the stream to end');
    // The closing line is spoken, and the last receipts come in.
    await until(() => mouth.spoken.some(line => line.kind === 'closing'), 25_000 / options.speed + 8_000, 'the closing line').catch(() => undefined);
    const view = (await (await fetch(`${head.url}/v1/stream`)).json()) as { stats: Record<string, any>; notices: unknown[] };
    finalSummary = { streamId };
    const earReport = await ear.stop();
    await mouth.stop();
    const report = buildReport({ options: { models: options.models, ear: options.ear, speed: options.speed, minecraft: options.minecraft, chatWrites: options.chatWrites },
      chat, epochMs, apiSent: youtube.counts.sent, apiCounts: { ...youtube.counts, inserted: youtube.counts.inserted.length }, ear: earReport,
      spoken: mouth.spoken, calls: head.calls, usage: head.usage, stats: view.stats, notices: view.notices, jev: { real: head.realJev, calls: view.stats.measure.gate.jevCalls },
      finalSummary, wallSeconds: (Date.now() - wallStart) / 1000 });
    if (options.outDir) {
      mkdirSync(options.outDir, { recursive: true });
      writeFileSync(join(options.outDir, 'stream-bench.json'), `${JSON.stringify(report, null, 2)}\n`);
      writeFileSync(join(options.outDir, 'stream-bench.md'), `${markdown(report)}\n`);
    }
    return report;
  } finally {
    game?.stop();
    await mouth.stop().catch(() => undefined);
    await youtube.close();
    await head.close();
  }
}

function parse(argv: readonly string[]): BenchOptions {
  const value = (name: string): string | undefined => argv.find(item => item.startsWith(`--${name}=`))?.slice(name.length + 3);
  const models = value('models') === 'real' ? 'real' : 'fake';
  const ear = value('ear') === 'external' ? 'external' : 'inline';
  const speed = Number(value('speed') ?? (models === 'real' ? 10 : 60));
  const maxModelCalls = Number(value('max-calls'));
  return {
    models, ear, speed: Number.isFinite(speed) && speed >= 1 ? speed : 60, fakeLatencyMilliseconds: Number(value('fake-latency') ?? 2500),
    ...(value('ear-cmd') ? { earCommand: value('ear-cmd')! } : {}), ...(value('ear-cwd') ? { earCwd: value('ear-cwd')! } : {}),
    ...(Number.isFinite(maxModelCalls) && maxModelCalls > 0 ? { maxModelCalls } : {}), minecraft: argv.includes('--minecraft'), chatWrites: argv.includes('--chat-writes'), streamList: !argv.includes('--no-stream-list'),
    outDir: resolve(value('out') ?? join(here, 'out')), log: argv.includes('--verbose') ? line => console.error(line) : () => undefined,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const options = parse(process.argv.slice(2));
  runBench(options).then(report => {
    console.log(markdown(report));
    console.log(`written to ${options.outDir}`);
  }).catch(error => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
