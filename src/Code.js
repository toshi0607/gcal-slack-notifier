/***** 設定はスクリプト プロパティに置く（プロジェクトの設定 → スクリプト プロパティ）
 *   CALENDAR_ID          監視対象カレンダーのID。カンマ区切りで複数指定できる
 *   SLACK_WEBHOOK_URL    Slack Incoming Webhook の URL
 *   SYNC_TOKEN:<カレンダーID>   差分同期用トークン（initialize() が自動で保存する。手動設定不要）
 *   LAST_SYNC_AT:<カレンダーID> 前回の差分取得を開始した時刻（同上）
 *****/
const PROP_CALENDAR_ID = 'CALENDAR_ID';
const PROP_SLACK_WEBHOOK_URL = 'SLACK_WEBHOOK_URL';
const PROP_SYNC_TOKEN_PREFIX = 'SYNC_TOKEN:';
const PROP_LAST_SYNC_AT_PREFIX = 'LAST_SYNC_AT:';

// 単一カレンダーのみ対応していた頃のキー。移行のためだけに参照する
const PROP_LEGACY_SYNC_TOKEN = 'SYNC_TOKEN';

// 1カレンダー・1実行あたりに個別通知する上限。超えた場合は件数だけ通知して打ち切る
const MAX_NOTIFICATIONS_PER_RUN = 20;

// 繰り返し予定はシリーズ単位で受け取る。true にすると終了日なしの繰り返し予定が
// 将来方向の全インスタンスへ展開され、シリーズを1回変更しただけで数百件の差分が返る
const SINGLE_EVENTS = false;

// Slack投稿のリトライ回数（429と5xxのみ再試行する）
const SLACK_POST_ATTEMPTS = 3;

// 「前回の実行より後に更新されたか」を判定するときの許容誤差（ミリ秒）。
// updated はカレンダー側が打つ時刻、比較相手はスクリプト側で測った実行開始時刻なので、
// 時計のずれと差分APIへの反映遅れの分だけ緩めに見る（迷ったら通知する側に倒す）
const UPDATED_SKEW_MS = 60 * 1000;

function getConfig_() {
  const props = PropertiesService.getScriptProperties();
  const rawCalendarIds = props.getProperty(PROP_CALENDAR_ID);
  const webhookUrl = props.getProperty(PROP_SLACK_WEBHOOK_URL);
  const missing = [];
  if (!rawCalendarIds) missing.push(PROP_CALENDAR_ID);
  if (!webhookUrl) missing.push(PROP_SLACK_WEBHOOK_URL);
  if (missing.length) {
    throw new Error('スクリプト プロパティが未設定です: ' + missing.join(', '));
  }
  const calendarIds = rawCalendarIds.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  if (!calendarIds.length) {
    throw new Error(PROP_CALENDAR_ID + ' にカレンダーIDが1件も入っていません');
  }
  return { calendarIds: calendarIds, webhookUrl: webhookUrl };
}

function syncTokenKey_(calendarId) {
  return PROP_SYNC_TOKEN_PREFIX + calendarId;
}

function lastSyncAtKey_(calendarId) {
  return PROP_LAST_SYNC_AT_PREFIX + calendarId;
}

/**
 * 初回のみ手動実行: 各カレンダーの現時点を基点に記録（通知は出さない）
 */
function initialize() {
  const config = getConfig_();
  const props = PropertiesService.getScriptProperties();
  for (const calendarId of config.calendarIds) {
    resetBaseline_(props, calendarId);
  }
  props.deleteProperty(PROP_LEGACY_SYNC_TOKEN);
  console.log('初期化完了: ' + config.calendarIds.length + '件のカレンダー');
}

/**
 * 現時点を差分の基点として記録する。通知は出さない。
 *
 * 実行開始時刻は `fetchInitialSyncToken_()` を呼ぶ前に測る。フル同期の最中に入った変更は
 * 次回の差分に乗るので、後で測ると「前回実行より前の更新」と誤判定して落としてしまう。
 */
function resetBaseline_(props, calendarId) {
  const startedAt = new Date();
  props.setProperty(syncTokenKey_(calendarId), fetchInitialSyncToken_(calendarId));
  props.setProperty(lastSyncAtKey_(calendarId), startedAt.toISOString());
}

/**
 * 定期実行: 差分（追加・更新・削除）をSlackに通知
 * トリガー: 時間主導型（例: 5分ごと）
 */
function notifyCalendarChanges() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(0)) {
    console.warn('前回の実行が継続中のためスキップします');
    return;
  }
  try {
    const config = getConfig_();
    const props = PropertiesService.getScriptProperties();
    migrateLegacySyncToken_(props, config.calendarIds);

    let failures = 0;
    for (const calendarId of config.calendarIds) {
      failures += notifyOneCalendar_(props, config, calendarId);
    }
    if (failures > 0) {
      // syncToken は投稿前に進んでいるため、失敗した通知は取りこぼしになる。
      // 例外にしてGASの失敗通知メールで気づけるようにする
      throw new Error('Slackへの投稿に ' + failures + '件失敗しました');
    }
  } finally {
    lock.releaseLock();
  }
}

/**
 * `SYNC_TOKEN`（単一カレンダー時代のキー）を `SYNC_TOKEN:<カレンダーID>` へ移す。
 * 監視対象が1件のときだけ引き継げる。複数なら基準点を取り直すしかないので捨てる。
 */
function migrateLegacySyncToken_(props, calendarIds) {
  const legacy = props.getProperty(PROP_LEGACY_SYNC_TOKEN);
  if (!legacy) return;
  if (calendarIds.length === 1 && !props.getProperty(syncTokenKey_(calendarIds[0]))) {
    props.setProperty(syncTokenKey_(calendarIds[0]), legacy);
    console.log('SYNC_TOKEN を ' + syncTokenKey_(calendarIds[0]) + ' へ移行しました');
  }
  props.deleteProperty(PROP_LEGACY_SYNC_TOKEN);
}

/**
 * 1カレンダー分の差分を通知する。戻り値はSlack投稿の失敗件数。
 */
function notifyOneCalendar_(props, config, calendarId) {
  const tokenKey = syncTokenKey_(calendarId);
  let syncToken = props.getProperty(tokenKey);
  if (!syncToken) {
    resetBaseline_(props, calendarId);
    console.log(calendarId + ': 基準点を作成しました（通知なし）');
    return 0;
  }
  const startedAt = new Date();
  const lastSyncAt = readLastSyncAt_(props, calendarId);

  let pageToken;
  let calendarName = '';
  const changed = [];
  try {
    do {
      const res = Calendar.Events.list(calendarId, {
        syncToken: syncToken,
        singleEvents: SINGLE_EVENTS,
        showDeleted: true,
        pageToken: pageToken,
      });
      calendarName = res.summary || calendarName;
      changed.push(...(res.items || []));
      pageToken = res.nextPageToken;
      if (res.nextSyncToken) syncToken = res.nextSyncToken;
    } while (pageToken);
  } catch (e) {
    // syncToken失効(410 Gone)のみ再初期化する。
    // それ以外（一時的なエラー・クォータ超過など）は再スローし、GASの失敗通知メールに載せる
    if (!isSyncTokenExpired_(e)) throw e;
    console.warn(calendarId + ': syncToken失効のため基準点を取り直します: ' + e);
    resetBaseline_(props, calendarId);
    return 0;
  }
  props.setProperty(tokenKey, syncToken);
  props.setProperty(lastSyncAtKey_(calendarId), startedAt.toISOString());

  const changedThisTime = changed.filter(function (ev) { return !isUnchangedResend_(ev, lastSyncAt); });
  const resent = changed.length - changedThisTime.length;
  if (resent > 0) {
    console.log(calendarId + ': 巻き添えの再送 ' + resent + '件を通知対象から除外');
  }

  const notifiable = changedThisTime.filter(function (ev) { return !isPastOccurrence_(ev); });
  const skipped = changedThisTime.length - notifiable.length;
  if (skipped > 0) {
    console.log(calendarId + ': 過去回の変更 ' + skipped + '件を通知対象から除外');
  }

  // 監視対象が1件だけならカレンダー名は自明なので添えない
  const suffix = config.calendarIds.length > 1
    ? '\nカレンダー: ' + (calendarName || calendarId)
    : '';

  if (notifiable.length > MAX_NOTIFICATIONS_PER_RUN) {
    console.warn(calendarId + ': 変更 ' + notifiable.length + '件。上限を超えたため個別通知を抑止');
    const posted = postToSlack_(config.webhookUrl,
      '⚠️ カレンダーの変更を ' + notifiable.length + '件 検知しました（個別通知の上限 '
      + MAX_NOTIFICATIONS_PER_RUN + '件 を超えたため一覧は省略します）。カレンダーを直接ご確認ください。' + suffix);
    return posted ? 0 : 1;
  }

  let failures = 0;
  for (const ev of notifiable) {
    if (!postToSlack_(config.webhookUrl, formatMessage_(calendarId, ev) + suffix)) failures++;
  }
  return failures;
}

/**
 * 今回は変更されていないのに差分へ巻き添えで乗ってきたイベントかどうか。
 *
 * 繰り返し予定を1回分だけ削除すると、差分にはその回だけでなく
 * シリーズ本体や、以前に個別変更・削除した他の回まで一緒に返ってくる
 * （2026-08-14 に実測: 1回分の削除で、シリーズ本体2件と別の回の削除2件を巻き添えに、
 * 計5件のSlack通知が飛んだ）。
 *
 * 巻き添え分は「再送されただけで中身は変わっていない」ので、`updated`（そのイベント自身が
 * 最後に更新された時刻）が前回の実行開始より前になる。実際に今回変更されたイベントだけが
 * 新しい `updated` を持つので、そこで切り分ける。
 *
 * `updated` が読めないときや基準時刻が無いとき（この機能より前から動いている環境の初回）は
 * 落とさない。通知が重複するより、消えるほうが困るため。
 */
function isUnchangedResend_(ev, lastSyncAt) {
  if (!lastSyncAt || !ev.updated) return false;
  const updated = new Date(ev.updated).getTime();
  if (isNaN(updated)) return false;
  return updated < lastSyncAt.getTime() - UPDATED_SKEW_MS;
}

/** 前回の差分取得を開始した時刻。未記録・壊れている場合は null（＝再送の判定をしない） */
function readLastSyncAt_(props, calendarId) {
  const raw = props.getProperty(lastSyncAtKey_(calendarId));
  if (!raw) return null;
  const at = new Date(raw);
  if (isNaN(at.getTime())) {
    console.warn(calendarId + ': ' + lastSyncAtKey_(calendarId) + ' を日時として読めません: ' + raw);
    return null;
  }
  return at;
}

/**
 * 繰り返し予定の「過ぎた回」かどうか。
 *
 * 繰り返しシリーズを1回編集すると、そのシリーズに紐づく過去の例外インスタンス
 * （個別に変更・削除された回）まで差分として返ってくる。
 * 「2026-02-26の出社が削除されました」と今さら言われても意味がないので落とす。
 *
 * 判定は日付単位。今日の回は残すので、今夜の予定を1件だけ消した場合は通知される。
 * シリーズ本体（recurringEventId を持たない）は対象外。開始日が過去でも
 * 「その繰り返し予定を変更した」こと自体は知りたいため。
 */
function isPastOccurrence_(ev) {
  if (!ev.recurringEventId) return false;
  const point = ev.originalStartTime || ev.start;
  if (!point) return false;
  const date = point.date || (point.dateTime ? toCalendarDate_(point.dateTime) : '');
  if (!date) return false;
  return date < toCalendarDate_(new Date());
}

/** yyyy-MM-dd をスクリプトのタイムゾーンで返す（ISO日付なので文字列比較で日付の前後が判定できる） */
function toCalendarDate_(value) {
  const d = value instanceof Date ? value : new Date(value);
  return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

function fetchInitialSyncToken_(calendarId) {
  let pageToken, syncToken;
  do {
    const res = Calendar.Events.list(calendarId, {
      timeMin: new Date().toISOString(),
      singleEvents: SINGLE_EVENTS,
      showDeleted: true,
      pageToken: pageToken,
    });
    pageToken = res.nextPageToken;
    if (res.nextSyncToken) syncToken = res.nextSyncToken;
  } while (pageToken);
  if (!syncToken) {
    throw new Error(calendarId + ': nextSyncToken を取得できませんでした。カレンダーIDと権限を確認してください');
  }
  return syncToken;
}

function isSyncTokenExpired_(e) {
  if (!e) return false;
  if (e.details && e.details.code === 410) return true;
  // GASのAdvanced Serviceは "Sync token is no longer valid, a full sync is required."
  // のようにステータスコードを含まないメッセージを投げることがある
  return /\b410\b|fullSyncRequired|sync token|full sync/i.test(String(e.message || e));
}

function formatMessage_(calendarId, ev) {
  const title = resolveTitle_(calendarId, ev);
  const when = formatWhen_(ev);
  if (ev.status === 'cancelled') {
    return '🗑️ 予定が削除されました\n*' + title + '*\n日時: ' + when;
  }
  const isNew = new Date(ev.updated) - new Date(ev.created) < 60 * 1000;
  return (isNew ? '🆕 予定が追加されました\n*' : '✏️ 予定が更新されました\n*')
    + title + '*\n日時: ' + when;
}

/**
 * 削除されたイベントは summary を返さないことがある。
 * 繰り返しの一部なら親イベントからタイトルを補う。
 */
function resolveTitle_(calendarId, ev) {
  if (ev.summary) return ev.summary;
  if (ev.recurringEventId) {
    try {
      const parent = Calendar.Events.get(calendarId, ev.recurringEventId);
      if (parent && parent.summary) return parent.summary;
    } catch (e) {
      console.warn('親イベントの取得に失敗: ' + e);
    }
  }
  return '（タイトルなし）';
}

/**
 * singleEvents=false では繰り返し予定がシリーズ単位で返るため、
 * ev.start は初回occurrenceの日時になる。日時だけでは誤解を招くので種別を添える。
 * 個別occurrenceの変更・削除は originalStartTime にその回の日時が入る。
 */
function formatWhen_(ev) {
  const point = ev.originalStartTime || ev.start;
  const when = point ? (point.dateTime || point.date || '') : '';
  if (ev.recurrence) return when + ' から（繰り返し予定）';
  if (ev.recurringEventId) return when + '（繰り返しのうち1回）';
  return when;
}

/**
 * Incoming Webhook へ POST する。成功（200）したら true。
 * 429 と 5xx のみ再試行する（4xxは再送しても直らないため即座に諦める）。
 *
 * followRedirects: false は必須。無効な Webhook URL に対して Slack は 302 を返し、
 * リダイレクトを追うと最終的に無関係なページに着地する。既定（追う）のままだと
 * 「URLが壊れている」ことを 200 と誤認しかねないため、リダイレクトは失敗として扱う。
 */
function postToSlack_(webhookUrl, text) {
  for (let attempt = 1; attempt <= SLACK_POST_ATTEMPTS; attempt++) {
    let code, body;
    try {
      const res = UrlFetchApp.fetch(webhookUrl, {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify({ text: text }),
        muteHttpExceptions: true,
        followRedirects: false,
      });
      code = res.getResponseCode();
      body = res.getContentText();
      if (code === 200) return true;
    } catch (e) {
      // DNS解決失敗などfetch自体が投げるケース
      code = 0;
      body = String(e);
    }
    const retriable = code === 0 || code === 429 || code >= 500;
    console.error('Slack投稿失敗(' + attempt + '/' + SLACK_POST_ATTEMPTS + '): ' + code + ' ' + body);
    if (!retriable) return false;
    if (attempt < SLACK_POST_ATTEMPTS) Utilities.sleep(1000 * attempt);
  }
  return false;
}
