// src/Code.js は GAS 上で動くスクリプトなので、テストでは GAS のグローバルを差し替えて実行する。
// カレンダーの応答とスクリプト プロパティを与え、Slackへ何が投稿されたかを見る。
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const SOURCE = readFileSync(fileURLToPath(new URL('../src/Code.js', import.meta.url)), 'utf8');

export const DEFAULT_NOW = new Date('2026-08-14T11:46:00+09:00');
export const CALENDAR_ID = 'cal@example.com';

/**
 * スクリプト プロパティを持ち回せるカレンダー環境。
 * `run()` を複数回呼べば、指紋を引き継いだ2回目以降の実行を再現できる。
 */
export function createCalendar({ properties = {}, now = DEFAULT_NOW } = {}) {
  const store = new Map(Object.entries({
    CALENDAR_ID: CALENDAR_ID,
    SLACK_WEBHOOK_URL: 'https://hooks.slack.com/services/T/B/x',
    ...properties,
  }));

  const scriptProperties = {
    getProperty: (key) => (store.has(key) ? store.get(key) : null),
    setProperty: (key, value) => { store.set(key, String(value)); },
    deleteProperty: (key) => { store.delete(key); },
  };

  function buildSandbox({ items, listImpl, slackStatus, lockHeld, logs, posts }) {
    let listCalls = 0;
    return {
      console: {
        log: (m) => logs.push(String(m)),
        warn: (m) => logs.push(String(m)),
        error: (m) => logs.push(String(m)),
      },
      // 「今」を固定する。過去回の除外が実行日に左右されないようにするため
      Date: class extends Date {
        constructor(...args) { super(...(args.length ? args : [now])); }
      },
      PropertiesService: { getScriptProperties: () => scriptProperties },
      // lockHeld: true で「もう一方が動いている」状況を作る
      LockService: { getScriptLock: () => ({ tryLock: () => !lockHeld, releaseLock: () => {} }) },
      Calendar: {
        Events: {
          list: (calendarId, params) => {
            listCalls++;
            if (listImpl) return listImpl(calendarId, params, listCalls);
            return { summary: 'テストカレンダー', items: items, nextSyncToken: 'tok-' + listCalls };
          },
          get: (calendarId, eventId) => ({ summary: '親イベント', id: eventId }),
        },
      },
      Session: { getScriptTimeZone: () => 'Asia/Tokyo' },
      Utilities: {
        formatDate: (d, timeZone) => new Intl.DateTimeFormat('sv-SE', { timeZone }).format(d),
        sleep: () => {},
        DigestAlgorithm: { MD5: 'MD5' },
        Charset: { UTF_8: 'UTF-8' },
        // GAS は符号付きバイト配列を返す。src 側の & 0xff がそれ前提なので合わせる
        computeDigest: (_algorithm, text) => Array.from(createHash('md5').update(text, 'utf8').digest())
          .map((b) => (b > 127 ? b - 256 : b)),
      },
      UrlFetchApp: {
        fetch: (url, options) => {
          posts.push(JSON.parse(options.payload).text);
          return { getResponseCode: () => slackStatus, getContentText: () => 'ok' };
        },
      },
    };
  }

  function evaluate({ items = [], listImpl, slackStatus = 200, lockHeld = false, call }) {
    const logs = [];
    const posts = [];
    const sandbox = buildSandbox({ items, listImpl, slackStatus, lockHeld, logs, posts });
    vm.createContext(sandbox);
    vm.runInContext(SOURCE, sandbox);
    let error = null;
    try {
      sandbox[call]();
    } catch (e) {
      error = e;
    }
    return { posts, logs, error, sandbox, properties: Object.fromEntries(store) };
  }

  return {
    /** notifyCalendarChanges() を1回動かす */
    run: (options = {}) => evaluate({ ...options, call: 'notifyCalendarChanges' }),
    /** initialize() を1回動かす */
    initialize: (options = {}) => evaluate({ ...options, call: 'initialize' }),
    /** primeFingerprints() を1回動かす */
    prime: (options = {}) => evaluate({ ...options, call: 'primeFingerprints' }),
    /** 内部関数を直接呼ぶためのコンテキスト */
    context: () => evaluate({ call: 'getConfig_' }).sandbox,
    property: (key) => (store.has(key) ? store.get(key) : null),
    setProperty: (key, value) => store.set(key, value),
  };
}

/** 差分同期が動く状態（＝基準点がある）のカレンダーを作る */
export function createSyncedCalendar(options = {}) {
  return createCalendar({
    ...options,
    properties: { ['SYNC_TOKEN:' + CALENDAR_ID]: 'tok-0', ...(options.properties || {}) },
  });
}

/** 通知の見出し（1行目）だけ取り出す */
export function headlines(posts) {
  return posts.map((p) => p.split('\n')[0]);
}
