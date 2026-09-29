/**
 * The setup page and the small JSON API behind it.
 *
 * Everything here is for a person sitting at this machine. It is deliberately
 * kept separate from the MCP path: the relay forwards `/` to Lovable and nothing
 * else, and these routes never carry CORS headers, so a browser will not let
 * another website read them.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PORT, HOST, ROOT } from './config.mjs';
import { authStatus, setToken, describeAccount, getAccessToken, AuthError } from './auth.mjs';
import { discover, preview, apply, revert, ConfigError } from './mcpconfig.mjs';
import { log } from './log.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const RELAY_URL = `http://${HOST}:${PORT}`;

/**
 * A fresh secret each time the relay starts, handed to the page it serves.
 *
 * Without this, any website open in the browser could quietly POST to
 * 127.0.0.1 and replace the token or rewrite an MCP config. A remote page
 * cannot read our page, so it cannot learn this value, and the browser will not
 * let it send the custom header either.
 */
const NONCE = crypto.randomBytes(24).toString('base64url');

/**
 * Something the person typed is wrong. Separate from a relay fault, because
 * one deserves a quiet 400 and a clear sentence, the other deserves a 500 and
 * a log entry.
 */
export class BadInput extends Error {
  constructor(message) {
    super(message);
    this.name = 'BadInput';
  }
}

const JSON_HEADERS = { 'content-type': 'application/json', 'cache-control': 'no-store' };

function send(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { ...JSON_HEADERS, 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function authorised(req) {
  if (req.headers['x-relay-nonce'] !== NONCE) return false;
  // A form post from another site cannot set the header above, but check the
  // origin too so a mistake in one does not stand alone.
  const origin = req.headers.origin;
  if (origin && origin !== RELAY_URL && origin !== `http://localhost:${PORT}`) return false;
  return true;
}

function readBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new BadInput('Request too large.'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function jsonBody(req) {
  const text = await readBody(req);
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new BadInput('The request body was not valid JSON.');
  }
}

/**
 * Work out what someone pasted.
 *
 * People will paste whatever they have to hand: a saved chain file, a whole
 * Claude Code credentials file, or a bare token copied from a terminal. Accept
 * all three rather than making them reformat it.
 */
export function parseChain(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) throw new BadInput('Nothing was pasted.');

  if (!trimmed.startsWith('{')) {
    // A bare token. Tolerate a copied "Bearer " prefix and stray quotes.
    const bare = trimmed.replace(/^Bearer\s+/i, '').replace(/^["']|["']$/g, '');
    if (/\s/.test(bare)) {
      throw new BadInput('That does not look like a token or a saved chain. Paste one token, or the whole JSON file.');
    }
    return { accessToken: bare };
  }

  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new BadInput('That looks like JSON but could not be read. Paste the whole file, including both braces.');
  }

  // A whole Claude Code credentials file: pick the lovable entry out of it.
  if (parsed.mcpOAuth && typeof parsed.mcpOAuth === 'object') {
    const key = Object.keys(parsed.mcpOAuth).find((k) => k.toLowerCase().startsWith('lovable'));
    if (!key) throw new BadInput('That credentials file has no lovable login in it.');
    parsed = parsed.mcpOAuth[key];
  }

  const chain = {
    accessToken: parsed.accessToken ?? parsed.access_token ?? null,
    refreshToken: parsed.refreshToken ?? parsed.refresh_token ?? null,
    clientId: parsed.clientId ?? parsed.client_id ?? undefined,
    expiresAt: typeof parsed.expiresAt === 'number' ? parsed.expiresAt : undefined,
  };
  if (!chain.accessToken && !chain.refreshToken) {
    throw new BadInput('No access or refresh token found in what you pasted.');
  }
  return chain;
}

/** Account details change rarely; do not ask Lovable on every status poll. */
let accountCache = { at: 0, value: null };
const ACCOUNT_TTL_MS = 5 * 60 * 1000;

async function accountInfo() {
  if (Date.now() - accountCache.at < ACCOUNT_TTL_MS) return accountCache.value;
  let value = null;
  try {
    const token = await getAccessToken();
    const described = await describeAccount(token);
    value = described.ok ? described : null;
  } catch {
    value = null; // no usable login yet; the status block already says so
  }
  accountCache = { at: Date.now(), value };
  return value;
}

export function invalidateAccountCache() {
  accountCache = { at: 0, value: null };
}

/**
 * Drive a real handshake through this relay, so the page reports what a client
 * would actually experience rather than what we hope happens.
 */
async function runTest() {
  const steps = [];
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'mcp-protocol-version': '2025-06-18',
  };

  async function rpc(message, capMs = 15000) {
    const started = Date.now();
    const res = await fetch(RELAY_URL + '/', {
      method: 'POST',
      headers,
      body: JSON.stringify(message),
    });
    let text = '';
    let ended = false;
    if (res.body) {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const giveUp = new Promise((r) => setTimeout(() => r('CAP'), capMs));
      for (;;) {
        const next = await Promise.race([reader.read(), giveUp]);
        if (next === 'CAP') break;
        if (next.done) {
          ended = true;
          break;
        }
        text += decoder.decode(next.value, { stream: true });
      }
      if (!ended) reader.cancel().catch(() => {});
    } else {
      ended = true;
    }
    const line = text.match(/^data: (.*)$/m);
    let json = null;
    try {
      json = JSON.parse(line ? line[1] : text);
    } catch {}
    return { status: res.status, ended, ms: Date.now() - started, json, bytes: text.length };
  }

  try {
    const init = await rpc({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'relay-ui', version: '1.0.0' } },
    });
    const server = init.json?.result?.serverInfo;
    steps.push({
      name: 'Handshake opened',
      ok: init.status === 200 && Boolean(server),
      detail: server ? `${server.name} ${server.version} · ${init.ms}ms` : `status ${init.status}`,
    });

    const note = await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, 8000);
    steps.push({
      name: 'The reply that normally hangs now finishes',
      ok: note.status === 202 && note.ended && note.ms < 5000,
      detail: note.ended ? `${note.ms}ms` : 'still hanging',
    });

    const tools = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const count = tools.json?.result?.tools?.length ?? 0;
    steps.push({
      name: 'Tools listed',
      ok: tools.status === 200 && tools.ended && count > 0,
      detail: count ? `${count} tools · ${tools.bytes} bytes · ${tools.ms}ms` : `status ${tools.status}`,
    });

    const me = await rpc({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'get_me', arguments: {} },
    });
    const body = me.json?.result?.content?.map((c) => c.text).join('') ?? '';
    steps.push({
      name: 'Authenticated call returns your account',
      ok: me.status === 200 && body.includes('email'),
      detail: me.status === 200 && body.includes('email') ? `${me.ms}ms` : `status ${me.status}`,
    });
  } catch (err) {
    steps.push({ name: 'Test could not finish', ok: false, detail: err.message });
  }

  return { steps, passed: steps.every((s) => s.ok) };
}

/**
 * Handle a UI or API request. Returns true when it took the request, so the
 * relay knows not to forward it to Lovable.
 */
export async function handleUi(req, res) {
  const url = new URL(req.url, RELAY_URL);
  const route = url.pathname;

  if (route === '/ui' || route === '/ui/') {
    const html = fs
      .readFileSync(path.join(HERE, 'ui.html'), 'utf8')
      .replaceAll('{{NONCE}}', NONCE)
      .replaceAll('{{RELAY_URL}}', RELAY_URL);
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': Buffer.byteLength(html),
      'cache-control': 'no-store',
      // This page holds the setup secret; never let it be framed or cached.
      'x-frame-options': 'DENY',
      'referrer-policy': 'no-referrer',
    });
    res.end(html);
    return true;
  }

  // A stray browser request for an icon is not MCP traffic and must not be
  // forwarded to Lovable.
  if (route === '/favicon.ico') {
    res.writeHead(204, { 'cache-control': 'max-age=86400' });
    res.end();
    return true;
  }

  if (!route.startsWith('/api/')) return false;

  if (!authorised(req)) {
    send(res, 403, { error: 'Open this page at ' + RELAY_URL + '/ui and try again.' });
    return true;
  }

  try {
    if (route === '/api/status' && req.method === 'GET') {
      const status = authStatus();
      send(res, 200, {
        relay: { url: RELAY_URL, port: PORT },
        auth: status,
        account: status.ok ? await accountInfo() : null,
      });
      return true;
    }

    if (route === '/api/token' && req.method === 'POST') {
      const { text } = await jsonBody(req);
      const chain = parseChain(text);
      const result = await setToken(chain);
      invalidateAccountCache();
      send(res, 200, result);
      return true;
    }

    if (route === '/api/test' && req.method === 'POST') {
      send(res, 200, await runTest());
      return true;
    }

    if (route === '/api/connections' && req.method === 'GET') {
      send(res, 200, discover());
      return true;
    }

    if (route === '/api/connections/preview' && req.method === 'POST') {
      const { path: file } = await jsonBody(req);
      send(res, 200, preview(file, RELAY_URL));
      return true;
    }

    if (route === '/api/connections/apply' && req.method === 'POST') {
      const { path: file } = await jsonBody(req);
      send(res, 200, apply(file, RELAY_URL));
      return true;
    }

    if (route === '/api/connections/revert' && req.method === 'POST') {
      const { path: file } = await jsonBody(req);
      send(res, 200, revert(file));
      return true;
    }

    send(res, 404, { error: 'No such endpoint.' });
    return true;
  } catch (err) {
    const known = err instanceof AuthError || err instanceof ConfigError || err instanceof BadInput;
    if (!known) log.warn('ui error on ' + route + ': ' + err.message);
    send(res, known ? 400 : 500, { error: err.message });
    return true;
  }
}

export function uiBanner() {
  return `${RELAY_URL}/ui`;
}
