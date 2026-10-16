# 旧Minecraft実験からの試し手順（draft-3）: 日暮れ前のベッド

owner の依頼（2026-10-17）: 夜を地下で過ごす前に、ベッドを先に確保する。コードで決めず、判断の材料（スキルとその要点）として渡す。

- 新設1本: `mc-bed-before-night`（羊毛でベッド、羊がいなければ村、探して見つからなければ諦めて `mc-night-retreat`）。
- 改訂は無い。`mc-night-retreat`（draft-2）は使われて試しの最中なので、通常の改訂経路では上書きできない。そのままにして、新しい skill から名前で渡す。
- 原典は draft-2 と同じ knowledge snapshot（sha256 60bca0f4…）の seed-bed-from-sheep と seed-night-surface。`selection-report.json` は draft-2 のものを参照し、この版では作り直していない。

## 出し方（コード側、`minecraftSkillPointers.ts`）

- 暗くなるまで 5 分以内かつ 1 分より先で、オーバーワールドにいて、持ち物にベッドが無く、敵が近くにいない時だけ、`mc-bed-before-night` を指す（要点つき）。
- 暗くなる 1 分前からは `mc-night-retreat` の側（探すのを諦める）。2 つが同じ夕方に同時に出ることは無い。敵が近い時も `mc-night-retreat` だけ。
- skill が目次に無い間（import 前）は指さない。コードを先に出して、import を後にしても安全。

## 導入（本番）

owner の承認が要る別の段階。root担当が公開済みの exact source で次を行う。

```
$N --import tsx services/api/src/opsCli.ts skills import dry-run --operator ryo --pack legacy-minecraft --revision draft-3
$N --import tsx services/api/src/opsCli.ts skills import apply --operator ryo --pack legacy-minecraft --revision draft-3 \
  --plan-hash <reviewed dry-run planHash> --approval-reference <owner approval reference>
```

- dry-run で確かめる: problems が空、capacity（used + added が 25 以下。added は 1）、skill の SHA-256 が manifest と一致。
- `mc-night-retreat` などの既存 skill には触れない（この pack に revises は無い）。
- 利用0・成功0・trial・operator_authored で入る。
