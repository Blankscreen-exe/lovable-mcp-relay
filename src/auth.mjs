import fs from 'node:fs';
import {
  CLAUDE_CREDENTIALS,
  TOKEN_CACHE,
  TOKEN_ENDPOINT,
  RESOURCE,
  REFRESH_SKEW_MS,
  UPSTREAM,
  DEFAULT_CLIENT_ID,
} from './config.mjs';
import { log } from './log.mjs';

export class AuthError extends Error {
  constructor(message, { retryable = false } = {}) {
    super(message);
    this.name = 'AuthError';
    this.retryable = retryable;
  }
}

/** In-memory current token. Shape: { accessToken, refreshToken, expiresAt, clientId, source } */
let current = null;
/** Single-flight guard so ten concurrent calls trigger one refresh, not ten. */
let inFlight = null;
let refreshCount = 0;
let lastRefreshAt = null;

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Claude Code stores the lovable login under a key like "lovable|<hash>". */
function fromClaudeCode() {
  const data = readJson(CLAUDE_CREDENTIALS);
  const store = data?.mcpOAuth;
  if (!store) return null;
  const key = Object.keys(store).find((k) => k.startsWith('lovable|'));
  if (!key) return null;
  const e = store[key];
  if (!e?.refreshToken) return null;
  return {
    accessToken: e.accessToken,
    refreshToken: e.refreshToken,
    expiresAt: e.expiresAt ?? 0,
    clientId: e.clientId,
    source: 'claude-code',
  };
}

function fromCache() {
  const e = readJson(TOKEN_CACHE);
  if (!e?.refreshToken) return null;
  return { ...e, source: 'relay-cache' };
}

/**
 * Pick the better of the two starting points.
 *
 * Whichever token expires later is the newer one: if the user logged in again
 * through Claude Code we want that, and if we refreshed we want ours. Comparing
 * expiry gets both cases right without having to guess who wrote last.
 */
function loadSeed() {
  const cached = fromCache();
  const claude = fromClaudeCode();
  if (cached && claude) return cached.expiresAt >= claude.expiresAt ? cached : claude;
  const seed = cached ?? claude;
  if (!seed) {
    throw new AuthError(
      'No Lovable login found. Point .mcp.json back at https://mcp.lovable.dev, run /mcp in Claude Code to log in, then switch it back to the relay.'
    );
  }
  return seed;
}

function persist(token) {
  const body = JSON.stringify(
    {
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      expiresAt: token.expiresAt,
      clientId: token.clientId,
      savedAt: new Date().toISOString(),
    },
    null,
    2
  );
  // 0600: owner only. Windows largely ignores the mode, but it costs nothing
  // and makes the file safe if this folder is ever copied to a POSIX machine.
  fs.writeFileSync(TOKEN_CACHE, body, { mode: 0o600 });
}

function isFresh(token) {
  return Boolean(token?.accessToken) && token.expiresAt - REFRESH_SKEW_MS > Date.now();
}

async function refresh(token) {
  const form = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: token.refreshToken,
    client_id: token.clientId,
    // RFC 8707: say which API the new token is for. Lovable publishes
    // protected-resource metadata, so it cares about this.
    resource: RESOURCE,
  });

  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
      // Cloudflare in front of Lovable blocks some default agent strings
      // outright, so we identify as a plain client.
      'user-agent': 'lovable-mcp-relay',
    },
    body: form,
  });

  const text = await res.text();
  if (!res.ok) {
    let detail = text.slice(0, 200);
    try {
      const j = JSON.parse(text);
      detail = [j.error, j.error_description].filter(Boolean).join(': ') || detail;
    } catch {}
    // invalid_grant means the refresh token is spent or revoked: no amount of
    // retrying fixes it, the user has to log in again.
    const dead = res.status === 400 || res.status === 401;
    throw new AuthError(
      `Token refresh failed (${res.status}): ${detail}` +
        (dead
          ? '\n  -> The saved login is no longer valid. Point .mcp.json back at https://mcp.lovable.dev, run /mcp to log in, then switch back to the relay.'
          : ''),
      { retryable: !dead }
    );
  }

  const body = JSON.parse(text);
  if (!body.access_token) throw new AuthError('Token endpoint returned no access_token.');

  const next = {
    accessToken: body.access_token,
    // Rotation is optional: if the server did not hand back a new refresh
    // token, the old one stays valid and we must keep it.
    refreshToken: body.refresh_token ?? token.refreshToken,
    expiresAt: Date.now() + (Number(body.expires_in) || 3600) * 1000,
    clientId: token.clientId,
    source: 'refreshed',
  };

  persist(next);
  refreshCount += 1;
  lastRefreshAt = new Date().toISOString();
  log.info(
    `token refreshed; valid for ${Math.round((next.expiresAt - Date.now()) / 60000)} min` +
      (body.refresh_token ? ' (refresh token rotated)' : '')
  );
  return next;
}

/** Refresh at most once at a time, no matter how many callers ask. */
function refreshOnce(token) {
  if (!inFlight) {
    inFlight = refresh(token).finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
}

/** The access token to put on an upstream request. Refreshes if needed. */
export async function getAccessToken() {
  if (!current) current = loadSeed();
  if (isFresh(current)) return current.accessToken;
  current = await refreshOnce(current);
  return current.accessToken;
}

/**
 * Called when upstream rejects our token anyway (401). Forces one refresh so a
 * revoked-early or clock-skewed token recovers without restarting the relay.
 */
export async function refreshNow() {
  if (!current) current = loadSeed();
  current = await refreshOnce(current);
  return current.accessToken;
}

/** Non-secret view of the token state, for /healthz. */
export function authStatus() {
  if (!current) {
    try {
      current = loadSeed();
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }
  const msLeft = current.expiresAt - Date.now();
  return {
    ok: true,
    source: current.source,
    // Without a refresh token the relay cannot keep itself alive, and the
    // setup page needs to say so plainly rather than let it lapse silently.
    canRenew: Boolean(current.refreshToken),
    expiresAt: new Date(current.expiresAt).toISOString(),
    minutesRemaining: Math.round(msLeft / 60000),
    willRefreshBefore: new Date(current.expiresAt - REFRESH_SKEW_MS).toISOString(),
    refreshCount,
    lastRefreshAt,
  };
}

/**
 * Ask Lovable who a token belongs to. Used to check a pasted token really
 * works before we keep it, so the setup page can say "this is your account"
 * instead of a hopeful "saved".
 */
export async function describeAccount(accessToken) {
  const res = await fetch(UPSTREAM, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-06-18',
      authorization: `Bearer ${accessToken}`,
      'user-agent': 'lovable-mcp-relay/1.0 (node)',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'get_me', arguments: {} },
    }),
  });

  const text = await res.text();
  if (res.status === 401) return { ok: false, error: 'Lovable rejected this token (401 Unauthorized).' };
  if (!res.ok) return { ok: false, error: `Lovable answered ${res.status}.` };

  // The reply is server-sent events wrapping a JSON-RPC result.
  const line = text.match(/^data: (.*)$/m);
  let payload = null;
  try {
    payload = JSON.parse(line ? line[1] : text);
  } catch {
    return { ok: false, error: 'Could not read the reply from Lovable.' };
  }
  if (payload?.error) return { ok: false, error: payload.error.message ?? 'Lovable returned an error.' };

  const body = payload?.result?.content?.map((c) => c.text).join('') ?? '';
  let me = null;
  try {
    me = JSON.parse(body);
  } catch {}
  if (!me?.email) return { ok: false, error: 'The token worked but the account details could not be read.' };

  return {
    ok: true,
    email: me.email,
    name: me.name ?? null,
    workspaces: (me.workspaces ?? []).map((w) => ({ name: w.name, role: w.role })),
  };
}

/**
 * Accept a token chain typed into the setup page.
 *
 * Nothing is kept unless it actually works: if the access token is missing or
 * stale but a refresh token came with it, we renew first, then confirm against
 * Lovable. On any failure the previously stored login is left untouched, so a
 * bad paste cannot take a working relay offline.
 */
export async function setToken({ accessToken, refreshToken, clientId, expiresAt }) {
  if (!accessToken && !refreshToken) {
    throw new AuthError('Paste an access token, or a saved chain containing one.');
  }

  const previous = current;
  let candidate = {
    accessToken: accessToken ?? null,
    refreshToken: refreshToken ?? null,
    clientId: clientId ?? DEFAULT_CLIENT_ID,
    // Unknown until we are told or we renew. Treat as already lapsed so the
    // first use renews rather than trusting a token of unknown age.
    expiresAt: expiresAt ?? 0,
    source: 'pasted',
  };

  try {
    let account = candidate.accessToken ? await describeAccount(candidate.accessToken) : { ok: false };

    if (!account.ok && candidate.refreshToken) {
      candidate = { ...(await refresh(candidate)), source: 'pasted (renewed)' };
      account = await describeAccount(candidate.accessToken);
    }

    if (!account.ok) {
      throw new AuthError(account.error ?? 'That token did not work.');
    }

    // An access token we were handed without an expiry: assume the standard
    // eight hours from now, and let the usual renewal logic take over.
    if (!candidate.expiresAt) candidate.expiresAt = Date.now() + 8 * 60 * 60 * 1000;

    current = candidate;
    persist(current);
    log.info(
      `token accepted for ${account.email}` +
        (candidate.refreshToken ? '; it can renew itself' : '; NO refresh token, so it will lapse and need replacing')
    );
    return { account, canRenew: Boolean(candidate.refreshToken), status: authStatus() };
  } catch (err) {
    current = previous; // a failed paste must not disturb a working setup
    throw err;
  }
}
