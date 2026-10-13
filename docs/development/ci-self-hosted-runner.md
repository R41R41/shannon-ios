# CI のセルフホストランナー（Windows PC の WSL2 Ubuntu）

`.github/workflows/api-tests.yml`（サーバーの全テスト）は、オーナーの Windows PC 上の WSL2 Ubuntu 24.04 で動く
GitHub Actions のセルフホストランナーで実行する。

- 理由: リポジトリは private で、アカウントの Actions 予算が $0（「Usage blocked」）のため、GitHub のホストランナーの
  分数が使えない。セルフホストランナーは無料。
- ランナーのラベル: `self-hosted, linux, x64, shannon-wsl`（ワークフローの `runs-on` と一致させる）。
- ランナーは 1 台。1 回の実行は 1 ジョブ（typecheck → `verify.sh fast` → vitest 全件）で、インストールは 1 回だけ。
- PC が電源オフ・スリープ中は実行が待ち行列に残る。24 時間以内に PC が起きれば走り、それを超えると GitHub が取り消す。

> **登録トークンについて（重要）**: 手順 6 で GitHub の画面に出る `--token` の値は、オーナー本人が WSL の端末に直接
> 貼り付けるだけにする。**チャット（Claude・Codex・シャノンを含む）には絶対に貼らない。** 有効期限は約 1 時間で、
> 切れたら同じ画面を開き直せば新しいものが出る。

---

## 0. 前提

- Windows 11（または Windows 10 22H2 以降）、管理者として PowerShell を開けること。
- メモリ 16 GB 以上を推奨（WSL は既定で Windows のメモリの半分まで使う。vitest 4 並列で数 GB 使う）。
- 空きディスク 15 GB 程度（Ubuntu、Node、pnpm のストア、チェックアウト）。

## 1. WSL2 と Ubuntu 24.04 を入れる

管理者の PowerShell で:

```powershell
wsl --install -d Ubuntu-24.04
```

再起動を求められたら再起動する。初回起動で Linux のユーザー名とパスワードを作る（これが管理用ユーザー。以下
「管理ユーザー」）。すでに WSL を使っている場合は、先に状態を確認する:

```powershell
wsl --update
wsl -l -v      # Ubuntu-24.04 が VERSION 2 で一覧に出ればよい
```

## 2. systemd を有効にする（`/etc/wsl.conf`）

ランナーを systemd のサービスとして動かすため。Ubuntu の端末で:

```bash
sudo tee /etc/wsl.conf >/dev/null <<'EOF'
[boot]
systemd=true

[interop]
# Windows 側の PATH を混ぜない（Windows の node や git を誤って拾わないため）。
appendWindowsPath=false
EOF
```

この Ubuntu を CI 専用にするなら、さらに次を足すと、テストのコードから Windows のファイル（`/mnt/c`）や Windows の
実行ファイルに触れなくなる（安全側。普段この Ubuntu で Windows のファイルを触るなら足さない）:

```ini
[automount]
enabled=false

[interop]
enabled=false
appendWindowsPath=false
```

（`[interop]` は 1 つにまとめて書く。）書いたら PowerShell で WSL を止めて、開き直す:

```powershell
wsl --shutdown
wsl -d Ubuntu-24.04
```

確認（Ubuntu の端末で）:

```bash
systemctl is-system-running   # running か degraded なら OK（offline や エラーなら systemd が効いていない）
findmnt /dev/shm              # FSTYPE が tmpfs、OPTIONS に noexec が無ければ最速の設定で走る
```

### （任意）WSL に渡すメモリと CPU

`C:\Users\<Windowsユーザー>\.wslconfig` を作ると上限を決められる。例（16 GB の PC）:

```ini
[wsl2]
memory=8GB
processors=4
```

変更後は `wsl --shutdown` が必要。

## 3. パッケージを入れる

```bash
sudo apt update
sudo apt install -y git curl ca-certificates tar unzip findutils util-linux dbus-x11
```

- `git`: チェックアウトと、テストの一部（`git init` / `commit` を一時ディレクトリで実行する）が使う。
- `findutils`, `util-linux`（`find`, `findmnt`）: ワークフローの tmpfs 判定と後片付けが使う。
- `dbus-x11`: 手順 8 の「WSL を起こし続ける」設定が使う `dbus-launch` を含む。
- Node.js は入れなくてよい（ワークフローの `actions/setup-node` が 24.20 をランナーのキャッシュに入れる）。
- `build-essential` と `python3` は今は不要: このリポジトリは SQLite を Node 組み込みの `node:sqlite` で使っており、
  ネイティブモジュールのビルドは無い（ビルドを許可しているのは配布済みバイナリを使う `esbuild` だけ）。将来
  `better-sqlite3` などのネイティブモジュールが増えたら `sudo apt install -y build-essential python3` を足す。

## 4. ランナー専用ユーザーを作る

テストのコードを管理ユーザー（sudo できる）で動かさないため、sudo 権限の無い専用ユーザーで動かす:

```bash
sudo adduser --disabled-password --gecos "" ghrunner
```

（GitHub のランナーは root では登録できない。）

## 5. GitHub でランナーを作る画面を開く

ブラウザで `https://github.com/R41R41/shannon-ios` →
**Settings → Actions → Runners → New self-hosted runner** を開き、**Runner image: Linux**、**Architecture: x64** を選ぶ。

画面に「Download」と「Configure」の 2 つのコマンド群が出る。Configure の `./config.sh` の行に
**一度きりの登録トークン**（`--token XXXXXXXX`）が含まれる。

（Settings → Actions → General で Actions が無効になっていたら、「Allow all actions and reusable workflows」などで有効に
しておく。）

## 6. ダウンロードと登録（ランナー専用ユーザーで）

Ubuntu の端末で専用ユーザーに切り替える:

```bash
sudo -iu ghrunner
```

画面の **Download** のコマンドを上から順にそのまま貼って実行する（`mkdir actions-runner && cd actions-runner`、
`curl -o actions-runner-linux-x64-<版>.tar.gz -L ...`、ハッシュ確認、`tar xzf ...`）。ランナーは必ず Linux 側の
ホーム（`/home/ghrunner/actions-runner`）に置く。`/mnt/c` の下には置かない（後述「WSL で注意する点」）。

続けて **Configure** の `./config.sh` の行を貼る。そのとき**行末に** ` --labels shannon-wsl --name shannon-wsl-pc` を足す:

```bash
./config.sh --url https://github.com/R41R41/shannon-ios --token <画面に出ているトークン> --labels shannon-wsl --name shannon-wsl-pc
```

質問が出たら:

- runner group: そのまま Enter（Default）
- runner name: そのまま Enter（`shannon-wsl-pc`）
- additional labels: そのまま Enter（`--labels` で付けた `shannon-wsl` が入る）
- work folder: そのまま Enter（`_work`）

「Settings Saved.」が出たら成功。画面の `./run.sh` は**実行しない**（次の手順でサービスにする）。専用ユーザーを抜ける:

```bash
exit
```

## 7. サービスとして常駐させる（管理ユーザーで）

```bash
sudo bash -c 'cd /home/ghrunner/actions-runner && ./bin/installdependencies.sh'
sudo bash -c 'cd /home/ghrunner/actions-runner && ./svc.sh install ghrunner && ./svc.sh start && ./svc.sh status'
```

- `installdependencies.sh` はランナー本体（.NET）が使うライブラリ（libicu など）を入れる。
- `svc.sh install ghrunner` は systemd のサービス（`actions.runner.R41R41-shannon-ios.shannon-wsl-pc.service`）を
  専用ユーザーで動くように作る。以後 WSL が起動すれば自動で立ち上がる。
- `status` に `active (running)` が出れば OK。

GitHub の Settings → Actions → Runners に `shannon-wsl-pc` が **Idle**（緑）で出る。

ログを見たいとき:

```bash
sudo journalctl -u 'actions.runner.*' -f
```

## 8. WSL を起こし続ける

WSL は、Windows 側で WSL の端末をすべて閉じると、しばらくして Ubuntu ごと止まる（systemd のサービスが動いていても
止まる）。止まるとランナーは GitHub 上で **Offline** になる。

いちばん簡単で確実なのは、**Windows のタスクスケジューラで、ログオン時に `dbus-launch` を 1 回起動する**方法。
`dbus-launch` が常駐プロセスを残すため、Ubuntu が止まらなくなる（`wsl.exe` 自体はすぐ終わるので窓は残らない）。
PowerShell（管理者でなくてよい）で一度だけ:

```powershell
$action  = New-ScheduledTaskAction -Execute "C:\Windows\System32\wsl.exe" -Argument "-d Ubuntu-24.04 --exec dbus-launch true"
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName "WSL keep-alive (Shannon CI)" -Action $action -Trigger $trigger -Settings $settings
Start-ScheduledTask -TaskName "WSL keep-alive (Shannon CI)"
```

GUI で作る場合: タスクスケジューラ →「基本タスクの作成」→ 名前「WSL keep-alive (Shannon CI)」→ トリガー「ログオン時」→
操作「プログラムの開始」、プログラム `C:\Windows\System32\wsl.exe`、引数 `-d Ubuntu-24.04 --exec dbus-launch true`。
作成後にプロパティの「条件」タブで「AC 電源のみ」のチェックを外す。

確かめ方: WSL の端末をすべて閉じて 5 分待ち、PowerShell で `wsl -l -v` を実行して Ubuntu-24.04 が **Running** のまま
であること、GitHub の Runners 画面で `shannon-wsl-pc` が Idle のままであることを見る。

- これで足りないとき（Running が Stopped に変わる）の代わり: 同じタスクの引数を `-d Ubuntu-24.04 --exec sleep infinity`
  にして、「全般」タブの「ユーザーがログオンしているかどうかにかかわらず実行する」を選ぶ（窓が出ない）。
- `.wslconfig` の `vmIdleTimeout` は「Ubuntu が止まった後に WSL の VM を止めるまでの時間」で、Ubuntu 自体が止まるのは
  防げないため、これだけでは足りない。
- Windows がスリープすると WSL も止まる。CI を待たせたくなければ「電源とスリープ」で電源接続時のスリープを「なし」に
  する。スリープさせる運用でも、実行は待ち行列に残り、起きたときに走る（24 時間まで）。
- Windows Update などで再起動したら、ログオンした時点でタスクが走って復帰する。

## 9. 動くことを確かめる

1. Runners 画面で `shannon-wsl-pc` が Idle であること。
2. Actions タブ → 左の **API tests** → ブランチ `ci-self-hosted-runner` の最新の実行を開き **Re-run all jobs**。
   実行が無ければ **Run workflow** でブランチ `ci-self-hosted-runner` を選んで実行する。
   （`main` は、このブランチがマージされるまで旧設定〔GitHub のホストランナー〕のままなので、そちらは止まったまま。）
3. ジョブ「typecheck, fast lane and vitest」のログの冒頭に `Runner name: 'shannon-wsl-pc'` が出て、vitest の手前に
   `TMPDIR=/dev/shm/shannon-vitest-… (tmpfs), workers=4, …` の行が出れば、PC で走っている。
4. 初回は Node のダウンロードと pnpm のストア作成で数分余計にかかる。2 回目以降は速い。
5. 実行が「Waiting for a runner to pick up this job…」のまま進まないときは、Runners 画面でランナーが Offline に
   なっていないか（手順 8）、ラベルに `shannon-wsl` が付いているかを見る。ジョブが課金（billing）を理由に始まらない
   と出る場合は、予算ではなく支払いの問題で、セルフホストランナーでも動かない。Settings → Billing を確認する。

### 並列数を変える

既定は vitest 4 ワーカー。リポジトリの **Settings → Secrets and variables → Actions → Variables → New repository
variable** で `SHANNON_CI_MAX_WORKERS` を作ると、コミットなしで変えられる（例: メモリが少なければ `2`、CPU とメモリに
余裕があれば `6`）。数字以外を入れると 4 に戻って警告が出る。

## 10. 安全について

- 対象は **private リポジトリ `R41R41/shannon-ios` だけ**。ワークフローの起動条件は `push` と手動実行だけで、
  フォークからのプルリクエストでは動かない。リポジトリにプッシュできる人（オーナーと、オーナーが動かすエージェント）の
  コードだけが走る。
- 走るのはリポジトリ自身のテスト（型検査、検査スクリプト、vitest）。ワークフローは `contents: read` の権限しか持たず、
  **本番の秘密（API キー、VM の鍵、`api.env` など）はランナーに一切置かない**。テストは秘密もネットワークも使わない
  （`docs/testing/test-lanes.md`）。
- テストは sudo 権限の無い `ghrunner` ユーザーで動く。手順 2 の任意設定（automount と interop を無効）にすれば、
  Windows のファイルや実行ファイルにも触れない。
- ランナーをやめるとき:
  1. Ubuntu で `sudo bash -c 'cd /home/ghrunner/actions-runner && ./svc.sh stop && ./svc.sh uninstall'`
  2. GitHub の Settings → Actions → Runners → `shannon-wsl-pc` → **Remove**。表示される `./config.sh remove --token …`
     を `sudo -iu ghrunner` で `~/actions-runner` から実行する（このトークンもチャットに貼らない）。PC が手元に無いとき
     は、同じ画面から強制削除できる。
  3. タスクスケジューラの「WSL keep-alive (Shannon CI)」を削除する。

## 11. WSL で注意する点（テストとの相性）

- **チェックアウトは Linux 側のディスク（ext4）に置く。** `/mnt/c` 配下（Windows のディスク）では、ファイルの
  パーミッション（`chmod 0o600` などを確かめるテスト: `selfRewrite*`、`fcaInitialReadSources` など）が保たれず、
  SQLite の WAL も正しく動かない。手順 6 のとおり `/home/ghrunner/actions-runner` に置けば問題ない。
- **`/dev/shm`**: テストの一時ディレクトリは tmpfs の `/dev/shm` に置く（大量の短命な SQLite ファイルの fsync を
  避けるため）。一部のテストは一時ディレクトリに小さな実行ファイルを書いて実行するので、ワークフローは `/dev/shm` で
  実際に実行できるか試し、できなければ `/tmp` を使う。実行後（失敗・取り消し時も）は自分の一時ディレクトリを消し、
  12 時間より古い残りも消す。
- **SQLite**: Node 24 組み込みの `node:sqlite`。ネイティブビルドは不要。
- **タイムゾーン**: WSL は Windows のタイムゾーン（日本時間）を引き継ぐ。ワークフローは、これまで緑だった GitHub の
  ホストランナーと同じ UTC（`TZ=Etc/UTC`）に固定している。
- **開けるファイル数**: systemd のサービスは既定で 1024 個までのことがあるので、vitest の前に 65536 まで上げている。
- **メモリ**: 4 ワーカーで数 GB 使う。WSL のメモリが 8 GB より少ないなら `SHANNON_CI_MAX_WORKERS=2` にする。
- **macOS 専用の部分**: アイコンの見た目検査（CoreGraphics）は Linux では「skipped」と出て通る。`apps/`（Xcode、
  Swift）はこのワークフローの対象外で、Mac と Xcode Cloud のまま。
- **ディスク**: pnpm のストア（`/home/ghrunner/.local/share/pnpm/store`）は実行ごとに再利用され、少しずつ増える。
  気になったら `sudo -iu ghrunner` で `rm -rf ~/.local/share/pnpm/store` してよい（次の実行で作り直す）。
- **スリープ明けの時計**: WSL の時計がずれると時刻を使うテストが揺れることがある。おかしければ `wsl --shutdown`
  して起動し直す。
