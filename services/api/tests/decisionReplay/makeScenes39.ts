import { existsSync, writeFileSync } from 'node:fs';
import { answerOf } from './checks.js';
import { loadAllRuns } from './allRuns.js';
import { decisions } from './load.js';
import { handLine } from './judge.js';
import { loadScenes, scenesDir } from './score.js';

/**
 * 10/26 mc-task-queue の比べ: 10/26 の動作確認の実走（dragon26 = 台の r39）から 30 場面（設計 §11.4: 成功の後 15・止まりの後 10・急ぎ 5）。
 * 文は makeScenes2.ts と同じく本番の記録から作る。かまどなどの待ち（WAIT）・同じ手のくり返しの場面には、列や「〜まで続ける」が効くはずという正しい手の条件を足す。
 *   DECISION_REPLAY_SCENES_DIR=scenes-d node --import tsx tests/decisionReplay/makeScenes39.ts
 */
type Kind = 'normal' | 'stopped' | 'urgent';
const PICK: Array<[string, number, Kind]> = [
  ...[2212, 2219, 2222, 2245, 2249, 2255, 2258, 2263, 2267, 2269, 2280, 2283, 2289, 2292, 2323].map(seq => ['r39', seq, 'normal'] as [string, number, Kind]),
  ...[2208, 2215, 2236, 2244, 2262, 2276, 2285, 2295, 2303, 2325].map(seq => ['r39', seq, 'stopped'] as [string, number, Kind]),
  ...[2297, 2301, 2306, 2314, 2318].map(seq => ['r39', seq, 'urgent'] as [string, number, Kind]),
];
const runs = loadAllRuns();
let number = 101;

const first = (text: string) => text.split('\n')[0] ?? '';
function make(key: string, seq: number, kind: Kind) {
  const run = runs.get(key)!;
  const d = decisions(run).find(item => item.row.seq === seq)!;
  const answer = answerOf((d.assistant?.content ?? []) as never);
  const body = (d.live.body ?? {}) as Record<string, any>, state = (body.state ?? {}) as Record<string, any>;
  const minutes = typeof state.minutes === 'number' ? `実走${key.slice(1)} ${state.minutes} 分` : `実走${key.slice(1)}`;
  const threats: string[] = Array.isArray(body.threats) ? body.threats : [];
  const urgent: string[] = Array.isArray(body.urgent) ? body.urgent : [];
  const lastResult = Array.isArray(body.lastResults) && typeof body.lastResults[0] === 'string' ? first(body.lastResults[0]) : '（前の結果なし）';
  const where = `${minutes}、${state.at ?? '?'}（${state.dimension ?? '?'}${state.inside ? `・${state.inside}` : ''}）、体力 ${state.health ?? '?'}`;
  const hands = answer.hands.map((hand, index) => `${index + 1}. ${handLine(hand)}`).join(' / ');
  const resultFirst = first(d.resultText);
  const plan = String(body.planNow ?? '').slice(0, 80);
  const stopLine = d.resultText.split('\n').find(line => /^\d+ \w+ (止|失) /u.test(line)) ?? '';
  const previous = decisions(run)[d.index - 1];
  const previousStop = (previous ? previous.resultText.split('\n').find(line => /^\d+ \w+ (止|失) /u.test(line)) : '') ?? '';
  const tag = { normal: 'steady', stopped: 'after-stop', urgent: 'urgent' }[kind];
  const title = kind === 'normal' ? `順調に進む: ${plan.replace(/^\[[^\]]*\]\s*/u, '').slice(0, 30) || '次の節'}`
    : kind === 'stopped' ? `止まった直後: ${lastResult.slice(0, 30)}` : `近い敵・急ぎ: ${String(urgent[0] ?? threats[0] ?? '').slice(0, 40)}`;
  const id = `s${number}-${key}-${seq}-${tag}`;
  number += 1;
  const scene: Record<string, unknown> = {
    id, run: key, seq, category: kind === 'normal' ? ['progress'] : kind === 'stopped' ? ['stopped'] : ['urgent'], title,
    situation: `${where}。計画の今の節: ${plan || '（なし）'}。敵 ${threats.length} 体（${threats.slice(0, 2).join('、') || 'なし'}）。前の act: ${lastResult}。`
      + `${urgent.length ? `急ぎの行: ${urgent.slice(0, 2).map(line => String(line).slice(0, 100)).join(' / ')}。` : '急ぎの行は無い。'}`,
    correct: kind === 'normal'
      ? '計画の今の節を進める手を、地図で通れる所にだけ出す（塞がったマス・床の無いマスへ walk しない、埋まったマスへ place しない、頭のマスを掘らずに壁の向こうへ歩かない）。'
        + '同じ種類の手が続くなら手をまとめ、危険（敵・溶岩・落差・見られる所）を避ける。'
      : kind === 'stopped'
        ? `直前に止まった手（${(previousStop || stopLine).slice(0, 120)}）と同じ手を同じまま出さない。返った行と地図で原因を直す（頭の高さが固いなら先に dig、床が無ければ先に place、届かないなら歩いて近づく）。地図で通れる所にだけ手を出す。`
        : '急ぎの行に従い、敵に近づかず、離れる・間にブロックを置く・囲う・食べるを先に。手は急ぎの答え方の行があればその数まで。stopIf hpBelow は今の体力より低く、待つ act には hostileWithin を付ける。'
          + '地図で通れる所にだけ手を出す。',
    hindsight: `実際の答え（本番）: ${hands.slice(0, 400)}。体の結果: ${resultFirst.slice(0, 120)}。`,
    judge: 'always',
  };
  const waits = JSON.stringify(answer.input).includes('wait');
  if (waits) scene.correct = `${scene.correct} 焼く・待つ間（かまど・ベッド）は立って待たず、別の手（掘る・集める・作る）を入れる。wait は他に手が無い時だけ。`;
  if (kind === 'urgent') {
    scene.must = body.answer ? [{ id: 'answer-line', why: '急ぎの答え方の行（手は 3 つまで）に従う', check: { kind: 'answerLine' } }] : [];
    scene.want = [{ id: 'urgent-safe-first', why: '急ぎの先頭は 置く・食べる・持ち替える・掘る・打つ・敵から離れる', check: { kind: 'urgentSafe' } }];
    if (!(scene.must as unknown[]).length) delete scene.must;
  }
  const file = `${scenesDir}${id}.json`;
  if (existsSync(file)) throw new Error(`exists ${file}`);
  writeFileSync(file, `${JSON.stringify(scene, null, 2)}\n`);
  return id;
}
console.log(PICK.map(([key, seq, kind]) => make(key, seq, kind)).join('\n'));
