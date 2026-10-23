import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { foreignToolNames } from '../../src/contracts/minecraftLlmcToolWords.js';
import { loadAllRuns, dataFile } from './allRuns.js';
import { decisions } from './load.js';

/**
 * 要約（bootstrap の summary の 8 つの欄の行）の数え方（B の直しの比べ）。行は欄の文字列 1 つ。
 *  (i) 菜単（mc.act・mc.probe・mc.view・plan.update・fca_wait・fca_complete）に無い道具の名前を書いた行（本番の木の foreignToolNames と同じ規則。mc.goal-evidence も数える）。
 *  (ii) 指示文に無い決まり・しきい値を書いた行（規則の語 + 数・限り・禁止など。機械の見立て。数えた行は一覧にして目で確かめた）。
 *  (iii) live に出ている事実（持ち物・装備・体力・満腹・現在地）を「未確認」「確認する」と書いた行。
 *  (iv) 「次」の行が、その epoch の最初の判断の live の今の節（planNow）より前の節（もう済んでいる節: 計画は番号順に進む）を挙げた行。要約器は計画を渡されないので、
 *       修正の指示（「次は計画の節の題名で」）では古い節を次に挙げやすいかを見る。blocked の節は除く。
 *   node --import tsx tests/decisionReplay/sumCount.ts [out.md]
 */
const RULE = /(hpBelow|hostileWithin|stopIf|一歩(ずつ|1マス|だけ)|段差\s*\d|最大\s*\d|\d+\s*種|\d+\s*m\s*(以内|まで)|\d+\s*マス(まで|以内|ずつ)|届く(距離|範囲)|必ず|禁止|掘らない|置かない|送らず|避ける|避け、|前に(掘|置|整)|ずつ(進|掘|歩)|まで(に|は)?(する|掘る))/u;
const LIVE_FACT = /(持ち物|所持品|所持|在庫|装備|防具|盾|体力|満腹|現在地|位置|黒曜石の?(数|所持)|黒曜石数|食料|インベントリ)/u;
const UNCHECKED = /(未確認|確認が必要|確認する|を確認|確認し|再確認|observe)/u;
const NODE = /\bp\d+(?:\.\d+)*\b/gu;
const SECTIONS = ['目的', '制約', '済み', '途中', '詰まり', '決めたこと', '次', '重要な文脈'];
interface Source { label: string; tag: string; run: string; epoch: number; text: string }
const runs = loadAllRuns();
const sources: Source[] = [];
for (const run of ['r37', 'r36']) for (const tag of ['base', 'fix', 'base2', 'base3', 'fix2', 'fix3', 'fix4']) {
  const file = dataFile(`bootstrap-${run}.${tag}.json`);
  if (!existsSync(file)) continue;
  const all = JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>;
  const suffix = /[0-9]$/u.test(tag) ? ` #${tag.slice(-1)}` : '';
  for (const [epoch, text] of Object.entries(all)) {
    // 実走36 の基準の epoch 4 は本番の本物（作り直しは .regenerated-epoch4.json）。
    sources.push({ label: `${run} e${epoch}${tag === 'base' && run === 'r36' && epoch === '4' ? '（本物）' : ''}${suffix}`, tag: tag.replace(/[0-9]+$/u, ''), run, epoch: Number(epoch), text });
  }
  const regenerated = `${file}.regenerated-epoch4.json`;
  if (tag === 'base' && run === 'r36' && existsSync(regenerated)) sources.push({ label: 'r36 e4（作り直し）', tag, run, epoch: 4, text: readFileSync(regenerated, 'utf8') });
}
// 本番が最後に残した本物（実走37 の rev 7）
sources.push({ label: 'r37 rev7（本物）', tag: 'real', run: 'r37', epoch: 7, text: runs.get('r37')!.summary!.bootstrap });

const order = (id: string): number[] => id.slice(1).split('.').map(Number);
const before = (a: string, b: string): boolean => {
  const x = order(a), y = order(b);
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    if ((x[i] ?? -1) !== (y[i] ?? -1)) return (x[i] ?? -1) < (y[i] ?? -1);
  }
  return false;
};
/** その epoch の最初の判断の live の、今の節の id と blocked の id。 */
function planNow(run: string, epoch: number): { current: string; blocked: Set<string> } | null {
  const first = decisions(runs.get(run)!).find(item => item.epoch === epoch && item.epochStart === item.index);
  if (!first) return null;
  const plan = first.live.plan as { blocked?: string[] } | undefined;
  const current = [...String((first.live.body as { planNow?: string } | undefined)?.planNow ?? '').matchAll(NODE)][0]?.[0];
  return current ? { current, blocked: new Set((plan?.blocked ?? []).flatMap(text => [...text.matchAll(NODE)].map(match => match[0]))) } : null;
}

const rows: string[] = [];
const total: Record<string, { summaries: number; lines: number; tools: number; rules: number; unchecked: number; stale: number; nexts: number }> = {};
const flagged: string[] = [];
for (const source of sources.sort((a, b) => a.run.localeCompare(b.run) || a.epoch - b.epoch || a.tag.localeCompare(b.tag))) {
  const summary = (JSON.parse(source.text) as { summary: Record<string, unknown> }).summary;
  let lines = 0, tools = 0, rules = 0, unchecked = 0, stale = 0, nexts = 0;
  const now = source.epoch <= 6 && source.tag !== 'real' ? planNow(source.run, source.epoch) : null;
  for (const section of SECTIONS) {
    for (const item of Array.isArray(summary[section]) ? summary[section] as unknown[] : []) {
      if (typeof item !== 'string') continue;
      lines += 1;
      const names = foreignToolNames(item);
      const isRule = RULE.test(item) && ['制約', '決めたこと', '次', '重要な文脈'].includes(section);
      const isUnchecked = UNCHECKED.test(item) && LIVE_FACT.test(item);
      if (section === '次') {
        nexts += 1;
        const done = now ? [...item.matchAll(NODE)].map(match => match[0]).filter(id => before(id, now.current) && !now.blocked.has(id)) : [];
        if (done.length) { stale += 1; flagged.push(`[${source.label} ${source.tag}] (iv) 次: ${item.slice(0, 140)}  ← 今の節 ${now!.current} より前（済み）: ${done.join(',')}`); }
      }
      if (names.length) { tools += 1; flagged.push(`[${source.label} ${source.tag}] (i) ${section}: ${item.slice(0, 140)}  ← ${names.join(',')}`); }
      if (isRule) { rules += 1; flagged.push(`[${source.label} ${source.tag}] (ii) ${section}: ${item.slice(0, 140)}`); }
      if (isUnchecked) { unchecked += 1; flagged.push(`[${source.label} ${source.tag}] (iii) ${section}: ${item.slice(0, 140)}`); }
    }
  }
  rows.push(`| ${source.label} | ${source.tag} | ${lines} | ${tools} | ${rules} | ${unchecked} | ${stale} / ${nexts} |`);
  const t = (total[source.tag] ??= { summaries: 0, lines: 0, tools: 0, rules: 0, unchecked: 0, stale: 0, nexts: 0 });
  t.summaries += 1; t.lines += lines; t.tools += tools; t.rules += rules; t.unchecked += unchecked; t.stale += stale; t.nexts += nexts;
}
const pct = (a: number, b: number) => `${a}（${(a / Math.max(1, b) * 100).toFixed(0)}%）`;
const out = ['| 要約 | 版 | 行 | (i) 無い道具 | (ii) 決まり・しきい値 | (iii) 未確認 | (iv) 済みの節を「次」に（次の行のうち） |', '|---|---|---:|---:|---:|---:|---:|', ...rows, '',
  '| 版 | 要約の数 | 行 | (i) | (ii) | (iii) | (iv)（「次」の行のうち） |', '|---|---:|---:|---:|---:|---:|---:|',
  ...Object.entries(total).map(([tag, t]) => `| ${tag} | ${t.summaries} | ${t.lines} | ${pct(t.tools, t.lines)} | ${pct(t.rules, t.lines)} | ${pct(t.unchecked, t.lines)} | ${t.stale} / ${t.nexts}（${(t.stale / Math.max(1, t.nexts) * 100).toFixed(0)}%） |`), '',
  '## 数えた行', '', ...flagged.map(line => `- ${line}`)];
writeFileSync(dataFile(process.argv[2] ?? 'b-summary-counts.md'), out.join('\n'));
console.log(out.slice(0, rows.length + 12).join('\n'));
