# gcal-slack-notifier

Googleカレンダーの予定変更（追加・更新・削除）を検知し、指定したSlackチャンネルに通知するツール。

Slackの「Google Calendar for Team Events」アプリ廃止に伴い、カレンダー変更のチャンネル通知ができなくなったため、Google Apps Script (GAS) + Slack Incoming Webhook で自前実装する。

## ドキュメント

- [docs/design.md](docs/design.md) — 要件定義・方式比較・アーキテクチャ・コンポーネント設計
- [docs/tasks.md](docs/tasks.md) — 依存関係を考慮したタスク分解

## ディレクトリ構成

```
src/
  Code.js            GASスクリプト本体
  appsscript.json    マニフェスト（Calendar Advanced Service を宣言済み）
docs/
  design.md          設計書
  tasks.md           タスク分解
scripts/
  delete-slack-messages.mjs  通知の一括削除（運用ツール）
.claude/skills/setup/        AIエージェント用セットアップSkill
.clasp.json.example  clasp設定のひな形（.clasp.json はgitignore）
```

## セットアップ（AIエージェントに任せる場合）

このリポジトリには [Claude Code](https://claude.com/claude-code) 用のセットアップSkillが同梱されている。リポジトリをcloneして Claude Code で

```
/setup
```

と入力する（または「セットアップして」と依頼する）と、GASプロジェクト作成〜動作確認までエージェントが案内・実行する。Webhook URL などのシークレットはエージェントを経由せず、GASエディタで直接入力する設計になっている。

## セットアップ（手動）

### 1. Slack Incoming Webhook を発行

Slack App を作成 → Incoming Webhooks を有効化 → 通知先チャンネルを指定して Webhook URL を取得する。

### 2. カレンダーIDを控える

Googleカレンダーの設定 →「カレンダーの統合」→ カレンダーID。

### 3. GASプロジェクトを作成してソースを配置

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

`SYNC_TOKEN:<カレンダーID>` は `initialize()` が自動で保存するため手動設定は不要。

監視対象が2件以上のときは、通知の末尾にどのカレンダーの変更かが添えられる。

### 5. 初期化

`initialize()` を一度実行してOAuth承認を済ませる。`SYNC_TOKEN:<カレンダーID>` が保存されれば成功（この時点では通知は出ない）。

`CALENDAR_ID` にカレンダーを追加した場合、追加分は次回の定期実行が自動で基準点を作る（`initialize()` の再実行は不要）。

### 6. トリガー設定

`notifyCalendarChanges()` に時間主導トリガー（例: 5分ごと）を設定する。

## 開発

```bash
npm run check   # 構文チェック（node --check + マニフェストのJSONパース）
npm run push    # GASへデプロイ
npm run pull    # GAS側の変更を取り込む
```

## 注意

- Webhook URL とカレンダーIDはコードに書かず、スクリプト プロパティに置く
- `.clasp.json`（スクリプトID）と `.clasprc.json`（clasp認証情報）はコミットしない（`.gitignore` 済み）

## ライセンス

[MIT](LICENSE)
