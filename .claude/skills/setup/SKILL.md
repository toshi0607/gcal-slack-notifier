---
name: setup
description: gcal-slack-notifier のセットアップを進める。GASプロジェクト作成・clasp push を自動化し、Slack Webhook 発行・Script Properties 設定・OAuth承認・トリガー設定を案内する。ユーザーが「セットアップして」「導入したい」「使い始めたい」と言ったときに使う。
---

# gcal-slack-notifier セットアップ

Googleカレンダーの予定変更（追加・更新・削除）を指定のSlackチャンネルに通知するGASスクリプトを、ユーザーの環境に導入する。

## 大原則: シークレットの扱い

- **Slack Webhook URL とカレンダーIDを、チャットに貼らせない・コードやファイルに書かせない・シェル履歴に残さない。**
- これらは必ずユーザー自身が GAS エディタの「スクリプト プロパティ」画面に直接入力する。エージェントは入力欄までの道案内だけを行う。
- ユーザーがチャットに Webhook URL を貼ってきた場合は、受け取らずに Script Properties へ直接入力するよう案内し、貼られた URL は無効化（Slack側で再発行）を勧める。

## 役割分担

| 工程 | 担当 |
|---|---|
| 依存インストール・GASプロジェクト作成・ソース push | エージェント（自動） |
| Google/Slack へのログイン・OAuth承認 | ユーザー（ブラウザ） |
| Webhook URL・カレンダーIDの入力 | ユーザー（GASエディタ） |
| initialize() 実行・トリガー設定 | ユーザー（GASエディタ。手順は下記を提示） |

## 手順

### 1. 前提確認（エージェント）

```bash
node --version   # v18以上
npm install
npm run check    # 構文チェックが通ること
```

### 2. clasp ログインと Apps Script API 有効化

1. エージェントが `npm run login` を実行する（ブラウザが開くので、ユーザーが対象のGoogleアカウントで承認する）
2. ユーザーに https://script.google.com/home/usersettings を開いてもらい、「Google Apps Script API」をオンにする（既にオンなら何もしない）

### 3. GASプロジェクト作成と push（エージェント）

新規プロジェクトの場合:

```bash
npx clasp create-script --title gcal-slack-notifier --type standalone --rootDir src
npm run push
```

- `clasp create-script` がリポジトリ直下に `.clasp.json` を生成する（gitignore 済み）
- ローカルの `src/appsscript.json` を上書きするか確認された場合は**ローカルを維持**する（Calendar Advanced Service とスコープの宣言が消えるため）。上書きされてしまった場合は `git checkout -- src/appsscript.json` で戻してから push し直す
- 既存のGASプロジェクトに入れる場合は `.clasp.json.example` をコピーして `.clasp.json` を作り、`scriptId` を書き換えてから `npm run push`

push 後、`npm run open` でGASエディタを開き、`Code.js` と `appsscript.json` が反映されていることを確認する。

### 4. Slack Incoming Webhook 発行（ユーザー）

以下を案内する:

1. https://api.slack.com/apps → **Create New App** → **From scratch** → アプリ名（例: gcal-notifier）と通知先ワークスペースを選択
2. **Incoming Webhooks** → **Activate Incoming Webhooks** をオン
3. **Add New Webhook to Workspace** → 通知先チャンネルを選んで **Allow**
4. 表示された Webhook URL（`https://hooks.slack.com/services/...`）を控える — **チャットには貼らない**

### 5. カレンダーIDの確認（ユーザー）

Googleカレンダー（Web版）→ 対象カレンダーの「設定と共有」→「カレンダーの統合」→ **カレンダーID**（`xxx@group.calendar.google.com` 形式。自分のメインカレンダーならGmailアドレス）。

他人のカレンダーを監視する場合は、そのカレンダーが自分のアカウントに共有されている（「予定の表示」以上）ことを確認する。

### 6. Script Properties 設定（ユーザー）

GASエディタ（`npm run open` で開ける）→ 左メニュー「プロジェクトの設定」⚙ → 「スクリプト プロパティ」→ 以下を追加:

| キー | 値 |
|---|---|
| `CALENDAR_ID` | 手順5のカレンダーID。複数はカンマ区切り |
| `SLACK_WEBHOOK_URL` | 手順4のWebhook URL |

`SYNC_TOKEN:...` は自動生成されるため設定不要。

### 7. 初期化とOAuth承認（ユーザー）

GASエディタ上部の関数選択で `initialize` を選び **実行**。初回は承認ダイアログが出るので、対象アカウントで許可する（カレンダー読み取りと外部リクエストの2スコープ）。

実行ログに「初期化完了」が出て、スクリプト プロパティに `SYNC_TOKEN:<カレンダーID>` が保存されれば成功。この時点で通知は飛ばない。

### 8. トリガー設定（ユーザー）

GASエディタ左メニュー「トリガー」⏰ → **トリガーを追加**:

- 実行する関数: `notifyCalendarChanges`
- イベントのソース: **時間主導型**
- 時間ベースのタイマー: **分ベース** → **5分おき**（好みで5〜15分）

### 9. 動作確認

1. 対象カレンダーにテスト予定を追加する
2. 5分待つか、GASエディタで `notifyCalendarChanges` を手動実行する
3. Slackチャンネルに「🆕 予定が追加されました」が届けば完了
4. 予定の更新・削除も同様に通知されることを確認する（任意）

## トラブルシューティング

- **「スクリプト プロパティが未設定です」**: 手順6のキー名のタイプミスを疑う（`CALENDAR_ID` / `SLACK_WEBHOOK_URL` 完全一致）
- **`Calendar is not defined`**: `src/appsscript.json` が反映されていない。マニフェストを push し直すか、エディタの「プロジェクトの設定」で「appsscript.json マニフェストをエディタで表示する」を有効にして内容を確認する
- **通知が来ない**: GASエディタの「実行数」でエラーを確認。`nextSyncToken を取得できませんでした` はカレンダーIDの誤りか共有権限不足
- **通知が大量に来た**: `scripts/delete-slack-messages.mjs`（dry-run既定）で片付けられる。ヘッダのコメント参照
