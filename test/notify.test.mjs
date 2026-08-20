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

/**
 * primeFingerprints() 用の応答。フル同期（syncToken なし）と
 * 未取得の差分（syncToken あり）で別の一覧を返す。
 */
const primeSources = (full, pending = []) => (calendarId, params) => (params.syncToken
  ? { items: pending }
  : { summary: 'テストカレンダー', items: full, nextSyncToken: 'tok-full' });

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

  // 1回目: 本体は初見なので通知され、ここで管理情報を除いた指紋が残る
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

test('extendedProperties の updated / sequence の変更は通知する（管理情報扱いしない）', () => {
  for (const key of ['updated', 'sequence']) {
    const withProperties = {
      ...seriesA,
      extendedProperties: { private: { [key]: '1', memo: 'そのまま' } },
    };
    const calendar = createSyncedCalendar();
    calendar.run({ items: [withProperties] });

    // 動かすのは extendedProperties の中だけ。トップレベルの updated / sequence は据え置き
    const second = calendar.run({
      items: [
        { ...withProperties, extendedProperties: { private: { [key]: '2', memo: 'そのまま' } } },
        cancelledOccurrence('A_20260819', 'A', '2026-08-19T19:30:00+09:00', '2026-08-15T00:06:00Z'),
      ],
    });

    assert.equal(second.posts.length, 2,
      'extendedProperties.private.' + key + ' の変更が握りつぶされてはいけない');
  }
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

test('primeFingerprints() は通知せず指紋だけ記録し、syncToken を触らない', () => {
  const calendar = createSyncedCalendar();
  const result = calendar.prime({ listImpl: primeSources([seriesA, deleted0916]) });

  assert.equal(result.posts.length, 0);
  assert.equal(calendar.property('SYNC_TOKEN:' + CALENDAR_ID), 'tok-0', 'syncToken を進めてはいけない');
  assert.equal(JSON.parse(calendar.property(SEEN_KEY)).length, 2);
  assert.ok(result.logs.some((l) => l.includes('2件の予定から指紋を記録しました')));
});

test('primeFingerprints() 済みなら、最初の削除から余計な通知が出ない', () => {
  // 2026-08-17 11:26 の実測: サウナの 8/17 を消したら、シリーズ本体と前に消した 11/23 も出た
  const sauna = { ...series('S', '2025-09-29T20:30:00+09:00', '2026-06-01T00:00:00Z'), summary: 'サウナ' };
  const deleted1123 = cancelledOccurrence('S_20261123', 'S', '2026-11-23T20:30:00+09:00', '2026-07-20T00:00:00Z');

  const calendar = createSyncedCalendar();
  calendar.prime({ listImpl: primeSources([sauna, deleted1123]) });

  const result = calendar.run({
    items: [
      { ...sauna, updated: '2026-08-17T02:26:00Z', sequence: 2 },
      cancelledOccurrence('S_20260817', 'S', '2026-08-17T20:30:00+09:00', '2026-08-17T02:26:00Z'),
      deleted1123,
    ],
  });

  assert.deepEqual(headlines(result.posts), ['🗑️ 予定が削除されました']);
  assert.match(result.posts[0], /2026-08-17T20:30:00\+09:00/);
});

test('initialize() もフル同期の結果から指紋を記録する', () => {
  const calendar = createCalendar();
  const result = calendar.initialize({ items: [seriesA, deleted0916] });

  assert.equal(result.posts.length, 0);
  assert.equal(JSON.parse(calendar.property(SEEN_KEY)).length, 2);
  assert.ok(calendar.property('SYNC_TOKEN:' + CALENDAR_ID));
});

test('基準点を作り直した直後も巻き添えの通知が噴き出さない', () => {
  const calendar = createCalendar();  // syncToken が無い状態から始める
  const first = calendar.run({ items: [seriesA, deleted0916] });
  assert.equal(first.posts.length, 0, '基準点作成時は通知しない');

  // 続く差分に同じものが乗っても、基準点作成時の指紋で黙る
  const second = calendar.run({ items: [seriesA, deleted0916, deleted0902] });
  assert.deepEqual(headlines(second.posts), ['🗑️ 予定が削除されました']);
  assert.match(second.posts[0], /2026-09-02/);
});

test('保存の枠が足りないときは繰り返し予定を優先して残す', () => {
  const calendar = createSyncedCalendar();
  const singles = [];
  for (let i = 0; i < 400; i++) {
    singles.push({ ...single, id: 'single-' + i + '-'.padEnd(40, 'x'), summary: '単発' + i });
  }
  // 繰り返し予定は最後に並べて渡す（API の順序に依存しないことの確認）
  calendar.prime({ listImpl: primeSources(singles.concat([seriesA, deleted0916])) });

  const stored = JSON.parse(calendar.property(SEEN_KEY)).map((e) => e[0]);
  assert.ok(stored.includes('A'), 'シリーズ本体が捨てられている');
  assert.ok(stored.includes('A_20260916'), '繰り返しの回が捨てられている');
  assert.equal(stored[0], 'A');
});

test('primeFingerprints() は未取得の差分に含まれる予定の指紋を記録しない', () => {
  const calendar = createSyncedCalendar();
  // tok-0 を保存したあとに変更された予定。フル同期にも差分にも現れる
  const changed = { ...single, summary: '変更後', updated: '2026-08-17T12:00:00Z' };

  calendar.prime({ items: [changed] });
  const result = calendar.run({ items: [changed] });

  assert.equal(result.posts.length, 1, '未通知の変更を握りつぶしてはいけない');
  assert.match(result.posts[0], /変更後/);
});

test('primeFingerprints() は未取得の差分に無い予定だけ記録する', () => {
  const calendar = createSyncedCalendar();
  const changed = { ...single, summary: '変更後', updated: '2026-08-17T12:00:00Z' };

  const result = calendar.prime({ listImpl: primeSources([seriesA, changed], [changed]) });

  const stored = JSON.parse(calendar.property(SEEN_KEY)).map((e) => e[0]);
  assert.deepEqual(stored, ['A'], '未通知の差分にある予定を記録してはいけない');
  assert.ok(result.logs.some((l) => l.includes('未通知の差分にある 1件')));

  // 記録しなかった分は、次の定期実行できちんと通知される
  const second = calendar.run({ items: [changed] });
  assert.equal(second.posts.length, 1);
});

test('未取得の差分を取れなかったら、指紋を書かずにエラーにする', () => {
  const calendar = createSyncedCalendar();
  const result = calendar.prime({
    listImpl: (calendarId, params) => {
      if (params.syncToken) throw new Error('Backend Error');
      return { items: [seriesA], nextSyncToken: 'tok-full' };
    },
  });

  assert.ok(result.error, '差分の取得失敗を握りつぶしてはいけない');
  assert.equal(calendar.property(SEEN_KEY), null, '指紋を書いてはいけない');
  assert.equal(calendar.property('SYNC_TOKEN:' + CALENDAR_ID), 'tok-0');
});

test('定期実行と primeFingerprints() は同じロックで排他する', () => {
  // 定期実行が動いている間に手で primeFingerprints() を叩いた場合
  const duringNotify = createSyncedCalendar();
  const primed = duringNotify.prime({ items: [seriesA], lockHeld: true });
  assert.match(String(primed.error && primed.error.message), /定期実行が動いている/);
  assert.equal(duringNotify.property(SEEN_KEY), null, '指紋を上書きしてはいけない');

  // primeFingerprints() の最中にトリガーが起動した場合
  const duringPrime = createSyncedCalendar({ properties: { [SEEN_KEY]: JSON.stringify([['A', 'aaaaaaaaaaaaaaaa']]) } });
  const ran = duringPrime.run({ items: [seriesA], lockHeld: true });
  assert.equal(ran.posts.length, 0);
  assert.equal(ran.error, null);
  assert.deepEqual(JSON.parse(duringPrime.property(SEEN_KEY)), [['A', 'aaaaaaaaaaaaaaaa']], '指紋を上書きしてはいけない');
  assert.equal(duringPrime.property('SYNC_TOKEN:' + CALENDAR_ID), 'tok-0', 'syncToken も進めてはいけない');
});

/**
 * 定期実行用の応答。自動の下敷き作成（フル同期）と差分で別の一覧を返す。
 */
const runSources = (full, delta) => (calendarId, params) => (params.syncToken
  ? { summary: 'テストカレンダー', items: delta, nextSyncToken: 'tok-next' }
  : { summary: 'テストカレンダー', items: full, nextSyncToken: 'tok-full' });

test('下敷きが無いカレンダーは、定期実行が1回だけ自動で作る', () => {
  const sauna = { ...series('S', '2025-09-29T20:30:00+09:00', '2026-06-01T00:00:00Z'), summary: 'サウナ' };
  const deleted1123 = cancelledOccurrence('S_20261123', 'S', '2026-11-23T20:30:00+09:00', '2026-07-20T00:00:00Z');
  const calendar = createSyncedCalendar();

  // 変更が無い回でも、下敷きだけは作られる
  const first = calendar.run({ listImpl: runSources([sauna, deleted1123], []) });
  assert.equal(first.posts.length, 0);
  assert.ok(first.logs.some((l) => l.includes('指紋の下敷きを作成しました（2件）')));
  assert.ok(calendar.property('FINGERPRINTS_PRIMED_AT:' + CALENDAR_ID));

  // 次に 8/17 を消すと、シリーズ本体も 11/23 も黙る
  const second = calendar.run({
    items: [
      { ...sauna, updated: '2026-08-17T02:26:00Z', sequence: 2 },
      cancelledOccurrence('S_20260817', 'S', '2026-08-17T20:30:00+09:00', '2026-08-17T02:26:00Z'),
      deleted1123,
    ],
  });
  assert.deepEqual(headlines(second.posts), ['🗑️ 予定が削除されました']);
  assert.match(second.posts[0], /2026-08-17T20:30:00\+09:00/);
});

test('自動の下敷き作成でも、その実行で通知する差分は記録しない', () => {
  const calendar = createSyncedCalendar();
  const changed = { ...single, summary: '変更後', updated: '2026-08-17T12:00:00Z' };

  // フル同期には変更後の姿が乗るが、同じ実行の差分にも居るので記録しない
  const result = calendar.run({ listImpl: runSources([seriesA, changed], [changed]) });

  assert.equal(result.posts.length, 1, '今回通知する変更を先回りで消してはいけない');
  assert.match(result.posts[0], /変更後/);

  const stored = JSON.parse(calendar.property(SEEN_KEY)).map((e) => e[0]);
  assert.deepEqual(stored.sort(), ['A', 'S1'], '差分で見た分は通常どおり記録する');
});

test('下敷きの作成は1カレンダーにつき1回だけ', () => {
  const calendar = createSyncedCalendar();
  let fullSyncs = 0;
  const listImpl = (calendarId, params) => {
    if (params.syncToken) return { items: [], nextSyncToken: 'tok-next' };
    fullSyncs++;
    return { items: [seriesA], nextSyncToken: 'tok-full' };
  };

  calendar.run({ listImpl });
  calendar.run({ listImpl });
  calendar.run({ listImpl });

  assert.equal(fullSyncs, 1, '毎回フル同期してはいけない');
});

test('基準点の作成でも下敷きのマーカーが立つ', () => {
  const calendar = createCalendar();  // syncToken が無い状態
  calendar.run({ items: [seriesA] });

  assert.ok(calendar.property('FINGERPRINTS_PRIMED_AT:' + CALENDAR_ID));
});

/**
 * スクリプト プロパティの一時障害（`Error code INTERNAL.`）への備え。
 * 2026-08-19 に定期実行が5回連続でこれに落ちた。Google側の障害なので避けられないが、
 * 再試行・呼び出し回数の削減・記録の順序で、取りこぼさず・気づかず終わらないようにする。
 */
const internalError = () => new Error(
  "We're sorry, a server error occurred while reading from storage. Error code INTERNAL.");

test('スクリプト プロパティの読み取りは1実行につき1回にまとめる', () => {
  const calendar = createSyncedCalendar();
  const result = calendar.run({ items: [seriesA] });

  const reads = result.storageOps.filter((o) => o.op === 'getProperties' || o.op === 'getProperty');
  assert.deepEqual(reads.map((o) => o.op), ['getProperties'],
    '読み取りのたびに一時障害を踏む機会が増える。まとめて1回だけ読む');
});

test('読み取りの一時障害は再試行して回復する', () => {
  const calendar = createSyncedCalendar();
  let failures = 0;
  const result = calendar.run({
    items: [seriesA],
    storageFault: ({ op }) => {
      if (op === 'getProperties' && failures++ < 2) throw internalError();
    },
  });

  assert.equal(result.error, null, '再試行で回復するはず');
  assert.equal(result.posts.length, 1);
  assert.ok(result.logs.some((l) => /再試行します/.test(l)), '再試行したことをログに残す');
});

test('書き込みの一時障害も再試行して回復する', () => {
  const calendar = createSyncedCalendar();
  let failures = 0;
  const result = calendar.run({
    items: [seriesA],
    storageFault: ({ op }) => {
      if (op === 'setProperty' && failures++ < 2) throw internalError();
    },
  });

  assert.equal(result.error, null);
  assert.notEqual(calendar.property('SYNC_TOKEN:' + CALENDAR_ID), 'tok-0', 'syncToken を書けている');
});

test('再試行しても駄目なら握りつぶさず例外にする', () => {
  const calendar = createSyncedCalendar();
  const result = calendar.run({
    items: [seriesA],
    storageFault: ({ op }) => { if (op === 'getProperties') throw internalError(); },
  });

  assert.ok(result.error, '失敗通知メールで気づけるよう例外にする');
  assert.match(String(result.error.message), /4回失敗/);
});

test('読み取りに失敗した実行は syncToken を進めない（次の実行が同じ差分を拾う）', () => {
  const calendar = createSyncedCalendar();
  const failed = calendar.run({
    items: [seriesA],
    storageFault: ({ op }) => { if (op === 'getProperties') throw internalError(); },
  });

  assert.ok(failed.error);
  assert.equal(failed.posts.length, 0);
  assert.equal(calendar.property('SYNC_TOKEN:' + CALENDAR_ID), 'tok-0', '差分を消費してはいけない');

  const recovered = calendar.run({ items: [seriesA] });
  assert.equal(recovered.posts.length, 1, '次の実行が取りこぼした差分を通知する');
});

test('記録はSlackへ投稿し終えてから行う', () => {
  const calendar = createSyncedCalendar();
  const result = calendar.run({ items: [seriesA, seriesB] });

  assert.equal(result.posts.length, 2);
  const writes = result.storageOps.filter((o) => o.op === 'setProperty');
  assert.ok(writes.length > 0);
  for (const write of writes) {
    assert.equal(write.postedBefore, 2,
      '投稿より先に記録すると、そのあいだの storage 障害で通知が消える');
  }
});

test('記録に失敗しても通知は出ており、syncToken を進めなければ次の実行が拾い直す', () => {
  const calendar = createSyncedCalendar();
  const failed = calendar.run({
    items: [seriesA],
    storageFault: ({ op, key }) => {
      if (op === 'setProperty' && key.startsWith('SYNC_TOKEN:')) throw internalError();
    },
  });

  assert.equal(failed.posts.length, 1, '記録より先に投稿しているので通知は出る');
  assert.ok(failed.error);
  assert.equal(calendar.property('SYNC_TOKEN:' + CALENDAR_ID), 'tok-0');
  assert.equal(calendar.property(SEEN_KEY), null, 'syncToken を書けなければ指紋も残さない');

  // 取りこぼすより重複するほうが安全。次の実行が同じ差分をもう一度通知する
  const retried = calendar.run({ items: [seriesA] });
  assert.equal(retried.posts.length, 1);
});

test('syncToken を書いたあとに失敗しても、指紋が古いだけで通知は消えない', () => {
  const calendar = createSyncedCalendar();
  const failed = calendar.run({
    items: [seriesA],
    storageFault: ({ op, key }) => {
      if (op === 'setProperty' && key.startsWith('SEEN_EVENTS:')) throw internalError();
    },
  });

  assert.equal(failed.posts.length, 1);
  assert.ok(failed.error);
  assert.notEqual(calendar.property('SYNC_TOKEN:' + CALENDAR_ID), 'tok-0', 'syncToken は先に書けている');
  assert.equal(calendar.property(SEEN_KEY), null);

  // 指紋が無いので次に同じ予定が差分へ乗れば通知される（＝多いだけで、消えない）
  const next = calendar.run({ items: [seriesA] });
  assert.equal(next.posts.length, 1);
});

test('待っても直らないエラーは再試行せずに諦める', () => {
  const calendar = createSyncedCalendar();
  const result = calendar.run({
    items: [seriesA],
    storageFault: ({ op }) => {
      if (op === 'getProperties') throw new Error('You do not have permission to perform that action.');
    },
  });

  assert.ok(result.error);
  assert.match(String(result.error.message), /permission/, '原因の文言をそのまま失敗通知メールへ渡す');
  assert.ok(!result.logs.some((l) => /再試行します/.test(l)), '設定不備を再試行のログで埋もれさせない');
});

test('文言に心当たりが無いエラーは一時障害として再試行する', () => {
  const calendar = createSyncedCalendar();
  let failures = 0;
  const result = calendar.run({
    items: [seriesA],
    // 一時障害の文言を挙げ漏らすと再試行が効かなくなるので、既定は再試行する側
    storageFault: ({ op }) => {
      if (op === 'getProperties' && failures++ < 2) throw new Error('Service unavailable. Please try again.');
    },
  });

  assert.equal(result.error, null);
  assert.equal(result.posts.length, 1);
});

test('Slack投稿の再試行は「投稿し終えた」数に数えない', () => {
  const calendar = createSyncedCalendar();
  const result = calendar.run({ items: [single], slackStatus: 500 });

  assert.equal(result.requests.length, 3, '429/5xx は3回まで再試行する');
  assert.equal(result.posts.length, 0, '成功していない投稿を数えてはいけない');
  assert.ok(result.error);
});
