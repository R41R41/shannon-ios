## 1. 正しさ（60 場面 × 回数。○=1 △=0.5 ×=0。未採点 = 採点者がまだ付けていない ○△ の候補で、平均点には入れない）

| 見え方 | 回数 | ○ | △ | × | 未採点 | 平均点（未採点を除く） | 場面ごとの平均の平均 |
|---|---:|---:|---:|---:|---:|---:|---:|
| 本番の記録（n=1、場面の時の版） | 60 | 8 | 0 | 20 | 32 | 0.29 | 0.29 |
| v1 基準 v1（今の本番の指示文と live）の生の答え | 160 | 21 | 0 | 35 | 104 | 0.38 | 0.35 |
| v1t 基準 v1 + 本番の頭の変換（形の整え・stopIf の点検） | 160 | 21 | 0 | 32 | 107 | 0.40 | 0.37 |

## 2. 種類ごとの ○ / 回数

| 見え方 | stopped | urgent | death | progress | plan |
|---|---:|---:|---:|---:|---:|
| prod | 3/24 | 4/19 | 0/5 | 3/22 | 0/4 |
| v1 | 15/60 | 9/49 | 0/12 | 3/64 | 7/9 |
| v1t | 15/60 | 9/49 | 0/12 | 3/64 | 7/9 |

## 3. ×の中身（回数。1 つの答えが複数に当たることがある）

| ×の種類 | prod | v1 | v1t |
|---|---:|---:|---:|
| 塞がった・床の無いマスへ walk（足から 2 マス以内） | 3 | 13 | 13 |
| 塞がった・床の無いマスへ walk（足から 3 マス以上先） | 6 | 7 | 7 |
| 止まった手のくり返し | 4 | 8 | 8 |
| 規則・場面の必須: no-bare-bridge | 3 | 2 | 2 |
| 体に送れない形 | 0 | 3 | 3 |
| 規則・場面の必須: stopif-hostile | 1 | 3 | 0 |
| 規則・場面の必須: dig-needs-hand | 1 | 1 | 1 |
| 規則・場面の必須: no-expose | 1 | 0 | 0 |
| 規則・場面の必須: no-redig-seen | 1 | 0 | 0 |
| 規則・場面の必須: not-p3 | 1 | 0 | 0 |
| （答えの数） | 60 | 160 | 160 |

## 4. 時間・トークン・費用（1 判断。自分の PC からストリームで測る。キャッシュは 5 分、場面の間は連続でないので本番より書き込みが多い）

| 変種 | 呼び出し | 最初のブロックまで p50 / p95 (s) | 全体 p50 / p95 (s) | 入力の合計 平均 | うち新規 | キャッシュ読み | キャッシュ書き | 出力 平均 | うち答え | 見えない考え | 費用 平均（この台の実額） | 本番想定 1 判断 | 合計 |
|---|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| v1 | 160 | 2.5 / 4.4 | 6.8 / 10.9 | 51332 | 3543 | 43958 | 3831 | 587 | 312 | 275 | 0.0539 | 0.0417 | 8.62 |

温かい呼び出し（2・3 回目）だけ:

| 変種 | 呼び出し | 最初のブロックまで p50 (s) | 全体 p50 / p95 (s) | 費用 平均 |
|---|---:|---:|---|---:|
| v1 | 100 | 2.4 | 6.7 / 10.1 | 0.0413 |

## 5. 対の比べ（場面ごとの平均点の差の平均と、場面を引き直した 95% の幅）

| 比べ | 場面の数 | 差の平均 | 95% の幅 | 良くなった / 同じ / 悪くなった（差 0.25 以上） |
|---|---:|---:|---|---|
| v1t − v1 | 30 | 0.000 | 0.000 〜 0.000 | 0 / 30 / 0 |

## 6. 頭の変換を通す前と後（v1 → v1t）

- v1 の答え 160 個（mc.act 153）。stopIf の点検が直す必要があった答え（hpBelow が今の体力以上、または待つ手に hostileWithin 無し）: 7。
- 変換の前後で検査の結果か採点が変わった答え: 3。
  - s22-r33-1479-wait-without-guard 回1: ×（stopif-hostile: 待つ act に stopIf hostileWithin を付ける（stopIf {"hpBelow":11}）） → ?
  - s22-r33-1479-wait-without-guard 回2: ×（stopif-hostile: 待つ act に stopIf hostileWithin を付ける（stopIf {"hpBelow":11}）） → ?
  - s22-r33-1479-wait-without-guard 回3: ×（stopif-hostile: 待つ act に stopIf hostileWithin を付ける（stopIf {"hpBelow":11}）） → ?
- 平均点: 変換なし 0.375 → 変換あり 0.396（未採点: 104 → 107）。
- 「待つ act に hostileWithin が無い」で × になった答え: 変換なし 3 → 変換あり 0。

## 7. 採点者の一致（同じ答えを Opus で 2 回採点）

- 2 回目の採点は無い。

## 8. 場面ごと（回ごとに ○△×、? は未採点）

| 場面 | 種類 | prod | v1 | v1t |
|---|---|---|---|---|
| s01-r32-1321-head-cell | stopped | ? | ?× | ?× |
| s02-r32-1322-seen-stop | stopped,urgent | × | ?? | ?? |
| s03-r32-1353-bare-hand | stopped | × | ×? | ×? |
| s05-r33-1403-solid-target | stopped | × | ×× | ×× |
| s06-r33-1405-pillar-air | stopped | ? | ?× | ?× |
| s07-r33-1436-void-edge | stopped | ○ | ○○ | ○○ |
| s08-r34-1520-follow-look-line | stopped | ? | ?×× | ?×× |
| s09-r34-1536-bridge-repeat | stopped | × | ××× | ××× |
| s11-r33-1389-first-urgent | urgent | ○ | ○○ | ○○ |
| s12-r33-1426-void-piglin | urgent | ? | ?? | ?? |
| s13-r33-1443-enderman-sight | urgent,stopped | ? | ?? | ?? |
| s14-r33-1452-walk-solid | urgent,stopped | × | ?? | ?? |
| s15-r33-1476-zpiglin-sight | urgent | ? | ??? | ??? |
| s16-r34-1522-blaze-close | urgent,stopped | ? | ??? | ??? |
| s17-r34-1550-piglin-sight | urgent | ? | ??? | ??? |
| s18-r34-1552-low-hp | urgent | ? | ??? | ??? |
| s19-r32-1336-lava-gap | death | × | ×? | ×? |
| s20-r32-1344-accept-seen | death,stopped | × | ?? | ?? |
| s21-r32-1345-death | death,urgent | × | ?× | ?× |
| s22-r33-1479-wait-without-guard | death,urgent | × | ××× | ??? |
| s23-r33-1480-death | death,urgent | ? | ??? | ??? |
| s24-r32-1325-tunnel | progress | ○ | ?○ | ?○ |
| s25-r33-1411-tunnel | progress | ○ | ×? | ×? |
| s27-r34-1548-tunnel | progress | ○ | ○○? | ○○? |
| s28-r32-1334-after-plan-update | plan,stopped | × | ○○ | ○○ |
| s29-r33-1409-head-cell | plan,stopped | × | ○○ | ○○ |
| s30-r34-1516-after-plan-update | plan,stopped | × | ○○○ | ○○○ |
| s31-r33-1457-plan-skip | plan | × | ?? | ?? |
| s32-r33-1456-low-hp-eat | urgent | ○ | ○? | ○? |
| s33-r33-1473-void-edge-4th | urgent,stopped | ? | ○?? | ○?? |
| s34-r33-1395-blaze-6m | urgent,stopped | ○ | ○○ | ○○ |
| s35-r34-1538-on-bridge | urgent,stopped | ○ | ○○○ | ○○○ |
| s36-r30-1273-steady | progress | ? | ??? | ??? |
| s37-r30-1276-steady | progress | ? | ??? | ??? |
| s38-r30-1282-steady | progress | ? | ??? | ??? |
| s39-r30-1289-steady | progress | ? | ??? | ??? |
| s40-r31-1316-steady | progress | ? | ×?? | ×?? |
| s41-r31-1317-steady | progress | ? | ??? | ??? |
| s42-r28-1197-steady | progress | ? | ??? | ??? |
| s43-r28-1201-steady | progress | × | ××× | ××× |
| s44-r28-1204-steady | progress | ? | ??? | ??? |
| s45-r28-1214-steady | progress | × | ?×× | ?×× |
| s46-r30-1258-after-stop | stopped | × | ??? | ??? |
| s47-r31-1302-after-stop | stopped | ? | ??× | ??× |
| s48-r30-1293-after-stop | stopped | × | ??? | ??? |
| s49-r33-1413-steady | progress | ? | ??× | ??× |
| s50-r33-1434-steady | progress | ? | ??? | ??? |
| s51-r33-1463-steady | progress | ? | ××? | ××? |
| s52-r28-1110-steady | progress | ? | ??? | ??? |
| s53-r28-1150-steady | progress | ? | ??? | ??? |
| s54-r28-1205-steady | progress | ? | ×?× | ×?× |
| s55-r34-1530-steady | progress | ? | ??? | ??? |
| s56-r34-1549-steady | progress | ? | ??? | ??? |
| s57-r30-1287-steady | progress | ? | ??? | ??? |
| s58-r28-1175-after-stop | stopped | × | ?×× | ?×× |
| s59-r33-1491-after-stop | stopped | × | ?×× | ?×× |
| s60-r34-1537-after-stop | stopped | × | ??? | ??? |
| s61-r34-1541-urgent | urgent | ? | ??? | ??? |
| s62-r33-1446-urgent | urgent | ? | ××× | ××× |
| s63-r31-1308-urgent | urgent | ? | ??? | ??? |

## 9. 回数と場面の種類

| 変種 | 場面 | 1 回 | 2 回 | 3 回以上 | 呼び出し |
|---|---:|---:|---:|---:|---:|
| v1 | 60 | 0 | 20 | 40 | 160 |

場面 60: stopped 13、stopped+urgent 1、urgent 9、urgent+stopped 6、death 1、death+stopped 1、death+urgent 3、progress 22、plan+stopped 3、plan 1。
