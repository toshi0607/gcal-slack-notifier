#!/usr/bin/env node
/**
 * gcal-slack-notifier が投稿した通知メッセージを一括削除する運用スクリプト。
 *
 * 通知の大量発生でチャンネルが埋まった場合の後片付け用。
 * 既定は dry-run。実際に削除するには --execute を付ける。
 *
 * 必要なもの:
 *   Slack のユーザートークン（xoxp-...）で chat:write スコープを持つもの。
 *   他人（アプリ）の投稿を削除できるのはワークスペースのオーナー / 管理者のみ。
 *   発行手順: https://api.slack.com/apps → 対象アプリ → OAuth & Permissions
 *     → User Token Scopes に chat:write を追加 → Reinstall to Workspace
 *     → "User OAuth Token" をコピー
 *
 * 使い方:
 *   SLACK_TOKEN=xoxp-... node scripts/delete-slack-messages.mjs --channel C0123456789
 *   SLACK_TOKEN=xoxp-... node scripts/delete-slack-messages.mjs --channel C0123456789 --execute
 *
 * オプション:
 *   --channel <id>   対象チャンネルID（必須）
 *   --oldest <ts>    この Unix 秒以降のメッセージだけを対象にする
 *   --latest <ts>    この Unix 秒以前のメッセージだけを対象にする
 *   --execute        実際に削除する（省略時は対象を表示するだけ）
 *   --all-bot        テキストのパターンに関係なく、このアプリのbot投稿をすべて対象にする
 */

const SLACK_API = 'https://slack.com/api';

// gcal-slack-notifier が出す通知の本文パターン。人間の発言を誤って消さないための安全弁
const NOTIFICATION_PATTERN = /予定が(追加|更新|削除)されました|カレンダーの変更を \d+件 検知しました/;

// chat.delete は Tier 3（50回/分）。余裕をみて 1.2 秒間隔で回す
const DELETE_INTERVAL_MS = 1200;

function parseArgs(argv) {
  const args = { execute: false, allBot: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--channel') args.channel = argv[++i];
    else if (a === '--oldest') args.oldest = argv[++i];
    else if (a === '--latest') args.latest = argv[++i];
    else if (a === '--execute') args.execute = true;
    else if (a === '--all-bot') args.allBot = true;
    else throw new Error('不明な引数: ' + a);
  }
  if (!args.channel) throw new Error('--channel <id> を指定してください');
  return args;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function slack(token, method, params) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${SLACK_API}/${method}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify(params),
    });
    if (res.status === 429) {
      const wait = Number(res.headers.get('retry-after') || 30) * 1000;
      console.error(`  rate limited: ${wait / 1000}秒待機`);
      await sleep(wait);
      continue;
    }
    const body = await res.json();
    if (body.ok) return body;
    // 一時的なエラーのみ再試行する
    if (attempt < 2 && ['ratelimited', 'service_unavailable', 'internal_error'].includes(body.error)) {
      await sleep(2000);
      continue;
    }
    throw new Error(`${method} が失敗: ${body.error}`);
  }
}

async function collectTargets(token, args) {
  const targets = [];
  let cursor;
  let scanned = 0;
  do {
    const page = await slack(token, 'conversations.history', {
      channel: args.channel,
      limit: 200,
      cursor: cursor,
      oldest: args.oldest,
      latest: args.latest,
    });
    for (const m of page.messages || []) {
      scanned++;
      const isBot = Boolean(m.bot_id) || m.subtype === 'bot_message';
      if (!isBot) continue;
      if (!args.allBot && !NOTIFICATION_PATTERN.test(m.text || '')) continue;
      targets.push({ ts: m.ts, text: (m.text || '').replace(/\n/g, ' / ').slice(0, 60) });
    }
    cursor = page.response_metadata?.next_cursor || undefined;
  } while (cursor);
  return { targets, scanned };
}

async function main() {
  const token = process.env.SLACK_TOKEN;
  if (!token) throw new Error('環境変数 SLACK_TOKEN にユーザートークン（xoxp-...）を設定してください');
  const args = parseArgs(process.argv.slice(2));

  const { targets, scanned } = await collectTargets(token, args);
  console.log(`走査 ${scanned}件 / 削除対象 ${targets.length}件`);
  if (targets.length === 0) return;

  if (!args.execute) {
    for (const t of targets.slice(0, 10)) console.log(`  [dry-run] ${t.ts}  ${t.text}`);
    if (targets.length > 10) console.log(`  ... 他 ${targets.length - 10}件`);
    console.log('\n実際に削除するには --execute を付けて再実行してください。');
    return;
  }

  let deleted = 0;
  const failures = [];
  for (const t of targets) {
    try {
      await slack(token, 'chat.delete', { channel: args.channel, ts: t.ts });
      deleted++;
      if (deleted % 25 === 0) console.log(`  ${deleted}/${targets.length} 削除済み`);
    } catch (e) {
      failures.push({ ts: t.ts, reason: String(e.message) });
    }
    await sleep(DELETE_INTERVAL_MS);
  }
  console.log(`削除 ${deleted}件 / 失敗 ${failures.length}件`);
  for (const f of failures.slice(0, 20)) console.error(`  失敗 ${f.ts}: ${f.reason}`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
