import http from 'node:http';
import { Readable } from 'node:stream';
import { UPSTREAM, PORT, HOST, UPSTREAM_TIMEOUT_MS, LOG_BODIES } from './config.mjs';
import { getAccessToken, refreshNow, authStatus, AuthError } from './auth.mjs';
import { log, redact } from './log.mjs';
import { handleUi, uiBanner } from './ui.mjs';
import { openUi } from './open.mjs';

/**
 * Headers that describe one hop of a connection rather than the message itself.
 * A proxy must not copy these in either direction.
 */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
]);

function requestHeaders(clientHeaders, token) {
  const out = {};
  for (const [k, v] of Object.entries(clientHeaders)) {
    const key = k.toLowerCase();
    if (HOP_BY_HOP.has(key)) continue;
    if (key === 'authorization') continue; // we supply our own
    if (key === 'cookie') continue; // nothing upstream needs a cookie from us
    if (key === 'accept-encoding') continue; // fetch negotiates its own
    out[key] = Array.isArray(v) ? v.join(', ') : v;
  }
  out.authorization = `Bearer ${token}`;
  // Cloudflare sits in front of Lovable and rejects some agent strings
  // outright (a bare Python one gets a 403 after a 30s stall), so identify
  // as something ordinary and known-good.
  out['user-agent'] = 'lovable-mcp-relay/1.0 (node)';
  return out;
}

function responseHeaders(upstream) {
  const out = {};
  for (const [k, v] of upstream.headers) {
    const key = k.toLowerCase();
    if (HOP_BY_HOP.has(key)) continue;
    // fetch has already decompressed the body, so upstream's encoding and
    // length no longer describe what we are about to send. Forwarding them
    // would make the client try to gunzip plain text.
    if (key === 'content-encoding' || key === 'content-length') continue;
    if (key === 'set-cookie') continue; // the client here is not a browser
    out[key] = v;
  }
  return out;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** True if the payload contains a request expecting a response (it has an id). */
function carriesId(body) {
  if (!body?.length) return false;
  try {
    const parsed = JSON.parse(body.toString('utf8'));
    const all = Array.isArray(parsed) ? parsed : [parsed];
    return all.some((m) => m && 'id' in m && m.id !== null && m.id !== undefined);
  } catch {
    return false;
  }
}

/** Pull the JSON-RPC method name out of a buffered body, for the log line. */
function rpcMethod(body) {
  if (!body?.length) return null;
  try {
    const parsed = JSON.parse(body.toString('utf8'));
    const one = Array.isArray(parsed) ? parsed[0] : parsed;
    if (!one?.method) return null;
    const tool = one.params?.name;
    return tool ? `${one.method}(${tool})` : one.method;
  } catch {
    return null;
  }
}

async function forward({ req, body, token }) {
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)]);
  const upstream = await fetch(UPSTREAM + req.url, {
    method: req.method,
    headers: requestHeaders(req.headers, token),
    body: body.length ? body : undefined,
    signal,
    redirect: 'manual',
  });
  return { upstream, controller };
}

async function handleProxy(req, res, started) {
  const body = await readBody(req);
  const rpc = rpcMethod(body);
  if (LOG_BODIES && body.length) log.info('->', redact(body.toString('utf8')).slice(0, 600));

  let token = await getAccessToken();
  let { upstream, controller } = await forward({ req, body, token });

  // The token can be rejected even when we thought it was fresh (revoked
  // early, or a clock that disagrees). One forced refresh and one retry.
  if (upstream.status === 401) {
    upstream.body?.cancel().catch(() => {});
    log.warn('upstream returned 401; forcing a token refresh and retrying once');
    token = await refreshNow();
    ({ upstream, controller } = await forward({ req, body, token }));
  }

  /*
   * THE REPAIR.
   *
   * Lovable answers a JSON-RPC notification (such as notifications/initialized,
   * the "I am ready" message that ends the handshake) with:
   *
   *     HTTP/1.1 202 Accepted
   *     transfer-encoding: chunked
   *
   * ...and then never sends a single byte of that body, and never sends the
   * zero-length chunk that means "finished". On a keep-alive connection the
   * client has no way to know the reply is over, so it waits forever. Claude
   * Code reads that body to the end before it treats the handshake as done, so
   * it hangs and eventually reports a 30-second connection timeout.
   *
   * The MCP spec says a 202 for an accepted notification carries no body at
   * all, so the correct reply is an empty one that is properly terminated.
   * We drop the upstream body (there is nothing in it, and waiting on it is
   * the whole bug) and send a clean, complete 202 instead.
   */
  if (upstream.status === 202) {
    // Let go of the body we are never going to read, which frees the socket
    // upstream is holding open. Cancel rather than abort: aborting rejects the
    // body's pending read with nobody listening, and an unhandled rejection
    // takes the whole relay down with it.
    upstream.body?.cancel().catch(() => {});
    // Build this reply from scratch rather than copying upstream's headers.
    // An accepted notification has no body, so none of Cloudflare's caching,
    // CORS or tracing headers mean anything here -- and copying them is how a
    // stray framing header sneaks back in and recreates the hang.
    /*
     * Why this reply closes the connection.
     *
     * The obvious repair is a 202 with "content-length: 0", and that is what
     * this process writes. On this machine something between the relay and the
     * client rewrites that header into "transfer-encoding: chunked" -- the same
     * framing Lovable used -- while leaving every other header untouched. A
     * chunked reply with no terminating chunk is exactly the hang we are here
     * to fix, so we must not depend on a length header surviving the trip.
     *
     * "Connection: close" removes that dependence. Under HTTP/1.1 the end of
     * the connection is also the end of the body, so the client sees a complete
     * reply whichever framing it was handed. It costs one extra connection per
     * notification, which is a handful per session.
     */
    // A 202 means "accepted, no reply coming", which is only correct for a
    // notification. If one ever comes back for a message carrying an id, the
    // client is waiting for a response it will never get -- say so out loud
    // rather than quietly papering over it.
    if (carriesId(body)) {
      log.warn(
        `upstream returned 202 for ${rpc ?? 'a request'} that carries an id; ` +
          'the client is expecting a response and will not receive one'
      );
    }

    res.setHeader('content-length', '0');
    res.setHeader('connection', 'close');
    const sessionId = upstream.headers.get('mcp-session-id');
    if (sessionId) res.setHeader('mcp-session-id', sessionId);
    res.writeHead(202);
    res.end();
    log.call({
      method: req.method,
      rpc,
      status: 202,
      ms: Date.now() - started,
      note: 'repaired (upstream body never terminates)',
    });
    return;
  }

  /*
   * MCP clients open a GET stream to listen for messages the server starts.
   * Lovable does not offer one and answers 405, which is a perfectly good
   * answer -- but it serialises that reply incorrectly too: the chunked body
   * has a corrupt chunk size, so a strict HTTP client rejects it outright
   * ("Invalid character in chunk size"). Lenient clients like curl never
   * noticed.
   *
   * The body is a human-readable sentence with no protocol meaning; the status
   * code is the entire message. So we pass the status and the Allow header
   * through with a clean empty body rather than forwarding a reply the client
   * cannot parse.
   */
  if (upstream.status === 405) {
    upstream.body?.cancel().catch(() => {});
    res.setHeader('content-length', '0');
    res.setHeader('connection', 'close'); // see the note on the 202 above
    const allow = upstream.headers.get('allow');
    if (allow) res.setHeader('allow', allow);
    res.writeHead(405);
    res.end();
    log.call({
      method: req.method,
      rpc,
      status: 405,
      ms: Date.now() - started,
      note: 'no server-initiated stream (upstream body is malformed; dropped)',
    });
    return;
  }

  // From here we are streaming a real body, so abandon the upstream call if
  // the client hangs up on us part way through.
  const onClose = () => controller.abort();
  res.on('close', onClose);

  res.writeHead(upstream.status, responseHeaders(upstream));
  // Server-sent events must reach the client as they arrive, not in a lump.
  res.flushHeaders();
  req.socket.setNoDelay(true);

  if (!upstream.body) {
    res.end();
  } else {
    await new Promise((resolve) => {
      const stream = Readable.fromWeb(upstream.body);
      stream.on('error', (e) => {
        if (!controller.signal.aborted) log.warn('upstream stream error:', e.message);
        // Tear the response down rather than ending it neatly. Ending neatly
        // would hand the client a truncated body that looks complete, and a
        // silently short tools/list is far worse than a visible failure.
        res.destroy();
        resolve();
      });
      res.on('error', () => resolve());
      res.on('finish', resolve);
      stream.pipe(res);
    });
  }

  res.off('close', onClose);
  log.call({ method: req.method, rpc, status: upstream.status, ms: Date.now() - started });
}

const server = http.createServer(async (req, res) => {
  const started = Date.now();

  if (req.url === '/healthz') {
    const auth = authStatus();
    const payload = { relay: 'ok', upstream: UPSTREAM, auth };
    const text = JSON.stringify(payload, null, 2);
    // Without a usable login the relay is running but cannot serve anything,
    // so report that as unhealthy rather than a cheerful 200.
    res.writeHead(auth.ok ? 200 : 503, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(text),
      connection: 'close',
    });
    res.end(text);
    return;
  }

  // The setup page and its API are served locally and never forwarded.
  if (req.url === "/ui" || req.url.startsWith("/ui/") || req.url.startsWith("/api/") || req.url === "/favicon.ico") {
    try {
      if (await handleUi(req, res)) return;
    } catch (err) {
      log.error("ui failure: " + redact(String(err?.stack ?? err)));
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
      if (!res.writableEnded) res.end(JSON.stringify({ error: "The setup page hit an error." }));
      return;
    }
  }

  try {
    await handleProxy(req, res, started);
  } catch (err) {
    const isAuth = err instanceof AuthError;
    const aborted = err?.name === 'AbortError' || err?.name === 'TimeoutError';
    if (aborted) {
      log.call({
        method: req.method,
        rpc: null,
        status: 'abrt',
        ms: Date.now() - started,
        note: 'upstream timed out or client disconnected',
      });
      if (!res.headersSent) res.writeHead(504, { 'content-type': 'application/json' });
      if (!res.writableEnded) {
        res.end(JSON.stringify({ error: 'upstream timed out or client disconnected' }));
      }
      return;
    }
    log.error(isAuth ? 'auth: ' + err.message : 'proxy failure: ' + redact(String(err?.stack || err)));
    if (!res.headersSent) {
      // A real status code, not a hang. Whatever goes wrong here, the client
      // gets an answer -- silently stalling is the bug we exist to fix.
      res.writeHead(isAuth ? 401 : 502, { 'content-type': 'application/json' });
    }
    if (!res.writableEnded) {
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: err.message }, id: null }));
    }
  }
});

server.requestTimeout = 0; // long agent calls are legitimate
server.headersTimeout = 60_000;

/*
 * A relay that dies mid-session is worse than one that logs and carries on.
 * Every request already has its own try/catch, so anything reaching here is a
 * stray from a cancelled stream, not state we need to protect.
 */
process.on('unhandledRejection', (reason) => {
  log.warn('unhandled rejection (ignored):', redact(String(reason?.message ?? reason)));
});
process.on('uncaughtException', (err) => {
  log.error('uncaught exception (ignored):', redact(String(err?.stack ?? err)));
});

if (!['127.0.0.1', 'localhost', '::1'].includes(HOST)) {
  // The relay attaches a live Lovable token to every request it forwards.
  // Listening anywhere but loopback would hand that power to the network.
  log.error(`refusing to bind ${HOST}: this relay holds a live token and must stay on loopback.`);
  process.exit(1);
}

server.listen(PORT, HOST, () => {
  log.info(`relay listening on http://${HOST}:${PORT}  ->  ${UPSTREAM}`);
  const status = authStatus();
  if (status.ok) {
    log.info(`token source: ${status.source}, valid for ${status.minutesRemaining} min`);
  } else {
    log.warn(`no usable login yet: ${status.error}`);
  }
  log.info(`setup page: ${uiBanner()}`);

  // Started from a launcher (or with --open): bring the page up for them.
  if (process.env.OPEN_UI === '1' || process.argv.includes('--open')) {
    openUi(uiBanner());
  }
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log.info('shutting down');
    server.close(() => process.exit(0));
  });
}
