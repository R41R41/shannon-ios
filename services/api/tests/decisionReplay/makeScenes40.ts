import { existsSync, writeFileSync } from 'node:fs';
import { answerOf } from './checks.js';
import { loadAllRuns } from './allRuns.js';
import { decisions } from './load.js';
import { handLine } from './judge.js';
import { loadScenes, scenesDir } from './score.js';

/**
 * 10/27 mc-run39-fixes の比べ: 実走 39（rel55b、台の r40）から、新しい手（go・obsidian・fight・mine・make・portal・smelt）が効くはずの 10 場面:
 * 移動の止まり 2・黒曜石づくり 2・作業台が無い 2・準備を飛ばして地下へ下りる 2・柱で上がる 2。文は makeScenes39.ts と同じく本番の記録から作る。
 *   DECISION_REPLAY_SCENES_DIR=scenes-e node --import tsx tests/decisionReplay/makeScenes40.ts
 */
type Kind = 'normal' | 'stopped' | 'urgent';
type Theme = 'move' | 'obsidian' | 'table' | 'descend' | 'pillar';
const PICK: Array<[string, number, Kind, Theme]> = [
  ['r40', 2332, 'stopped', 'move'], ['r40', 2405, 'stopped', 'move'],
  ['r40', 2415, 'normal', 'obsidian'], ['r40', 2423, 'normal', 'obsidian'],
  ['r40', 2392, 'stopped', 'table'], ['r40', 2399, 'normal', 'table'],
  ['r40', 2342, 'normal', 'descend'], ['r40', 2381, 'normal', 'descend'],
  ['r40', 2371, 'normal', 'pillar'], ['r40', 2389, 'stopped', 'pillar'],
];
const OUTCOME: Record<number, string> = {
  2332: '村の箱へ向かう walk は 4 回「経路探索は道を見つけたが体は進まなかった」で止まった（+80〜+123 秒）。',
  2405: '東の空洞へ着くまでに walk が何度も止まり、+1,664〜+1,704 秒かかった（足元が空気・足のマスが塞がる止まり）。',
  2415: '黒曜石づくり（+1,628〜+2,074 秒、446 秒）は水の手が「満たされない」4・「立てない」3・「着けない」4 で止まり、黒曜石 0 個のまま予算で止まった。後ろの項目を 7 本捨てた。',
  2423: '黒曜石づくり（+1,628〜+2,074 秒、446 秒）は水の手が「満たされない」4・「立てない」3・「着けない」4 で止まり、黒曜石 0 個のまま予算で止まった。',
  2392: '作業台を持たず +584 に y=7 へ置いたまま下りたので、ダイヤ 4 個の後に作業台が無く（板 2）、柱（pillarUp）は 9 回とも「1段目が積めなかった」。階段掘りでツルハシ 2 本が壊れ、素手の掘りを経て廃坑の板で作業台を作るまで約 400 秒（+1,192〜+1,592）かかった。',
  2399: '素手で階段を掘り上がる手は deepslate 1 個に 15 秒かかり、114 秒で取り消された。作業台が無いことの詰まりは約 400 秒（+1,192〜+1,592）。',
  2342: '食料 17.6 点（鉄の夜の前は 40 点）のまま地下 y=55 へ下りた。下りる注意は 1 回出たが、why に理由（「洞窟の動物・ゾンビ肉と芋で補う」）を書いて進んだ。',
  2381: '盾が無く鉄の兜・胸当て・脚は 2/3、食料 17.6 点のまま、ダイヤを掘りに下りた（shortage の行は出ていたが止めなかった）。',
  2371: 'pillarUp は 9 回呼ばれ、9 回とも「1段目が積めなかった（足元は今 air）。0段登った」。',
  2389: 'pillarUp は 9 回呼ばれ、9 回とも「1段目が積めなかった（足元は今 air）。0段登った」。',
};
const HINT: Record<Theme, string> = {
  move: '歩く手が進まない・止まる所では、原因（頭の高さ・足元・道が無い）を直す。掘ってよい物・置いてよい物を挙げて道の細部を体に任せる手や、別の道もよい。',
  obsidian: '黒曜石を作る手順（水を溶岩の源の隣へ注ぐ → 固まる → ダイヤのツルハシで掘る → 水を汲み戻す）を、立つ足場と水の位置を確かめて進める。同じ止まりを繰り返さない。',
  table: '作業台（または板 4 以上）と予備のツルハシが無いまま先へ進まない。道具を作る・直すために必要な物を確かめてから動く。',
  descend: '食料・装備・作業台・予備の道具（shortage と準備の決まり）が足りないまま地下へ下りない。足りない物を先に埋めるか、下りる理由と備えを why に書く。',
  pillar: '柱（pillarUp）で上がる手が積めずに止まっている。同じ手を同じまま出さず、足元・頭上・置く物を確かめ、別の上がり方（階段掘り・足場）にする。',
};
const runs = loadAllRuns();
let number = 201;

const first = (text: string) => text.split('\n')[0] ?? '';
function make(key: string, seq: number, kind: Kind, theme: Theme) {
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
  const tag = theme;
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
  scene.correct = `${scene.correct} ${HINT[theme]}`;
  scene.hindsight = `${scene.hindsight} 実際の経過（実走39 の報告）: ${OUTCOME[seq]}`;
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
console.log(PICK.map(([key, seq, kind, theme]) => make(key, seq, kind, theme)).join('\n'));
