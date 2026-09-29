import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The real Lovable MCP server we forward to. */
export const UPSTREAM = process.env.LOVABLE_UPSTREAM ?? 'https://mcp.lovable.dev';

/** OAuth bits, discovered from https://lovable.dev/.well-known/oauth-authorization-server */
export const TOKEN_ENDPOINT = process.env.LOVABLE_TOKEN_ENDPOINT ?? 'https://lovable.dev/oauth/token';

/** RFC 8707 resource indicator: the API this token is for. */
export const RESOURCE = UPSTREAM;

/** Where Claude Code keeps the login it obtained for the lovable MCP server. */
export const CLAUDE_CREDENTIALS = path.join(os.homedir(), '.claude', '.credentials.json');

/**
 * Our own copy of the token. We need one because refresh tokens can rotate:
 * the moment we refresh, the copy inside Claude Code's file may stop working,
 * so we must remember the replacement ourselves or we lose the chain.
 */
export const TOKEN_CACHE = path.join(ROOT, '.token-cache.json');

export const PORT = Number(process.env.PORT ?? 8787);
export const HOST = process.env.HOST ?? '127.0.0.1';

/** Refresh this far ahead of expiry, so a request never races the clock. */
export const REFRESH_SKEW_MS = 2 * 60 * 1000;

/** Upstream request timeout. Generous: send_message can legitimately run for minutes. */
export const UPSTREAM_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS ?? 15 * 60 * 1000);

/** Set LOG_BODIES=1 to log request/response payloads. Off by default: they contain project data. */
export const LOG_BODIES = process.env.LOG_BODIES === '1';

/**
 * Tokens pasted into the setup page normally come from Claude Code, which
 * identifies itself with this client id. A pasted chain that carries its own
 * clientId always wins; this is only the fallback so that renewal still works
 * when someone pastes just the two token strings.
 */
export const DEFAULT_CLIENT_ID =
  process.env.LOVABLE_CLIENT_ID ?? 'https://claude.ai/oauth/claude-code-client-metadata';
