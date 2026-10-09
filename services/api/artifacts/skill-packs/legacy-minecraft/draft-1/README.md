# 旧Minecraft実験から選んだ４つの試行手順

この pack は Claude Code 開発時代の実験から運用側が整理した手順で、シャノンの正本で獲得された成功経験ではない。既存の owner HTTP import を通すと `operator_authored` / trial / 利用0 / 成功0になる。成果や能力、権限の自動獲得を意味しない。

2243件中、廃止済み2043件を除外し、残る200件から５つの条件付き原典を４つに整理した。採用内容は序盤の道具連鎖、夜間の退避、設備・装備の復旧、精錬の観測。重複した助言、座標・旧ワールドの設備、grant/復元、古い目標管理・修正済み道具不具合、未確認のNether・ドラゴン戦術は移さない。

`selection-report.json` は knowledge snapshot・５原典・３本の実experience JSONL・７ native実装のhash、条件、反例run ID、限定した実観測を持つ。JSONL本体、座標、人の識別情報、メッセージ、private world files は VM 内に残る。保持された run の支持票は最大64件で、累計票と一致しない場合がある。票、旧 uses、節目の観測は、この手順が原因で成功したことや戦術の成功率を証明しない。

manifestの `referenceRevision` は原典knowledge snapshotのSHA-256で、Git commitではない。`sourceReference` は同snapshotの非公開データを含まない識別子と選定reportのSHA-256を結び、import provenanceに残る。本文の４つのSHA-256はmanifestで固定される。

特に旧 `waiting_external` / `earlier_action_failed` は当時の非同期・受付の意味や実装制約を含む。現在も同じ回数だけ操作が失敗するとは解釈しない。反例runの全件再読は行っておらず、３本の実ログを安全な集計で確認した範囲に限る。L100単独の固定snapshotではなく、複数runを含む旧実験知見のsnapshotである。Nether到達・ブレイズロッド・エンドラ討伐の成功実績はこのpackに付与しない。

native の名前・引数は現行body sourceの実装と照合した。FCAはその時に届いた動的catalogの名前/schemaを使い、最新の元操作の結果と観測を確認する。静的 import の conditional tool は既存許可内の `minecraft.observe` のみ。native catalogがない時は、その不足を伝える。live catalogの利用可能性や４手順の実ワールド再試行は未検証。

`verify-local.ts` は正規registry/import検査、４件それぞれの実FCA `skill.read`、revision source・運用出自・忘却による撤回、成功/利用0、７ native parameter projection の型/不足/余剰引数を無課金で確認する。fixture plan hashは本番applyに使用できない。

```sh
node node_modules/tsx/dist/cli.mjs services/api/artifacts/skill-packs/legacy-minecraft/draft-1/verify-local.ts
```

本番導入は root 担当が公開済みの exact source で owner CLI dry-run を行い、capacity・衝突・本文hash・本番plan hashを確認して apply する別の段階。実DBへの直接投入や旧成功カウンタの転用はしない。
