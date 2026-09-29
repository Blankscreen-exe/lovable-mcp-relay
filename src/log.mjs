const pad = (s, n) => String(s).padEnd(n);

function stamp() {
  return new Date().toISOString().slice(11, 23);
}

export const log = {
  info: (...a) => console.log(stamp(), 'INFO ', ...a),
  warn: (...a) => console.warn(stamp(), 'WARN ', ...a),
  error: (...a) => console.error(stamp(), 'ERROR', ...a),

  /** One line per proxied call, aligned so the log is scannable. */
  call({ method, rpc, status, ms, note }) {
    console.log(
      stamp(),
      'CALL ',
      pad(method, 6),
      pad(rpc ?? '-', 28),
      pad(status ?? '-', 4),
      pad(ms + 'ms', 8),
      note ?? ''
    );
  },
};

/**
 * Tokens must never reach the log. Anything that might hold one goes through here.
 */
export function redact(text) {
  if (typeof text !== 'string') return text;
  return text
    .replace(/(Bearer\s+)[A-Za-z0-9._\-]+/gi, '$1<redacted>')
    .replace(/("(?:access_token|refresh_token|accessToken|refreshToken)"\s*:\s*")[^"]+/g, '$1<redacted>');
}
