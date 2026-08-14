# 設計書: Googleカレンダー変更のSlack通知

## 1. 背景

- 以前は Slack の「Google Calendar for Team Events」アプリで、共有カレンダーの変更をチャンネルに通知できていたが、同アプリは廃止された
- 現行の公式「Google Calendar」Slack アプリは個人向けDM通知（リマインダー・招待応答・予定詳細変更の通知）が中心で、チャンネルへの変更フィードとしては機能しない

## 2. 目的

指定した Google カレンダー上の予定の **追加・更新・削除** を検知し、指定した Slack チャンネルに自動通知する。

## 3. 要件

### 3.1 機能要件

| ID | 要件 |
|---|---|
| F1 | 予定の追加を検知してSlackチャンネルに通知する |
| F2 | 予定の更新（日時・タイトル等の変更）を検知して通知する |
| F3 | 予定の削除（キャンセル）を検知して通知する |
| F4 | 通知先チャンネルを変更可能にする |

### 3.2 非機能要件

| ID | 要件 |
|---|---|
| N1 | 個人のGoogleアカウント・PCで運用を完結できる（外部SaaSに依存しない） |
| N2 | 無料枠内で運用できる |
| N3 | Webhook URL等のシークレットをリポジトリにコミットしない |
| N4 | 通知遅延はポーリング間隔（5〜15分）まで許容する |
| N5 | 取りこぼしが発生した場合も自動復旧できる |

## 4. 方式比較

| 方式 | 検知できる変更 | 速報性 | コスト | 運用 | 結論 |
|---|---|---|---|---|---|
| **GAS + Incoming Webhook** | 追加・更新・削除 | 5〜15分ポーリング | 無料 | Googleアカウント内で完結 | **採用** |
| Zapier / Make | 追加・更新・削除 | 1〜15分 | 量次第で有料 | 外部SaaS依存 | 不採用 |
| 公式 Google Calendar アプリ | 個人DM中心 | リアルタイム | 無料 | 設定のみ | 要件不適合 |
| Calendar API events.watch + 自前サーバ | 追加・更新・削除 | ほぼリアルタイム | サーバ実費 | HTTPS公開・ドメイン検証が必要 | 将来拡張候補 |

## 5. アーキテクチャ

```mermaid
sequenceDiagram
    autonumber
    participant T as 時間主導トリガー<br/>(GAS)
    participant S as GASスクリプト
    participant P as Script Properties<br/>(SYNC_TOKEN)
    participant C as Google Calendar API
    participant W as Slack Incoming Webhook

    T->>S: notifyCalendarChanges() 起動（5分ごと）
    S->>P: syncToken 読み出し
    S->>C: events.list(syncToken, showDeleted=true)
    C-->>S: 差分イベント（削除は status=cancelled）
    C-->>S: nextSyncToken
    S->>S: 追加/更新/削除を判定・メッセージ整形
    S->>W: POST (text)
    S->>P: nextSyncToken を保存
```

- **GAS**: スクリプト本体。時間主導トリガーで定期実行
- **Script Properties**: 差分同期用 `syncToken` を永続化
- **Calendar API（Advanced Service）**: `Calendar.Events.list` で差分取得
- **Slack Incoming Webhook**: チャンネルへの投稿口

## 6. コンポーネント設計

| 関数 | 責務 |
|---|---|
| `getConfig_()` | Script Properties から設定値を読み出す。`CALENDAR_ID` はカンマ区切りで複数受け付ける |
| `initialize()` | 初回のみ手動実行。全カレンダーをフル同期して `syncToken` を保存（通知は出さない） |
| `notifyCalendarChanges()` | 定期実行。スクリプトロックを取り、カレンダーごとに差分処理する |
| `notifyOneCalendar_()` | 1カレンダー分の差分取得→判定→Slack投稿→`syncToken` 更新。戻り値は投稿失敗件数 |
| `migrateLegacySyncToken_()` | 単一カレンダー時代の `SYNC_TOKEN` を `SYNC_TOKEN:<カレンダーID>` へ移す |
| `fetchInitialSyncToken_()` | 現時点を基点にフル同期して `nextSyncToken` を返す |
| `isSyncTokenExpired_(e)` | 例外が `syncToken` 失効（410）由来かを判定 |
| `formatMessage_(calendarId, ev)` | イベント状態から通知種別（追加/更新/削除）と本文を整形 |
| `resolveTitle_(calendarId, ev)` | タイトルを解決。削除イベントで `summary` が無ければ親の繰り返し予定から補う |
| `formatWhen_(ev)` | 日時表示を整形。繰り返しシリーズか個別occurrenceかを注記する |
| `isPastOccurrence_(ev)` | 繰り返し予定の「過ぎた回」かを判定。通知対象から落とすために使う |
| `isUnchangedResend_(ev, fingerprints)` | 前回見たときと中身が変わっていないイベントかを判定。通知対象から落とすために使う |
| `eventFingerprint_(ev)` | イベントの中身の指紋（MD5の先頭8バイト）を返す |
| `canonicalize_(value)` | 指紋を取るための正規化。キーをソートし、`FINGERPRINT_IGNORED_FIELDS` を落とす |
| `readSeenEvents_()` / `writeSeenEvents_()` / `toFingerprintMap_()` | `SEEN_EVENTS:<カレンダーID>` の読み書きと引き当て |
| `toCalendarDate_(value)` | スクリプトのタイムゾーンで `yyyy-MM-dd` を返す |
| `postToSlack_(webhookUrl, text)` | Incoming Webhook へ POST。429と5xxは再試行し、成否を返す |

### 繰り返し予定の扱い（`singleEvents: false`）

`events.list` は `singleEvents: false` で呼ぶ。`true` にすると終了日なしの繰り返し予定が将来方向の全インスタンスへ展開され、シリーズを1回変更しただけで数百件の差分が返る（2026-08-08 に実測: 単一シリーズの変更で 2034〜2087年 の全インスタンスが差分に乗り、数百件のSlack投稿が発生した）。

`false` にすることで:

- 繰り返し予定の変更はシリーズ1件の差分になる
- `ev.start` は初回occurrenceの日時になるため、`ev.recurrence` があれば「〜から（繰り返し予定）」と注記する
- 個別occurrenceの変更・削除は `recurringEventId` と `originalStartTime` を持つ別アイテムとして返るため、その回の日時を表示する

なお `syncToken` は取得時のクエリパラメータと紐づくため、`singleEvents` を変更したら `initialize()` をやり直す必要がある。

### 過ぎた回の除外

繰り返しシリーズを1回編集すると、そのシリーズに紐づく**過去の例外インスタンス**（過去に個別変更・削除した回）まで差分として返る。`initialize()` の `timeMin` はフル同期の範囲を絞るだけで、例外インスタンスには効かない（2026-08-08 に実測: 常用の繰り返し予定を数件編集しただけで、数か月前の回の削除通知が48件発生した）。

そこで `isPastOccurrence_()` で以下を通知対象から落とす。

- `recurringEventId` を持つ（＝シリーズ本体ではなく個別の回）
- かつ `originalStartTime`（無ければ `start`）の**日付**が今日より前

判定を日付単位にしているのは、今日の回を残すため。「今夜のごはんを1件だけ削除」は通知される。シリーズ本体は開始日が過去でも除外しない — 「その繰り返し予定を変更した」こと自体は知りたいため。

除外は通知件数の上限判定より前に行う。過去回だけで上限を超えてサーキットブレーカーが誤作動するのを避ける。

### 巻き添えの再送の除外

繰り返し予定を1回分だけ削除しても、差分にはその回だけが乗るとは限らない。シリーズ本体や、以前に個別変更・削除した**未来の**回まで一緒に返ってくる（2026-08-14 に実測: 9/2 の1回を削除しただけで、シリーズ本体2件・別の回の削除2件を巻き添えに計5件のSlack通知が飛んだ）。「過ぎた回の除外」は日付が今日より前の回しか落とさないので、未来の回の巻き添えはそのまま通知になっていた。

そこで、差分で見たイベントの**指紋**（中身のハッシュ）を `SEEN_EVENTS:<カレンダーID>` に残しておき、`isUnchangedResend_()` で「前回見たときと指紋が同じ」＝中身が1バイトも変わっていないイベントを落とす。

| 判断 | 理由 |
|---|---|
| `updated` の新しさでは判定しない | `updated` は main event data の最終更新時刻で、[公式リファレンス](https://developers.google.com/workspace/calendar/api/v3/reference/events)いわく**リマインダーを変更しても進まない**。「`updated` が古い」は「変わっていない」の証明にならず、リマインダーだけを変えた正当な変更を握りつぶす |
| 指紋が無い初見のイベントは落とさない | 変わっていないと確認できていないため。巻き添えの回も一度は通知され、そこで指紋が残るので次の巻き添えからは黙る。最悪でも従来どおりの通知量に戻るだけで、通知が消えることはない |
| 無視するフィールドは列挙し、それ以外は未知のものも含めて指紋に入れる | 逆（対象を列挙する）にすると、リストから漏れたフィールドの変更を黙って捨ててしまう。無視するのは `etag`・`kind`・`htmlLink` の3つだけ（中身が同じでも変わりうる／通知に関係しない） |
| 指紋は保存量に上限を設け、古いものから捨てる | Script Properties は1プロパティ 9KB。溢れた分は「初見扱い」に戻るだけで、通知が消える方向には倒れない |
| 記録するのは通知したものだけでなく、差分で見たすべて | 「過ぎた回」として落とした分こそ再送の常連なので、記録しないと毎回すり抜ける |

この方式は判定に時刻を使わないため、トリガーの間隔・実行の遅れ・時計のずれのいずれにも影響されない。繰り返し予定の回を続けて何件も消すような、同じイベントが短時間に何度も差分へ乗る操作でも二重通知にならない。

なお、シリーズ本体そのものを変更した場合は本体の指紋が変わるので、従来どおり「✏️ 予定が更新されました」が1件飛ぶ。

### 通知件数の上限

1カレンダー・1実行あたりに個別通知する件数を `MAX_NOTIFICATIONS_PER_RUN`（既定 20件）に制限する。超えた場合は件数のみを1件通知して打ち切る。`singleEvents: false` で大量発生の主因は取り除いているが、想定外の一括変更に対するサーキットブレーカーとして残す。`syncToken` は投稿前に更新済みのため、抑止した差分が次回以降に再度通知されることはない。

上限をカレンダー単位にしているのは、あるカレンダーの暴走が他のカレンダーの正常な通知を巻き添えにしないため。監視対象がN件なら最悪 N件 の警告が出る。

### テスト

`test/` に `node --test` の回帰テストを置く（`npm run check` から実行され、CIで走る）。GASのグローバル（`PropertiesService`・`Calendar`・`UrlFetchApp`・`Utilities` など）を差し替えて `src/Code.js` をそのまま評価する薄いハーネス（`test/gas-harness.mjs`）を通し、カレンダーの応答を与えてSlackに何が投稿されるかを確かめる。スクリプト プロパティは実行間で持ち回せるので、「1回目で指紋を残し、2回目の再送で黙る」といった複数回にまたがる挙動も書ける。

### 多重実行の排他

`notifyCalendarChanges()` は `LockService.getScriptLock()` を `tryLock(0)`（待たない）で取得する。前回の実行が続いている間に次のトリガーが起動した場合は、待たずにスキップしてログに残す。差分は次回の実行で拾えるため取りこぼしにはならない。

### 複数カレンダー

`CALENDAR_ID` にカンマ区切りで複数指定できる。`syncToken` はカレンダーごとに `SYNC_TOKEN:<カレンダーID>` へ保存する。監視対象が2件以上のときだけ、通知本文の末尾に `カレンダー: <名前>` を添える（名前は `events.list` レスポンスの `summary` から取得するので追加のAPI呼び出しは不要）。

単一カレンダー時代の `SYNC_TOKEN` キーは `migrateLegacySyncToken_()` が初回実行時に移行する。

### 追加/更新/削除の判定ロジック

- `ev.status === 'cancelled'` → **削除**
- `updated - created < 60秒` → **追加**
- 上記以外 → **更新**

### 設定値

すべて Script Properties に保存し、コードには一切書かない（tasks.md T12 を初期実装に前倒し）。

| キー | 内容 | 設定者 |
|---|---|---|
| `CALENDAR_ID` | 監視対象カレンダーのID（カレンダー設定 →「カレンダーの統合」で確認）。カンマ区切りで複数指定できる | 手動 |
| `SLACK_WEBHOOK_URL` | Slack Incoming Webhook の URL | 手動 |
| `SYNC_TOKEN:<カレンダーID>` | 差分同期用トークン。カレンダーごとに1件 | `initialize()` が自動保存 |
| `SEEN_EVENTS:<カレンダーID>` | 直近に見たイベントの指紋 `[[イベントID, 指紋], ...]`。巻き添えの再送を落とすのに使うキャッシュ | 定期実行が自動保存 |

## 7. 状態管理・障害対応

- `syncToken` は Script Properties の `SYNC_TOKEN` キーに保存
- `syncToken` 失効（410 Gone）時は例外を捕捉して `initialize()` で再初期化（N5）
  - 再初期化時点までの差分は取りこぼす可能性があるが、通知用途として許容
  - 410 以外の例外（一時的な 5xx・クォータ超過など）では **再初期化しない**。`syncToken` を温存したまま再スローし、次回トリガーで同じ差分を取り直す
- Slack 投稿は 429 と 5xx（および fetch 自体の失敗）を最大3回まで再試行する。4xx は再送しても直らないため即座に諦める
- `UrlFetchApp.fetch` は `followRedirects: false` で呼ぶ。無効な Webhook URL に対して Slack は 302 を返すため、既定（リダイレクトを追う）のままだと最終的な着地先のステータス次第で「URLが壊れている」ことを成功と誤認しうる
- それでも失敗した通知は取りこぼしになる（`syncToken` は投稿前に進んでいるため）。1回の実行で1件でも失敗したら例外を投げ、GAS の失敗通知メールで気づけるようにする
- OAuth承認切れやトリガー失敗はGASの失敗通知メールで検知

## 8. セキュリティ

- リポジトリは public。シークレット（Webhook URL）と個人情報（カレンダーID）は、コード・ドキュメント・コミット履歴のいずれにも書かない
- 設定値はすべて GAS の Script Properties に置く（§6 設定値）。`.clasp.json`（スクリプトID）と `.clasprc.json`（clasp認証情報）は `.gitignore` 済み

## 9. 将来拡張

- Block Kit によるリッチな通知・担当者メンション
- `events.watch` + Cloud Run / Cloud Functions によるリアルタイム化
- 週次ダイジェスト通知

※ 複数カレンダー対応（カレンダーIDごとに SYNC_TOKEN を管理）は §6 で実装済み。
