import { existsSync, writeFileSync } from 'node:fs';
import { answerOf } from './checks.js';
import { loadAllRuns } from './allRuns.js';
import { decisions } from './load.js';
import { handLine } from './judge.js';
import { loadScenes, scenesDir } from './score.js';

/**
 * 10/23 の場面の足し（60 場面へ）: 実走28・30・33・34・31 から、ふつうに進んでいる判断 9、止まった直後 3、近い敵・急ぎ 3。
 * 前に足した 45 場面は失敗・止まりに偏っていたので、順調な場面を多めにする。場面のファイルの文は makeScenes.ts と同じく本番の記録から作る
 * （状況・正しい手の条件・実際に起きたこと）。検査は自動の物（形・くり返し・塞がったマスへ歩く）と、急ぎの場面の答え方の行だけ。
 * 良し悪しは後知恵つきの Opus の採点（judge: always）が決める。
 *   node --import tsx tests/decisionReplay/makeScenes2.ts
 */
type Kind = 'normal' | 'stopped' | 'urgent';
const PICK: Array<[string, number, Kind]> = [
  ['r33', 1413, 'normal'], ['r33', 1434, 'normal'], ['r33', 1463, 'normal'], ['r28', 1110, 'normal'], ['r28', 1150, 'normal'], ['r28', 1205, 'normal'],
  ['r34', 1530, 'normal'], ['r34', 1549, 'normal'], ['r30', 1287, 'normal'],
  ['r28', 1175, 'stopped'], ['r33', 1491, 'stopped'], ['r34', 1537, 'stopped'],
  ['r34', 1541, 'urgent'], ['r33', 1446, 'urgent'], ['r31', 1308, 'urgent'],
];
const runs = loadAllRuns();
let number = 1 + Math.max(...loadScenes().map(scene => Number(scene.id.slice(1, 3))));

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
