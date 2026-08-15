import test from 'node:test';
import assert from 'node:assert/strict';
import { createSyncedCalendar, createCalendar, headlines, CALENDAR_ID } from './gas-harness.mjs';

const SEEN_KEY = 'SEEN_EVENTS:' + CALENDAR_ID;

// 2026-08-14 11:46 JST（ハーネスが固定する「今」）に観測した実際の差分。
// 消したのは 9/2 の1回だけで、残りは巻き添え。
const series = (id, start, updated) => ({
  id, summary: 'ごはん', status: 'confirmed', etag: '"1"',
  recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=WE'],
  start: { dateTime: start }, end: { dateTime: start },
  created: '2021-05-20T00:00:00Z', updated,
  reminders: { useDefault: true },
});
const cancelledOccurrence = (id, parentId, originalStart, updated) => ({
  id, summary: 'ごはん', status: 'cancelled', etag: '"1"',
  recurringEventId: parentId,
  originalStartTime: { dateTime: originalStart },
  created: '2021-05-20T00:00:00Z', updated,
  reminders: { useDefault: true },
});

const seriesA = series('A', '2021-05-26T19:30:00+09:00', '2026-06-01T00:00:00Z');
const seriesB = series('B', '2023-04-12T19:30:00+09:00', '2026-07-10T00:00:00Z');
const deleted0826 = cancelledOccurrence('A_20260826', 'A', '2026-08-26T19:30:00+09:00', '2026-08-01T00:00:00Z');
const deleted0902 = cancelledOccurrence('A_20260902', 'A', '2026-09-02T19:30:00+09:00', '2026-08-14T02:45:30Z');
const deleted0916 = cancelledOccurrence('A_20260916', 'A', '2026-09-16T19:30:00+09:00', '2026-08-05T00:00:00Z');

const single = {
  id: 'S1', summary: '打ち合わせ', status: 'confirmed', etag: '"1"',
  start: { dateTime: '2026-08-20T10:00:00+09:00' }, end: { dateTime: '2026-08-20T11:00:00+09:00' },
  created: '2026-07-01T00:00:00Z', updated: '2026-07-01T00:00:00Z',
  reminders: { useDefault: true },
};

test('巻き添えの再送は、前回と中身が同じなら通知しない', () => {
  const calendar = createSyncedCalendar();

  // 1回目: どれも初見なので、変わっていないと確認できず全件通知する
  const first = calendar.run({ items: [seriesA, deleted0826, deleted0902, deleted0916, seriesB] });
  assert.equal(first.posts.length, 5);

  // 2回目: 9/9 を消す。巻き添えの4件と前回の9/2は中身が変わっていないので落ちる
  const deleted0909 = cancelledOccurrence('A_20260909', 'A', '2026-09-09T19:30:00+09:00', '2026-08-14T02:50:00Z');
  const second = calendar.run({
    items: [seriesA, deleted0826, deleted0902, deleted0909, deleted0916, seriesB],
  });

  assert.deepEqual(headlines(second.posts), ['🗑️ 予定が削除されました']);
  assert.match(second.posts[0], /2026-09-09T19:30:00\+09:00（繰り返しのうち1回）/);
});

test('回を削除したときに一緒に返ってくるシリーズ本体は通知しない', () => {
  const calendar = createSyncedCalendar();
  const gym = { ...series('G', '2025-01-15T09:00:00+09:00', '2026-06-01T00:00:00Z'), summary: '🐸ジム' };

  // 1回目: 本体は初見なので通知され、ここで文面の指紋が残る
  const first = calendar.run({ items: [gym, seriesA] });
  assert.equal(first.posts.length, 2);

  // 2回目: 8/19 の回を削除する。本体は updated と sequence だけが動く
  const touched = (s) => ({ ...s, updated: '2026-08-15T00:06:00Z', sequence: 3 });
  const second = calendar.run({
    items: [
      touched(gym),
      cancelledOccurrence('G_20260819', 'G', '2026-08-19T09:00:00+09:00', '2026-08-15T00:06:00Z'),
      touched(seriesA),
      cancelledOccurrence('A_20260819', 'A', '2026-08-19T19:30:00+09:00', '2026-08-15T00:06:00Z'),
    ],
  });

  assert.deepEqual(headlines(second.posts), ['🗑️ 予定が削除されました', '🗑️ 予定が削除されました']);
  assert.ok(second.posts.every((p) => p.includes('2026-08-19')));
});

test('シリーズ本体そのものの変更は、同じ差分に回が居ても通知する', () => {
  const calendar = createSyncedCalendar();
  calendar.run({ items: [seriesA] });

  const renamed = { ...seriesA, summary: 'ごはん（改）', updated: '2026-08-15T00:06:00Z' };
  const second = calendar.run({
    items: [renamed, cancelledOccurrence('A_20260819', 'A', '2026-08-19T19:30:00+09:00', '2026-08-15T00:06:00Z')],
  });

  assert.equal(second.posts.length, 2);
  assert.ok(second.posts.some((p) => p.includes('ごはん（改）') && p.startsWith('✏️')));
});

test('シリーズ本体のリマインダー変更は、同じ差分に回が居ても通知する', () => {
  const calendar = createSyncedCalendar();
  calendar.run({ items: [seriesA] });

  // 文面（タイトル・日時・種別）には出ない変更。updated も進まない
  const remindersChanged = {
    ...seriesA,
    reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 30 }] },
  };
  const second = calendar.run({
    items: [
      remindersChanged,
      cancelledOccurrence('A_20260819', 'A', '2026-08-19T19:30:00+09:00', '2026-08-15T00:06:00Z'),
    ],
  });

  assert.equal(second.posts.length, 2, 'シリーズ本体の変更が握りつぶされてはいけない');
  assert.ok(second.posts.some((p) => p.includes('（繰り返し予定）')));
});

test('繰り返しルール・終了日時だけの変更も、同じ差分に回が居ても通知する', () => {
  for (const [name, change] of [
    ['recurrence', { recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=WE;UNTIL=20270101T000000Z'] }],
    ['end', { end: { dateTime: '2021-05-26T21:00:00+09:00' } }],
  ]) {
    const calendar = createSyncedCalendar();
    calendar.run({ items: [seriesA] });

    const second = calendar.run({
      items: [
        { ...seriesA, ...change, updated: '2026-08-15T00:06:00Z', sequence: 3 },
        cancelledOccurrence('A_20260819', 'A', '2026-08-19T19:30:00+09:00', '2026-08-15T00:06:00Z'),
      ],
    });

    assert.equal(second.posts.length, 2, name + ' の変更が握りつぶされてはいけない');
  }
});

test('旧2要素形式のキャッシュしか無ければ、シリーズ本体を黙らせない', () => {
  // #7 が保存した形式。管理情報を除いた指紋がまだ無い
  const calendar = createSyncedCalendar({
    properties: { [SEEN_KEY]: JSON.stringify([['A', '0123456789abcdef']]) },
  });

  const result = calendar.run({
    items: [
      { ...seriesA, updated: '2026-08-15T00:06:00Z', sequence: 3 },
      cancelledOccurrence('A_20260819', 'A', '2026-08-19T19:30:00+09:00', '2026-08-15T00:06:00Z'),
    ],
  });

  assert.equal(result.posts.length, 2);
  // 今回の実行で3要素に書き直され、次からは黙らせられる
  assert.equal(JSON.parse(calendar.property(SEEN_KEY))[0].length, 3);
});

test('通知する回が無ければ、シリーズ本体は黙らせない', () => {
  const calendar = createSyncedCalendar();
  calendar.run({ items: [seriesA] });

  // 差分に乗った回が過去回だけなら、本体の通知が唯一の知らせになる
  const second = calendar.run({
    items: [
      { ...seriesA, updated: '2026-08-15T00:06:00Z', sequence: 3 },
      cancelledOccurrence('A_20260701', 'A', '2026-07-01T19:30:00+09:00', '2026-08-15T00:06:00Z'),
    ],
  });

  assert.deepEqual(headlines(second.posts), ['✏️ 予定が更新されました']);
});

test('シリーズ全体を削除したら本体の削除を通知する', () => {
  const calendar = createSyncedCalendar();
  calendar.run({ items: [seriesA] });

  const second = calendar.run({
    items: [
      { ...seriesA, status: 'cancelled', updated: '2026-08-15T00:06:00Z' },
      cancelledOccurrence('A_20260819', 'A', '2026-08-19T19:30:00+09:00', '2026-08-15T00:06:00Z'),
    ],
  });

  assert.ok(second.posts.some((p) => p.startsWith('🗑️') && p.includes('繰り返し予定')));
});

test('リマインダーだけの変更は通知する（updated が進まないケース）', () => {
  const calendar = createSyncedCalendar();
  calendar.run({ items: [single] });

  // updated は main event data の更新時刻なので、リマインダーを変えても進まない
  const remindersChanged = {
    ...single,
    reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 10 }] },
  };
  const second = calendar.run({ items: [remindersChanged] });

  assert.equal(second.posts.length, 1, 'リマインダーのみの変更が握りつぶされてはいけない');
});

test('etag だけが違う再送は通知しない', () => {
  const calendar = createSyncedCalendar();
  calendar.run({ items: [single] });

  const second = calendar.run({ items: [{ ...single, etag: '"2"' }] });
  assert.equal(second.posts.length, 0);
});

test('初見のイベントは通知する（指紋が無いので変わっていないと確認できない）', () => {
  const calendar = createSyncedCalendar();
  const result = calendar.run({ items: [seriesA, deleted0826] });
  assert.equal(result.posts.length, 2);
});

test('updated が無くても、中身が変われば通知する', () => {
  const withoutUpdated = { ...single };
  delete withoutUpdated.updated;
  const calendar = createSyncedCalendar();
  calendar.run({ items: [withoutUpdated] });

  const renamed = { ...withoutUpdated, summary: '打ち合わせ（変更後）' };
  const second = calendar.run({ items: [renamed] });

  assert.deepEqual(headlines(second.posts), ['✏️ 予定が更新されました']);
  assert.match(second.posts[0], /打ち合わせ（変更後）/);
});

test('updated が不正な文字列でも、中身が変われば通知する', () => {
  const broken = { ...single, updated: 'not-a-timestamp' };
  const calendar = createSyncedCalendar();
  calendar.run({ items: [broken] });

  const second = calendar.run({ items: [{ ...broken, summary: '別のタイトル' }] });
  assert.equal(second.posts.length, 1);
});

test('シリーズ本体そのものの変更は通知する', () => {
  const calendar = createSyncedCalendar();
  calendar.run({ items: [seriesA, deleted0826] });

  const renamed = { ...seriesA, summary: 'ごはん（改）', updated: '2026-08-14T02:45:00Z' };
  const second = calendar.run({ items: [renamed, deleted0826] });

  assert.deepEqual(headlines(second.posts), ['✏️ 予定が更新されました']);
  assert.match(second.posts[0], /ごはん（改）/);
});

test('同じ回を一続きの操作で続けて消しても、二重通知にならない', () => {
  const calendar = createSyncedCalendar();
  calendar.run({ items: [deleted0902] });

  // 直後（同じ実行間隔の中）に別の回を消すと、9/2 が再び差分に乗ってくる
  const deleted0909 = cancelledOccurrence('A_20260909', 'A', '2026-09-09T19:30:00+09:00', '2026-08-14T02:45:50Z');
  const second = calendar.run({ items: [deleted0902, deleted0909] });

  assert.equal(second.posts.length, 1);
  assert.match(second.posts[0], /2026-09-09/);
});

test('指紋の保存は Script Properties の上限に収まり、古いものから捨てる', () => {
  const calendar = createSyncedCalendar();
  const many = [];
  for (let i = 0; i < 400; i++) {
    many.push({ ...single, id: 'evt-' + i + '-'.padEnd(40, 'x'), summary: '予定' + i });
  }
  calendar.run({ items: many });

  const stored = JSON.parse(calendar.property(SEEN_KEY));
  assert.ok(stored.length > 0);
  assert.ok(stored.length <= 300, '件数の上限を超えている: ' + stored.length);
  assert.ok(calendar.property(SEEN_KEY).length <= 8000, 'プロパティ値が 8000 バイトを超えている');
  assert.equal(stored[0][0], many[0].id, '今回見た分から先に積む');

  // 次の実行で見た分がさらに先頭に来て、古い分から押し出される
  const next = calendar.run({ items: [{ ...single, id: 'evt-latest' }] });
  assert.equal(next.posts.length, 1);
  const restored = JSON.parse(calendar.property(SEEN_KEY));
  assert.equal(restored[0][0], 'evt-latest');
  assert.ok(restored.length <= 300);
});

test('保存済みの指紋が壊れていても、通知を落とさず作り直す', () => {
  const calendar = createSyncedCalendar({ properties: { [SEEN_KEY]: '{壊れたJSON' } });
  const result = calendar.run({ items: [single] });

  assert.equal(result.posts.length, 1);
  assert.deepEqual(JSON.parse(calendar.property(SEEN_KEY)).length, 1);
  assert.ok(result.logs.some((l) => l.includes('読めないため作り直します')));
});

test('過去回の変更は通知しない（今日の回は通知する）', () => {
  const calendar = createSyncedCalendar();
  const yesterday = cancelledOccurrence('A_20260813', 'A', '2026-08-13T19:30:00+09:00', '2026-08-14T02:45:00Z');
  const today = cancelledOccurrence('A_20260814', 'A', '2026-08-14T19:30:00+09:00', '2026-08-14T02:45:00Z');

  const result = calendar.run({ items: [yesterday, today] });

  assert.equal(result.posts.length, 1);
  assert.match(result.posts[0], /2026-08-14T19:30:00\+09:00/);
});

test('新規追加・更新・削除の見出しを出し分ける', () => {
  const calendar = createSyncedCalendar();
  const added = { ...single, id: 'new', created: '2026-08-14T02:45:00Z', updated: '2026-08-14T02:45:10Z' };
  const updated = { ...single, id: 'upd', created: '2026-07-01T00:00:00Z', updated: '2026-08-14T02:45:00Z' };
  const removed = { ...single, id: 'del', status: 'cancelled' };

  const result = calendar.run({ items: [added, updated, removed] });

  assert.deepEqual(headlines(result.posts), [
    '🆕 予定が追加されました',
    '✏️ 予定が更新されました',
    '🗑️ 予定が削除されました',
  ]);
});

test('件数が上限を超えたら個別通知を打ち切る', () => {
  const calendar = createSyncedCalendar();
  const many = [];
  for (let i = 0; i <= 20; i++) many.push({ ...single, id: 'evt-' + i });

  const result = calendar.run({ items: many });

  assert.equal(result.posts.length, 1);
  assert.match(result.posts[0], /21件 検知しました/);
});

test('基準点が無いカレンダーは通知せず基準点だけ作る', () => {
  const calendar = createCalendar();
  const result = calendar.run({ items: [single] });

  assert.equal(result.posts.length, 0);
  assert.ok(calendar.property('SYNC_TOKEN:' + CALENDAR_ID));
});

test('syncToken 失効時は基準点を取り直して通知しない', () => {
  const calendar = createSyncedCalendar();
  const result = calendar.run({
    listImpl: (calendarId, params) => {
      if (params.syncToken) {
        const e = new Error('Sync token is no longer valid, a full sync is required.');
        throw e;
      }
      return { summary: 'テストカレンダー', items: [], nextSyncToken: 'tok-fresh' };
    },
  });

  assert.equal(result.posts.length, 0);
  assert.equal(result.error, null);
  assert.equal(calendar.property('SYNC_TOKEN:' + CALENDAR_ID), 'tok-fresh');
});

test('Slack投稿に失敗したら例外にする（GASの失敗通知メールで気づけるように）', () => {
  const calendar = createSyncedCalendar();
  const result = calendar.run({ items: [single], slackStatus: 404 });

  assert.ok(result.error, '投稿失敗が握りつぶされている');
  assert.match(String(result.error.message), /1件失敗/);
});

test('指紋はフィールドの並び順に左右されない', () => {
  const context = createSyncedCalendar().context();
  const a = { id: 'x', summary: 'ごはん', start: { dateTime: '2026-09-02T19:30:00+09:00' }, etag: '"1"' };
  const b = { etag: '"9"', start: { dateTime: '2026-09-02T19:30:00+09:00' }, summary: 'ごはん', id: 'x' };

  assert.equal(context.eventFingerprint_(a), context.eventFingerprint_(b));
  assert.notEqual(context.eventFingerprint_(a), context.eventFingerprint_({ ...a, summary: 'ちがう' }));
});

test('指紋は未知のフィールドの変化も拾う', () => {
  const context = createSyncedCalendar().context();
  const base = { id: 'x', summary: 'ごはん' };

  assert.notEqual(
    context.eventFingerprint_(base),
    context.eventFingerprint_({ ...base, someNewFieldGoogleAdded: 'value' }));
});
