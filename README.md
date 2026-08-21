# gcal-slack-notifier

Googleカレンダーの予定変更（追加・更新・削除）を検知し、指定したSlackチャンネルに通知するツール。

Slackの「Google Calendar for Team Events」アプリ廃止に伴い、カレンダー変更のチャンネル通知ができなくなったため、Google Apps Script (GAS) + Slack Incoming Webhook で自前実装する。

## ドキュメント

- [docs/design.md](docs/design.md) — 要件定義・方式比較・アーキテクチャ・コンポーネント設計
- [docs/tasks.md](docs/tasks.md) — 依存関係を考慮したタスク分解

## ディレクトリ構成

```
plugin.json          Agent Plugins マニフェスト（リポジトリ全体が1つのプラグイン）
src/
  Code.js            GASスクリプト本体
  appsscript.json    マニフェスト（Calendar Advanced Service を宣言済み）
docs/
  design.md          設計書
  tasks.md           タスク分解
test/
  notify.test.mjs    通知ロジックの回帰テスト（node --test）
  gas-harness.mjs    GASのグローバルを差し替えて src/Code.js を動かすハーネス
scripts/
  delete-slack-messages.mjs  通知の一括削除（運用ツール）
  check-skill-sync.mjs       skills/ と .claude/skills/ の同期チェック
skills/setup/        AIエージェント用セットアップSkill（正本、Agent Skills 形式）
.claude/skills/setup/        ↑のコピー（Claude Code 用。npm run check で同期を検証）
.clasp.json.example  clasp設定のひな形（.clasp.json はgitignore）
```

## セットアップ（AIエージェントに任せる場合）

このリポジトリはセットアップSkillを同梱しており、[Agent Plugins 1.0.0](https://agent-plugins.org)（Vercel らが策定したベンダー中立のプラグイン標準）に準拠している。リポジトリルートがプラグインルートで、`plugin.json` + `skills/setup/SKILL.md`（[Agent Skills](https://agentskills.io) 形式）という構成。Agent Plugins 対応クライアント（Cursor、GitHub Copilot、Codex、Kiro、VS Code など）は、このリポジトリをプラグインとして読み込むと `setup` Skill を利用できる。

[Claude Code](https://claude.com/claude-code) は Agent Plugins 未対応のため、同じ SKILL.md のコピーを `.claude/skills/setup/` に置いてある（プロジェクトSkillとして自動認識される）。リポジトリをcloneして Claude Code で

```
/setup
```

と入力する（または「セットアップして」と依頼する）と、GASプロジェクト作成〜動作確認までエージェントが案内・実行する。Webhook URL などのシークレットはエージェントを経由せず、GASエディタで直接入力する設計になっている。

2つの SKILL.md の正本は `skills/setup/SKILL.md`。編集したら `.claude/skills/setup/SKILL.md` にコピーする（乖離すると `npm run check` が失敗する）。

## セットアップ（手動）

### 1. Slack Incoming Webhook を発行

Slack App を作成 → Incoming Webhooks を有効化 → 通知先チャンネルを指定して Webhook URL を取得する。

### 2. カレンダーIDを控える

Googleカレンダーの設定 →「カレンダーの統合」→ カレンダーID。

### 3. GASプロジェクトを作成してソースを配置

Node.js 20以上が必要（@google/clasp の要件）。

```bash
npm install
npm run login
npx clasp create-script --title gcal-slack-notifier --type standalone --rootDir src
npm run push
```

すでにGASプロジェクトがある場合は `.clasp.json.example` をコピーして `.clasp.json` を作り、`scriptId` を書き換えてから `npm run push` する。

Webエディタに手貼りしてもよい。その場合は `src/Code.js` と `src/appsscript.json`（マニフェストの表示を有効にする）の両方を反映すること。

### 4. スクリプト プロパティを設定

GASエディタの「プロジェクトの設定」→「スクリプト プロパティ」で以下を登録する。

| キー | 値 |
|---|---|
| `CALENDAR_ID` | 手順2のカレンダーID。複数監視する場合はカンマ区切り（例: `a@group.calendar.google.com,b@group.calendar.google.com`） |
| `SLACK_WEBHOOK_URL` | 手順1のWebhook URL |

`SYNC_TOKEN:<カレンダーID>`・`SEEN_EVENTS:<カレンダーID>`・`FINGERPRINTS_PRIMED_AT:<カレンダーID>`・`LAST_RUN_AT:<カレンダーID>` はスクリプトが自動で保存するため手動設定は不要。

監視対象が2件以上のときは、通知の末尾にどのカレンダーの変更かが添えられる。

### 5. 初期化

`initialize()` を一度実行してOAuth承認を済ませる。`SYNC_TOKEN:<カレンダーID>` が保存されれば成功（この時点では通知は出ない）。

`CALENDAR_ID` にカレンダーを追加した場合、追加分は次回の定期実行が自動で基準点を作る（`initialize()` の再実行は不要）。

繰り返し予定の巻き添え通知を抑止するための指紋（下敷き）は、**定期実行が最初の1回で自動的に作る**ので手作業は要らない。`FINGERPRINTS_PRIMED_AT:<カレンダーID>` がその目印。

トリガーを待たずに作りたいときや、`SEEN_EVENTS` を消してやり直したいときは `primeFingerprints()` を手動実行する。`syncToken` を進めず、まだ通知していない差分に含まれる予定は記録しない（その変更は次の定期実行が通知する）。定期実行と同じロックを取るので、走っている間に叩くとエラーで中止する。カレンダーAPIから差分を取れなかった場合も、指紋を書かずにエラーになる（通知を消すより止まるほうを選ぶ）。

### 6. トリガー設定

`notifyCalendarChanges()` に時間主導トリガー（例: 5分ごと）を設定する。

## 開発

```bash
npm run check   # 構文チェック（node --check + マニフェストのJSONパース）+ テスト
npm test        # テストのみ（node --test）
npm run push    # GASへデプロイ
npm run pull    # GAS側の変更を取り込む
```

## デプロイ（GitHub Actions）

`.github/workflows/deploy.yml` が、**手動実行**（Actions タブの Run workflow）と **main への push**（PR マージ）で `clasp push` を実行する。`src/**` を変更していないマージではデプロイしない（手動実行なら常に走る）。デプロイ前に `npm run check` が通ることを確認し、失敗したら push しない。

このリポジトリは public で、フォークして各自のGASプロジェクトへ配信する使い方を想定しているため、次の方針を採っている。

- **`pull_request` では動かさない。** 誰でもPRを出せるため、PRのコードを実行する経路に認証情報を渡すとトークンを盗まれる。デプロイの起点は main への push と手動実行だけにしている
- **未設定のフォークではジョブごとスキップする。** 変数 `CLASP_SCRIPT_ID` が空ならジョブが起動しないので、設定していない人のActionsが赤くならない
- **scriptIdは各自のもの。** `.clasp.json` はコミットせず、CI実行時に変数から生成する

### 有効化の手順

自分のリポジトリ（フォーク含む）で有効にするには、ローカルで `npm run login` と `.clasp.json` の用意を済ませたうえで、以下を設定する。

```bash
gh secret set CLASP_CREDENTIALS < ~/.clasprc.json
gh variable set CLASP_SCRIPT_ID --body "$(node -p "require('./.clasp.json').scriptId")"
```

| 名前 | 種別 | 中身 |
|---|---|---|
| `CLASP_CREDENTIALS` | シークレット | `~/.clasprc.json` の中身（GoogleのOAuthリフレッシュトークン） |
| `CLASP_SCRIPT_ID` | 変数 | GASプロジェクトのスクリプトID |

### 実行できる人を絞る

手動実行（Run workflow）には**リポジトリへのwrite権限が必要**なので、閲覧者が勝手にデプロイすることはできない。ただし `workflow_dispatch` は実行するブランチを選べるため、write権限を持つ人はmain以外のブランチの `src/` を本番へ送れてしまう。

これを塞ぐため、`deploy` ジョブは `environment: gas` を参照している。Settings → Environments で `gas` に保護ルールを設定する。

| 設定 | 効果 |
|---|---|
| Deployment branches | `main` のみに制限し、別ブランチからの手動実行を止める |
| Required reviewers | 手動実行・マージの両方で、デプロイ前に承認を挟む |
| Environment secrets | `CLASP_CREDENTIALS` をここに置くと、このEnvironmentを使うジョブ以外から読めなくなる |

Environmentは参照された時点で自動作成されるため、未設定のフォークでもワークフローは壊れない（その場合は保護なしで動く）。Environmentの保護ルールはpublicリポジトリならFreeプランでも使える。

ワークフローに `if: github.actor == '...'` を書く方法もあるが、write権限があればワークフロー自体を書き換えられるので、権限の境界としては機能しない。

### 注意

- ワークフローは `clasp push --force` を使う。CIのように端末を持たない環境では、`appsscript.json` に差分があると clasp が確認を取れず「Skipping push.」と表示して**終了コード0のまま何もデプロイしない**ため。副作用として、**GASエディタ側で `appsscript.json` を編集していると上書きされる**。マニフェストはこのリポジトリを正とする
- 認証は `clasp login` で作られるリフレッシュトークンをそのまま使う。サービスアカウント（`--adc`）は clasp 側が「EXPERIMENTAL/NOT WORKING」と明記しているので使わない
- 自前のOAuthクライアント（`clasp login --creds`）で作ったトークンを使う場合、OAuth同意画面が「テスト」のままだとリフレッシュトークンが7日で失効し、1週間後に突然CIが落ちる。素の `clasp login` なら起きない
- 時間主導トリガーはヘッドのコードを実行するため、`clasp push` だけで反映される（バージョン付きデプロイの作成は不要）
- スクリプト プロパティ（Webhook URL・カレンダーID）はデプロイ対象外。GASエディタ側の設定はpushで消えない

## 注意

- Webhook URL とカレンダーIDはコードに書かず、スクリプト プロパティに置く
- `.clasp.json`（スクリプトID）と `.clasprc.json`（clasp認証情報）はコミットしない（`.gitignore` 済み）

## ライセンス

[MIT](LICENSE)
