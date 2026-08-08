/***** 設定はスクリプト プロパティに置く（プロジェクトの設定 → スクリプト プロパティ）
 *   CALENDAR_ID          監視対象カレンダーのID。カンマ区切りで複数指定できる
 *   SLACK_WEBHOOK_URL    Slack Incoming Webhook の URL
 *   SYNC_TOKEN:<カレンダーID>  差分同期用トークン（initialize() が自動で保存する。手動設定不要）
 *****/
const PROP_CALENDAR_ID = 'CALENDAR_ID';
const PROP_SLACK_WEBHOOK_URL = 'SLACK_WEBHOOK_URL';
const PROP_SYNC_TOKEN_PREFIX = 'SYNC_TOKEN:';

// 単一カレンダーのみ対応していた頃のキー。移行のためだけに参照する
const PROP_LEGACY_SYNC_TOKEN = 'SYNC_TOKEN';

// 1カレンダー・1実行あたりに個別通知する上限。超えた場合は件数だけ通知して打ち切る
const MAX_NOTIFICATIONS_PER_RUN = 20;

// 繰り返し予定はシリーズ単位で受け取る。true にすると終了日なしの繰り返し予定が
// 将来方向の全インスタンスへ展開され、シリーズを1回変更しただけで数百件の差分が返る
const SINGLE_EVENTS = false;

// Slack投稿のリトライ回数（429と5xxのみ再試行する）
const SLACK_POST_ATTEMPTS = 3;

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

/**
 * 初回のみ手動実行: 各カレンダーの現時点を基点に記録（通知は出さない）
 */
function initialize() {
  const config = getConfig_();
  const props = PropertiesService.getScriptProperties();
  for (const calendarId of config.calendarIds) {
    props.setProperty(syncTokenKey_(calendarId), fetchInitialSyncToken_(calendarId));
  }
  props.deleteProperty(PROP_LEGACY_SYNC_TOKEN);
  console.log('初期化完了: ' + config.calendarIds.length + '件のカレンダー');
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
    props.setProperty(tokenKey, fetchInitialSyncToken_(calendarId));
    console.log(calendarId + ': 基準点を作成しました（通知なし）');
    return 0;
  }

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
    props.setProperty(tokenKey, fetchInitialSyncToken_(calendarId));
    return 0;
  }
  props.setProperty(tokenKey, syncToken);

  const notifiable = changed.filter(function (ev) { return !isPastOccurrence_(ev); });
  const skipped = changed.length - notifiable.length;
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
