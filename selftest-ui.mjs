/**
 * Checks the setup page, its API, and the guards that stop another website
 * from using them.
 *
 *   npm run selftest:ui
 *
 * It starts its own relay on a spare port and writes only to a throwaway
 * config file in the system temp folder, so it never touches a real project.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.SELFTEST_PORT ?? 8831);
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  ok ? pass++ : fail++;
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  (' + detail + ')' : ''));
};

const child = spawn(process.execPath, [path.join(HERE, 'src', 'relay.mjs')], {
  cwd: HERE,
  env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const logs = [];
child.stdout.on('data', (d) => logs.push(d.toString()));
child.stderr.on('data', (d) => logs.push(d.toString()));

async function waitUp() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(BASE + '/ui');
      if (r.ok) return await r.text();
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('the relay did not start');
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-uitest-'));
const tmpConfig = path.join(tmpDir, '.mcp.json');
fs.writeFileSync(
  tmpConfig,
  JSON.stringify({ mcpServers: { lovable: { type: 'http', url: 'https://mcp.lovable.dev' } } }, null, 2)
);

try {
  console.log('\nlovable-mcp-relay: setup page test\n');
  const html = await waitUp();

  check('/ui serves the page', html.includes('Lovable MCP relay'));
  check('placeholders were filled in', !html.includes('{{NONCE}}') && !html.includes('{{RELAY_URL}}'));
  const nonce = html.match(/const NONCE = '([^']+)'/)?.[1];
  check('a setup secret was embedded', Boolean(nonce) && nonce.length > 20);

  const noNonce = await fetch(BASE + '/api/status');
  check('the API refuses a request with no secret', noNonce.status === 403, 'status ' + noNonce.status);

  const wrongNonce = await fetch(BASE + '/api/status', { headers: { 'x-relay-nonce': 'nope' } });
  check('the API refuses a wrong secret', wrongNonce.status === 403, 'status ' + wrongNonce.status);

  const crossOrigin = await fetch(BASE + '/api/status', {
    headers: { 'x-relay-nonce': nonce, origin: 'https://evil.example' },
  });
  check('the API refuses another website as origin', crossOrigin.status === 403, 'status ' + crossOrigin.status);

  const H = { 'x-relay-nonce': nonce };
  const HJ = { ...H, 'content-type': 'application/json' };

  const status = await (await fetch(BASE + '/api/status', { headers: H })).json();
  check('status reports a usable login', status.auth?.ok === true, status.auth?.source);
  check('status says whether it can renew itself', typeof status.auth?.canRenew === 'boolean');
  check('status names the account', Boolean(status.account?.email));
  check('status never includes a token', !/accessToken|refreshToken/.test(JSON.stringify(status)));

  const before = status.auth.expiresAt;
  const badPaste = await fetch(BASE + '/api/token', {
    method: 'POST',
    headers: HJ,
    body: JSON.stringify({ text: 'this is not a token' }),
  });
  check('a bad paste is rejected with a plain 400', badPaste.status === 400, (await badPaste.json()).error?.slice(0, 44));
  const afterBad = await (await fetch(BASE + '/api/status', { headers: H })).json();
  check('a bad paste leaves the working login alone', afterBad.auth?.expiresAt === before);

  const test = await (await fetch(BASE + '/api/test', { method: 'POST', headers: HJ, body: '{}' })).json();
  for (const step of test.steps) check('test: ' + step.name, step.ok, step.detail);
  check('the connection test passes as a whole', test.passed === true);

  const conns = await (await fetch(BASE + '/api/connections', { headers: H })).json();
  check('config discovery returns a list', Array.isArray(conns), conns.length + ' found');

  const prev = await (
    await fetch(BASE + '/api/connections/preview', { method: 'POST', headers: HJ, body: JSON.stringify({ path: tmpConfig }) })
  ).json();
  check(
    'preview shows the exact change without writing',
    prev.before === 'https://mcp.lovable.dev' && prev.after === BASE,
    (prev.before ?? '?') + ' -> ' + (prev.after ?? '?')
  );
  check(
    'preview really did not write',
    JSON.parse(fs.readFileSync(tmpConfig, 'utf8')).mcpServers.lovable.url === 'https://mcp.lovable.dev'
  );

  await fetch(BASE + '/api/connections/apply', { method: 'POST', headers: HJ, body: JSON.stringify({ path: tmpConfig }) });
  const applied = JSON.parse(fs.readFileSync(tmpConfig, 'utf8'));
  check('apply changes the url', applied.mcpServers.lovable.url === BASE);
  check('apply leaves the rest of the entry intact', applied.mcpServers.lovable.type === 'http');

  await fetch(BASE + '/api/connections/revert', { method: 'POST', headers: HJ, body: JSON.stringify({ path: tmpConfig }) });
  const reverted = JSON.parse(fs.readFileSync(tmpConfig, 'utf8'));
  check('revert restores the original url exactly', reverted.mcpServers.lovable.url === 'https://mcp.lovable.dev');

  const notAConfig = path.join(tmpDir, 'notes.txt');
  fs.writeFileSync(notAConfig, 'hello');
  const outside = await fetch(BASE + '/api/connections/apply', {
    method: 'POST',
    headers: HJ,
    body: JSON.stringify({ path: notAConfig }),
  });
  check('it refuses a file that is not an MCP config', outside.status === 400, 'status ' + outside.status);

  const missing = await fetch(BASE + '/api/connections/apply', {
    method: 'POST',
    headers: HJ,
    body: JSON.stringify({ path: path.join(tmpDir, 'nope', '.mcp.json') }),
  });
  check('it refuses to create a config that does not exist', missing.status === 400, 'status ' + missing.status);

  const mcp = await fetch(BASE + '/', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  const mcpText = await mcp.text();
  check('the MCP path still works alongside the page', mcp.status === 200 && mcpText.includes('tools'));

  console.log(`\n${pass} passed, ${fail} failed\n`);
} catch (err) {
  fail++;
  console.error('\ncrashed:', err.message, '\n\nrelay output:\n' + logs.join(''));
} finally {
  child.kill();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

process.exit(fail === 0 ? 0 : 1);
