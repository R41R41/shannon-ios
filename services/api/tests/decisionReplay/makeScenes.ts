import { existsSync, writeFileSync } from 'node:fs';
import { answerOf } from './checks.js';
import { loadAllRuns } from './allRuns.js';
import { decisions } from './load.js';
import { handLine } from './judge.js';
import { scenesDir } from './score.js';

/**
 * 実走27〜31 から場面を足す（10/23）。ふつうに進んでいる判断 10 と、止まった直後 3。
 * 場面のファイルは、本番の記録から文を作る（状況・正しい手の条件・実際に起きたこと）。検査は自動の物（形・くり返し・塞がったマスへ歩く）だけで、
 * 良し悪しは後知恵つきの Opus の採点（judge: always）が決める。ライ氏が見て直せる形は前の場面と同じ。
 *   node --import tsx tests/decisionReplay/makeScenes.ts
 */
const NORMAL: Array<[string, number]> = [['r30', 1273], ['r30', 1276], ['r30', 1282], ['r30', 1289], ['r31', 1316], ['r31', 1317], ['r28', 1197], ['r28', 1201], ['r28', 1204], ['r28', 1214]];
/** 止まった act の seq（場面はその次の判断）。 */
const AFTER_STOP: Array<[string, number]> = [['r30', 1257], ['r31', 1301], ['r30', 1292]];
const runs = loadAllRuns();
let number = 36;

const first = (text: string) => text.split('\n')[0] ?? '';
function make(key: string, seq: number, kind: 'normal' | 'stopped', stopSeq?: number) {
  const run = runs.get(key)!;
  const ds = decisions(run);
  const d = ds.find(item => item.row.seq === seq)!;
  const answer = answerOf((d.assistant?.content ?? []) as never);
  const body = (d.live.body ?? {}) as Record<string, any>, state = (body.state ?? {}) as Record<string, any>;
  const minutes = typeof state.minutes === 'number' ? `実走${key.slice(1)} ${state.minutes} 分` : `実走${key.slice(1)}`;
  const threats: string[] = Array.isArray(body.threats) ? body.threats : [];
  const lastResult = Array.isArray(body.lastResults) && typeof body.lastResults[0] === 'string' ? first(body.lastResults[0]) : '（前の結果なし）';
  const where = `${minutes}、${state.at ?? '?'}（${state.dimension ?? '?'}${state.inside ? `・${state.inside}` : ''}）、体力 ${state.health ?? '?'}`;
  const hands = answer.hands.map((hand, index) => `${index + 1}. ${handLine(hand)}`).join(' / ');
  const resultFirst = first(d.resultText);
  const plan = String(body.planNow ?? '').slice(0, 80);
  const stopLine = d.resultText.split('\n').find(line => /^\d+ \w+ (止|失) /u.test(line)) ?? '';
  const title = kind === 'normal' ? `順調に進む: ${plan.replace(/^\[[^\]]*\]\s*/u, '').slice(0, 30) || '次の節'}` : `止まった直後: ${lastResult.slice(0, 30)}`;
  const id = `s${number}-${key}-${seq}-${kind === 'normal' ? 'steady' : 'after-stop'}`;
  number += 1;
  const scene = {
    id, run: key, seq, category: kind === 'normal' ? ['progress'] : ['stopped'], title,
    situation: `${where}。計画の今の節: ${plan || '（なし）'}。敵 ${threats.length} 体（${threats.slice(0, 2).join('、') || 'なし'}）。前の act: ${lastResult}。`
      + `${Array.isArray(body.urgent) && body.urgent.length ? `急ぎの行: ${String(body.urgent[0]).slice(0, 100)}。` : '急ぎの行は無い。'}`,
    correct: kind === 'normal'
      ? '計画の今の節を進める手を、地図で通れる所にだけ出す（塞がったマス・床の無いマスへ walk しない、埋まったマスへ place しない、頭のマスを掘らずに壁の向こうへ歩かない）。'
        + '同じ種類の手が続くなら手をまとめ、危険（敵・溶岩・落差・見られる所）を避ける。'
      : `直前に止まった手（${stopLine.slice(0, 120)}）と同じ手を同じまま出さない。返った行と地図で原因を直す（頭の高さが固いなら先に dig、床が無ければ先に place、届かないなら歩いて近づく）。`
        + '地図で通れる所にだけ手を出す。',
    hindsight: `実際の答え（本番）: ${hands.slice(0, 400)}。体の結果: ${resultFirst.slice(0, 120)}。${kind === 'stopped' && stopSeq ? `止まったのは seq ${stopSeq} の act。` : ''}`,
    judge: 'always',
  };
  const file = `${scenesDir}${id}.json`;
  if (existsSync(file)) throw new Error(`exists ${file}`);
  writeFileSync(file, `${JSON.stringify(scene, null, 2)}\n`);
  return id;
}
const made: string[] = [];
for (const [key, seq] of NORMAL) made.push(make(key, seq, 'normal'));
for (const [key, stop] of AFTER_STOP) {
  const ds = decisions(runs.get(key)!);
  const index = ds.findIndex(item => item.row.seq === stop);
  made.push(make(key, ds[index + 1]!.row.seq, 'stopped', stop));
}
console.log(made.join('\n'));
