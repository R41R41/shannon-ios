import { readFileSync, writeFileSync } from 'node:fs';
import { loadAllRuns } from './allRuns.js';
import { decisionOf, loadScenes } from './score.js';
import { mechOf, type Mech } from './inspectMech.js';
import { rewriteLive } from './rewriteLive.js';

/**
 * 点検の表（10/23、API を使わない）。場面ごとの「正しい手に要る事実」の表（results/decision-rewrite-inspect-facts-20261023.json。
 * 事実の洗い出しと、ある・無い・誤り・省略の判定、突き合わせの回数は、場面の dump を読んで人手（Sonnet の点検役 3 人）が付け、地図のマスは cellLook.ts で確かめた）と、
 * 機械で数えられる所（inspectMech.ts）を合わせて、場面ごとの表と型ごとの集計を markdown にする。
 *   node --import tsx tests/decisionReplay/inspectReport.ts <facts.json> <出力 .md>
 */
interface Fact { fact: string; cells: string[]; status: 'ある' | '無い' | '誤り' | '省略'; where: string; lookups: number | null; lookupSteps: string; note: string }
interface SceneFacts { scene: string; facts: Fact[]; summary: string }
const [factsFile, outFile] = process.argv.slice(2);
if (!factsFile || !outFile) throw new Error('usage: inspectReport.ts <facts.json> <out.md>');
const facts = JSON.parse(readFileSync(factsFile, 'utf8')) as SceneFacts[];
const runs = loadAllRuns();
const scenes = loadScenes();
const mech = new Map<string, { before: Mech; after: Mech }>();
for (const scene of scenes) {
  const live = decisionOf(runs, scene).live as Record<string, any>;
  mech.set(scene.id.slice(0, 3), { before: mechOf(scene.id, live), after: mechOf(scene.id, rewriteLive(live).live) });
}
const pct = (n: number, d: number) => d ? `${(100 * n / d).toFixed(0)}%` : '-';
const out: string[] = [];
const allFacts = facts.flatMap(item => item.facts.map(fact => ({ scene: item.scene, ...fact })));
const byStatus = (status: string) => allFacts.filter(fact => fact.status === status);
const readable = allFacts.filter(fact => fact.status === 'ある' && fact.lookups !== null);
const lk = readable.map(fact => fact.lookups!);

out.push('# 点検の表: 正しい手に要る事実は、Opus が見た live にどう見えているか（45 場面、API を使わない）\n');
out.push('- 事実の洗い出し・判定・突き合わせの数え方は人手（点検役 3 人 = Sonnet のサブエージェント、地図のマスは `cellLook.ts` で機械で確認）。要らない欄・誤り・省略・地図の形は `inspectMech.ts` が機械で数えた。');
out.push('- 突き合わせ（lookups）の数え方: 地図の 1 マス = 2（層を y で選ぶ + その層の x の目盛り・範囲で列を合わせる、`@` だけ 1）、1 歩歩けるか = 足・頭・床の 3 マス = 6、`縦` の行 = 1（+連なりを座標に直す 1）、止まった手の周りの略記 1 マス = 3、同じ敵・場所を別の欄と突き合わせる = 欄ごとに +1、相対位置の計算 +1、文に座標つきで直接書かれた事実 = 1。\n');

out.push('## 1. 事実の見え方（全場面の合計）\n');
out.push(`正しい手に要る事実 ${allFacts.length} 個（1 場面あたり ${(allFacts.length / facts.length).toFixed(1)}）。\n`);
out.push('| 見え方 | 個数 | 割合 | 内容 |', '|---|---:|---:|---|');
out.push(`| ある（書かれている） | ${byStatus('ある').length} | ${pct(byStatus('ある').length, allFacts.length)} | 平均 ${(lk.reduce((a, b) => a + b, 0) / lk.length).toFixed(2)} 回の突き合わせで読める（最大 ${Math.max(...lk)}） |`);
out.push(`| 無い | ${byStatus('無い').length} | ${pct(byStatus('無い').length, allFacts.length)} | live のどこにも書かれていない（敵の視線・地図の範囲の外・規則・敵の性質など） |`);
out.push(`| 誤り | ${byStatus('誤り').length} | ${pct(byStatus('誤り').length, allFacts.length)} | 書かれているが値が事実と合わない・他の欄と食い違う |`);
out.push(`| 省略で見えない | ${byStatus('省略').length} | ${pct(byStatus('省略').length, allFacts.length)} | 「ほか N 件（長いため略）」の中に入っているかもしれない |`);
out.push(`\n「ある」の事実の突き合わせの回数の分布（${lk.length} 個）:\n`);
out.push('| 回数 | 1 | 2 | 3〜4 | 5〜6 | 7 以上 |', '|---|---:|---:|---:|---:|---:|');
out.push(`| 事実の数 | ${lk.filter(n => n === 1).length} | ${lk.filter(n => n === 2).length} | ${lk.filter(n => n >= 3 && n <= 4).length} | ${lk.filter(n => n >= 5 && n <= 6).length} | ${lk.filter(n => n >= 7).length} |`);
out.push(`\n- 地図から読む事実（lookupSteps に「地図」を含む）は ${readable.filter(f => /地図|層|縦/u.test(f.lookupSteps)).length} 個、平均 ${(() => { const list = readable.filter(f => /地図|層|縦/u.test(f.lookupSteps)).map(f => f.lookups!); return (list.reduce((a, b) => a + b, 0) / Math.max(1, list.length)).toFixed(2); })()} 回。文（lastResults・investigation・欄）に直接書かれた事実は ${readable.filter(f => !/地図|層|縦/u.test(f.lookupSteps)).length} 個、平均 ${(() => { const list = readable.filter(f => !/地図|層|縦/u.test(f.lookupSteps)).map(f => f.lookups!); return (list.reduce((a, b) => a + b, 0) / Math.max(1, list.length)).toFixed(2); })()} 回。`);
out.push(`- 場面のうち、「ある」でない事実を 1 つ以上持つ場面は ${facts.filter(item => item.facts.some(fact => fact.status !== 'ある')).length}/${facts.length}。`);

const m = [...mech.values()];
const sum = (side: 'before' | 'after', pick: (x: Mech) => number) => m.reduce((a, r) => a + pick(r[side]), 0);
const scenesWith = (side: 'before' | 'after', pick: (x: Mech) => number) => m.filter(r => pick(r[side]) > 0).length;
out.push('\n## 2. 型ごとの集計（機械で数えた。左が今の live、右が書き直した live）\n');
out.push('| 型 | 何を数えたか | 今の live（合計 / 場面数） | 書き直した live |', '|---|---|---|---|');
const row = (kind: string, what: string, pick: (x: Mech) => number) => out.push(`| ${kind} | ${what} | ${sum('before', pick)} / ${scenesWith('before', pick)} 場面 | ${sum('after', pick)} / ${scenesWith('after', pick)} 場面 |`);
row('要らない欄', 'ownerClock（日付）', x => x.useless.ownerClock);
row('要らない欄', 'waiting', x => x.useless.waiting);
row('要らない欄', 'observations（generation のハッシュ・taskId）', x => x.useless.observations);
row('要らない欄', 'recall の項目（前のタスクの記録・死の記録）', x => x.useless.recallItems);
row('要らない欄', 'plan.now・plan.path が body.planNow と同じ', x => x.useless.planDup);
row('要らない欄', 'plan.rules の重複', x => x.useless.ruleDup);
row('誤り', 'biome が次元に無い物（ネザーなのに badlands）', x => x.wrong.biome);
row('誤り', '持ち物の同じ物が複数行（名前の重なり）', x => x.wrong.invDupNames);
row('誤り', 'urgent の同じ敵が 2 行', x => x.wrong.urgentDupLines);
row('誤り', 'urgent「blaze 4.3m」と unreachable の同じ種類・近い距離の敵の食い違い', x => x.wrong.urgentVsUnreachable);
row('誤り', '目印の相対位置が今の足から計算した値と違う行', x => x.wrong.landmarkStale);
row('誤り', '文字の欠け（undefined）', x => x.wrong.undefinedText);
row('省略', '「ほか N 件（長いため略）」の印の数', x => x.omit.markers);
row('省略', '略された件数の合計', x => x.omit.hidden);
row('省略', 'lastResults の「…」で切れた行', x => x.omit.truncatedLines);
row('読みにくさ', '止まった手の周りの略記（北が上・西が左・斜線）', x => x.map.compactAround);
row('読みにくさ', '地図の層の数（合計）', x => x.map.layers);
row('読みにくさ', '地図の層の範囲が見出しの範囲と違う場面', x => x.map.mainDiffersFromLayers ? 1 : 0);
out.push(`\n- 地図の層は 1 場面あたり平均 ${(sum('before', x => x.map.layers) / m.length).toFixed(1)} 枚、横の目盛りは x の下 1 桁だけ。層の範囲の種類は 1 場面あたり平均 ${(sum('before', x => x.map.distinctRanges) / m.length).toFixed(1)}（書き直した live は 1）。`);
out.push(`- 目印の相対位置の誤りは 目印の行 ${sum('before', x => x.landmarkRows)} 行中 ${sum('before', x => x.wrong.landmarkStale)} 行（${pct(sum('before', x => x.wrong.landmarkStale), sum('before', x => x.landmarkRows))}）。`);
out.push(`- live の大きさ: 今 ${sum('before', x => x.chars)} 字 → 書き直し ${sum('after', x => x.chars)} 字（周りと道の行・地図の同じ範囲への拡張で増える。外した欄で減る）。`);
out.push('- 省略の印は書き直した live でも残る（記録に無いので作れない）。「ほか N 件は略」に短くしただけ。');

out.push('\n## 3. 「ある」でない事実の内訳（人手の判定）\n');
const unseen = allFacts.filter(fact => fact.status !== 'ある');
const kindOf = (fact: (typeof allFacts)[number]): string => {
  const text = `${fact.fact} ${fact.note}`;
  if (fact.status === '省略') return '省略: 「ほか N 件」に隠れた敵・持ち物・止まり';
  if (fact.status === '誤り') return '誤り: 目印の相対位置・足の位置・古い注意・地図と記録の食い違い';
  if (/見られ|視線|見通し|射線|見える|見えない/u.test(text)) return '無い: 敵の視線（見られるか）・dig の届き方（見通し）';
  if (/地図は|地図に無い|範囲外|地図の外|層が無い|層は|その高さの層/u.test(text)) return '無い: 地図の範囲の外（掘る先・逃げ先・先の地形）';
  if (/規則|知識|性質|answer|recovery|橋|tool:|満腹|回復|体力|秒|stopIf|footing/u.test(text)) return '無い: 規則・敵の性質・時間・足場の行';
  return '無い: そのほか';
};
const kindCount = new Map<string, number>();
for (const fact of unseen) kindCount.set(kindOf(fact), (kindCount.get(kindOf(fact)) ?? 0) + 1);
out.push('| 内訳（おおまか。1 つの事実を 1 つに振る） | 個数 |', '|---|---:|', ...[...kindCount].sort((a, b) => b[1] - a[1]).map(([kind, n]) => `| ${kind} | ${n} |`));
out.push('\n誤りの事実（全部、人手の判定の note から）:\n', ...byStatus('誤り').map(fact => `- ${(fact as { scene: string }).scene}: ${fact.fact} — ${fact.note.slice(0, 160)}`));

out.push('\n## 4. 場面ごとの表\n');
out.push('| 場面 | 種類 | 事実 | ある | 無い | 誤り | 省略 | 突き合わせ（ある の合計 / 最大） | 要らない欄（数） | 誤り（数） | 略の件数 | 層 | 周りの略記 |', '|---|---|---:|---:|---:|---:|---:|---|---:|---:|---:|---:|---:|');
for (const scene of scenes) {
  const id = scene.id.slice(0, 3);
  const item = facts.find(entry => entry.scene === id)!;
  const mm = mech.get(id)!.before;
  const list = item.facts.filter(fact => fact.status === 'ある' && fact.lookups !== null).map(fact => fact.lookups!);
  const count = (status: string) => item.facts.filter(fact => fact.status === status).length;
  const useless = mm.useless.ownerClock + mm.useless.waiting + mm.useless.observations + mm.useless.recallItems + mm.useless.planDup + mm.useless.ruleDup;
  const wrong = mm.wrong.biome + mm.wrong.invDupNames + mm.wrong.urgentDupLines + mm.wrong.urgentVsUnreachable + mm.wrong.landmarkStale + mm.wrong.undefinedText;
  out.push(`| ${id} ${scene.title.slice(0, 22)} | ${scene.category.join(',')} | ${item.facts.length} | ${count('ある')} | ${count('無い')} | ${count('誤り')} | ${count('省略')} | ${list.reduce((a, b) => a + b, 0)} / ${list.length ? Math.max(...list) : 0} | ${useless} | ${wrong} | ${mm.omit.hidden} | ${mm.map.layers} | ${mm.map.compactAround} |`);
}

out.push('\n## 5. 場面ごとの事実（人手の判定。status が「ある」以外は note つき）\n');
for (const item of facts) {
  const scene = scenes.find(entry => entry.id.startsWith(`${item.scene}-`))!;
  out.push(`### ${scene.id}: ${scene.title}\n`, `- 判定: ${item.summary}`);
  for (const fact of item.facts) out.push(`- 【${fact.status}${fact.lookups !== null ? ` ${fact.lookups} 回` : ''}】${fact.fact}${fact.cells.length ? `（${fact.cells.join(' ')}）` : ''} — ${fact.where || '-'}${fact.lookupSteps ? `（${fact.lookupSteps}）` : ''}${fact.note ? ` ※${fact.note}` : ''}`);
  out.push('');
}
writeFileSync(outFile, `${out.join('\n')}\n`);
console.log(out.slice(0, 60).join('\n'));
