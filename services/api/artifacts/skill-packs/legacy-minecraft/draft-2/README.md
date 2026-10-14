# 旧Minecraft実験から選んだネザー・ブレイズロッドへの試行手順（draft-2）

この pack は Claude Code 開発時代の Minebot 実験から運用側が整理した手順で、シャノンの正本で獲得された成功経験ではない。所有者の承認（2026-10-14、フォーム）に基づく。

- 新設5本: `mc-nether-portal`、`mc-nether-travel`、`mc-blaze-rods`、`mc-low-health`、`mc-food-and-pace`。
- 改訂1本: `mc-night-retreat`。draft-1 の版を、通常の改訂経路で新しい版にする。

既存の owner HTTP import を通すと、新設分は `operator_authored` / trial / 利用0 / 成功0 で入る。改訂分は manifest の `revises.bodySha256` が現在の本文と一致する時だけ、`SkillMemory.revise`（actor `operator_authored`）で第2版になる。上書きはしない。

- 改訂が許されるのは、運用作成のスキルが最初の試しのまま一度も使われていない時に限る。その場合、試しは引き継がれ、失敗すれば退役する。
- active な版の改訂は、通常の試しになる。失敗すれば元の版へ戻る。
- 所有者が編集した版と固定した版は改訂しない。

原典は draft-1 と同じ knowledge snapshot（sha256 60bca0f4…、2,243件）。`selection-report.json` には次を記録した。
- 各グループの原典 id。
- seed と reflection の区別、退役の有無、条件記号、元の票。
- 項目ごとの entry hash（キーを整列したコンパクトJSONのSHA-256）。
- 除外の理由と、身体catalogの照合結果（R41R41/Shannon 4b047cf）。

座標、world固有の設備、復元した所持、raw log は移していない。旧の票・uses・順位は成功の証明として扱わない。要塞の探し方の旧知識は無いため、`mc-nether-travel` の手順6は運用作成の仮説である。

本文の身体操作は `mc.<name>` で、4b047cf の catalog source にある名前と引数名だけを使った。使う時は、FCA がその時に届いた動的 catalog を確認する。

本番導入は、root担当が公開済みの exact source で owner の dry-run を行い、次を確かめてから apply する別の段階。
- 上限（25）、衝突、本文hash、改訂元の本文hash。
- 本番の plan hash。
