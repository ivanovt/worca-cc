#!/usr/bin/env node
/**
 * worca-notify send shim.
 *
 * Parses args, builds a NormalizedMessage, POSTs to the running worca-ui
 * server's /api/integrations/send endpoint, prints per-platform results.
 *
 * Never prints credentials or raw error bodies that might embed tokens.
 *
 * Usage:
 *   node send.mjs --title "X" --text "Y" [--severity info] [--platform telegram] [--chat-id 123]
 *   echo "long body" | node send.mjs --title "X" --severity success
 *
 * Exit codes:
 *   0 — at least one platform succeeded
 *   1 — every platform failed
 *   2 — caller error (bad args, empty body, UI server unreachable)
 */

import process from 'node:process';

function parseArgs(argv) {
  const out = {
    title: null,
    text: null,
    severity: 'info',
    platforms: [],
    chatId: null,
    uiPort: process.env.WORCA_UI_PORT || '3400',
    uiHost: process.env.WORCA_UI_HOST || '127.0.0.1',
  };
  const VALID_SEVERITIES = ['info', 'success', 'warning', 'error'];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = () => argv[++i];
    switch (a) {
      case '--title':
        out.title = v();
        break;
      case '--text':
        out.text = v();
        break;
      case '--severity':
        out.severity = v();
        break;
      case '--platform':
        out.platforms.push(v());
        break;
      case '--chat-id':
        out.chatId = v();
        break;
      case '--ui-port':
        out.uiPort = v();
        break;
      case '--ui-host':
        out.uiHost = v();
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
        break;
      default:
        fail(`unknown argument: ${a}`);
    }
  }

  if (!VALID_SEVERITIES.includes(out.severity)) {
    fail(
      `--severity must be one of ${VALID_SEVERITIES.join('/')} (got: ${out.severity})`,
    );
  }
  return out;
}

function printHelp() {
  process.stdout.write(`worca-notify — send a chat notification through the worca-ui adapters

USAGE:
  node send.mjs [OPTIONS]
  echo "body" | node send.mjs [OPTIONS]

OPTIONS:
  --title <str>        Title (rendered bold per-platform)
  --text <str>         Body text (mutually exclusive with stdin)
  --severity <level>   info / success / warning / error  (default: info)
  --platform <name>    Repeatable. Default: all enabled chat adapters
  --chat-id <str>      Override the configured chat_id
  --ui-port <int>      worca-ui server port (default: 3400 or WORCA_UI_PORT)
  --ui-host <host>     worca-ui server host (default: 127.0.0.1 or WORCA_UI_HOST)
  -h, --help           Show this help

EXIT CODES:
  0  at least one platform succeeded
  1  every platform failed
  2  caller error (bad args, empty body, server unreachable)
`);
}

function fail(msg) {
  process.stderr.write(`worca-notify: ${msg}\n`);
  process.exit(2);
}

async function readStdin() {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8').replace(/\n$/, '');
}

function buildMessage({ title, text, severity }) {
  // The body is a plain-text segment — adapters' renderers handle escaping
  // per-platform (Telegram HTML, Discord Markdown, Slack mrkdwn). We don't
  // emit `markdown` segments because the input is user-provided free text
  // and we shouldn't try to interpret it cross-platform.
  return {
    title: title || null,
    severity,
    body: [{ kind: 'text', value: text }],
  };
}

async function postSend({ uiHost, uiPort, platforms, message, chatId }) {
  const url = `http://${uiHost}:${uiPort}/api/integrations/send`;
  const body = {
    message,
    ...(platforms.length > 0 ? { platforms } : {}),
    ...(chatId ? { chat_id: chatId } : {}),
  };

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    fail(
      `cannot reach worca-ui server at ${uiHost}:${uiPort} — is it running? (${err.message})`,
    );
  }

  let payload;
  try {
    payload = await res.json();
  } catch {
    fail(`server returned non-JSON (HTTP ${res.status})`);
  }

  if (!res.ok) {
    fail(`server error (HTTP ${res.status}): ${payload.error ?? 'unknown'}`);
  }
  return payload;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // Resolve body: --text wins, otherwise read stdin
  let bodyText = args.text;
  if (bodyText === null) {
    bodyText = await readStdin();
  }
  if (!bodyText || bodyText.trim() === '') {
    fail(
      'message body is empty — provide --text "..." or pipe content via stdin',
    );
  }

  const message = buildMessage({
    title: args.title,
    text: bodyText,
    severity: args.severity,
  });

  const { results } = await postSend({
    uiHost: args.uiHost,
    uiPort: args.uiPort,
    platforms: args.platforms,
    message,
    chatId: args.chatId,
  });

  if (!Array.isArray(results) || results.length === 0) {
    process.stdout.write('worca-notify: no platforms targeted\n');
    process.exit(1);
  }

  let okCount = 0;
  for (const r of results) {
    if (r.ok) {
      okCount++;
      process.stdout.write(`  ok    ${r.platform.padEnd(8)}  — sent\n`);
    } else {
      process.stdout.write(
        `  fail  ${r.platform.padEnd(8)}  — ${r.error ?? 'unknown error'}\n`,
      );
    }
  }
  process.exit(okCount > 0 ? 0 : 1);
}

main().catch((err) => {
  fail(`unexpected error: ${err?.message ?? err}`);
});
