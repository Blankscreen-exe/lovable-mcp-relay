/**
 * End-to-end check of the relay against the real Lovable server.
 *
 * It starts its own relay on a spare port, drives a complete MCP handshake
 * through it -- including the notification that hangs when you talk to Lovable
 * directly -- and fails loudly if anything stalls or comes back wrong.
 *
 *   npm run selftest
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.SELFTEST_PORT ?? 8799);
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;
let failed = 0;

function check(name, ok, detail = '') {
  if (ok) {
    passed++;
    console.log('  PASS  ' + name + (detail ? '  (' + detail + ')' : ''));
  } else {
    failed++;
    console.log('  FAIL  ' + name + (detail ? '  (' + detail + ')' : ''));
  }
}

const HEADERS = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
  'mcp-protocol-version': '2025-06-18',
};

/**
 * Send one JSON-RPC message and read the reply to completion.
 *
 * `cap` is the point at which we give up waiting for the body to end. Reaching
 * it is itself the failure we are testing for: it means something is hanging.
 */
async function rpc(message, cap = 20000) {
  const started = Date.now();
  const res = await fetch(BASE + '/', {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify(message),
  });

  let text = '';
  let bodyEnded = false;
  if (res.body) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const giveUp = new Promise((resolve) => setTimeout(() => resolve('CAP'), cap));
    for (;;) {
      const next = await Promise.race([reader.read(), giveUp]);
      if (next === 'CAP') break;
      if (next.done) {
        bodyEnded = true;
        break;
      }
      text += decoder.decode(next.value, { stream: true });
    }
    if (!bodyEnded) reader.cancel().catch(() => {});
  } else {
    bodyEnded = true;
  }

  let json = null;
  const sse = text.match(/^data: (.*)$/m);
  try {
    json = JSON.parse(sse ? sse[1] : text);
  } catch {}

  return { status: res.status, bodyEnded, ms: Date.now() - started, json, bytes: text.length };
}

function startRelay() {
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'relay.mjs')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const lines = [];
  child.stdout.on('data', (d) => lines.push(d.toString()));
  child.stderr.on('data', (d) => lines.push(d.toString()));
  return { child, lines };
}

async function waitForRelay(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(BASE + '/healthz');
      if (res.ok) return await res.json();
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('relay did not come up in time');
}

const { child, lines } = startRelay();

try {
  console.log('\nlovable-mcp-relay selftest\n');

  const health = await waitForRelay();
  check('relay starts and answers /healthz', health.relay === 'ok');
  check('a usable Lovable login was found', health.auth?.ok === true, health.auth?.error ?? health.auth?.source);
  check(
    'access token is not already expired',
    (health.auth?.minutesRemaining ?? -1) > -1,
    (health.auth?.minutesRemaining ?? '?') + ' min left'
  );

  const init = await rpc({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'relay-selftest', version: '1.0.0' },
    },
  });
  check('initialize returns 200', init.status === 200, init.ms + 'ms');
  check('initialize body terminates', init.bodyEnded);
  check(
    'server identifies itself',
    Boolean(init.json?.result?.serverInfo?.name),
    init.json?.result?.serverInfo
      ? init.json.result.serverInfo.name + ' ' + init.json.result.serverInfo.version
      : 'no serverInfo'
  );

  // The whole reason this relay exists. Talking to Lovable directly, this
  // reply never finishes and the client hangs until it gives up.
  const note = await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, 10000);
  check('notifications/initialized returns 202', note.status === 202, note.ms + 'ms');
  check('>>> the hanging reply now TERMINATES <<<', note.bodyEnded, note.ms + 'ms');
  check('...and it terminates promptly', note.bodyEnded && note.ms < 5000, note.ms + 'ms');

  const tools = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const toolCount = tools.json?.result?.tools?.length ?? 0;
  check('tools/list returns 200', tools.status === 200, tools.ms + 'ms');
  check('tools/list body terminates', tools.bodyEnded);
  check('tools are listed', toolCount > 0, toolCount + ' tools');
  check('a large streamed body arrives intact', tools.bytes > 10000, tools.bytes + ' bytes');

  const resources = await rpc({ jsonrpc: '2.0', id: 3, method: 'resources/list' });
  check('resources/list works', resources.status === 200 && resources.bodyEnded);

  const prompts = await rpc({ jsonrpc: '2.0', id: 4, method: 'prompts/list' });
  check('prompts/list works', prompts.status === 200 && prompts.bodyEnded);

  // A real, read-only tool call: proves the token is actually being attached.
  const me = await rpc({
    jsonrpc: '2.0',
    id: 5,
    method: 'tools/call',
    params: { name: 'get_me', arguments: {} },
  });
  const meText = me.json?.result?.content?.map((c) => c.text).join('') ?? '';
  check('an authenticated tool call succeeds', me.status === 200 && !me.json?.error, me.ms + 'ms');
  check('it returns real account data', meText.includes('email'), meText.slice(0, 40).replace(/\s+/g, ' '));

  // MCP clients open this to listen for server-initiated messages. Lovable
  // does not support it and says so with a 405, which is fine -- what matters
  // is that the answer arrives instead of hanging.
  const getStream = await fetch(BASE + '/', {
    method: 'GET',
    headers: { accept: 'text/event-stream', 'mcp-protocol-version': '2025-06-18' },
  });
  await getStream.text();
  check('GET / answers instead of hanging', getStream.status === 405, 'status ' + getStream.status);

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed === 0) console.log('The relay is working. Point .mcp.json at it and restart Claude Code.\n');
} catch (err) {
  failed++;
  console.error('\nselftest crashed:', err.message, '\n');
  console.error('relay output:\n' + lines.join(''));
} finally {
  child.kill();
}

process.exit(failed === 0 ? 0 : 1);
